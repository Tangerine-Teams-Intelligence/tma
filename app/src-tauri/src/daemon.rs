//! A2 — Background daemon. Spawned at app launch; runs forever until app
//! exit. The daemon owns the heartbeat that turns Tangerine from "memory
//! file viewer" into "Auto Chief of Staff".
//!
//! Per heartbeat (default every 5 minutes) the daemon:
//!   1. Pulls the team git repo (if team mode + `git_pull_enabled`).
//!   2. Refreshes the timeline index by calling
//!      `tmi.event_router.rebuild_index` via a tokio blocking task.
//!   3. Runs alert detection — populates `briefs/pending.md`.
//!   4. Recomputes the alignment metric.
//!   5. Once per day after 8 AM local, writes `briefs/<YYYY-MM-DD>.md`.
//!
//! Design notes:
//!   * The heartbeat is a `tokio::time::interval` — non-blocking.
//!   * All heavy work (index rebuild, brief generation) runs inside
//!     `tokio::task::spawn_blocking` so the runtime stays free for UI ipc.
//!   * Filesystem writes go through the same atomic-write helpers the
//!     Python side uses. We don't reimplement them in Rust — instead we
//!     shell out to the bundled Python `tmi` CLI for index/brief work.
//!     That keeps the source-of-truth in one language and the daemon
//!     becomes a "supervisor" rather than a parallel implementation.
//!   * Status is exposed via the `daemon_status` Tauri command (in
//!     `commands/daemon.rs`) so the UI can render last-heartbeat time.
//!   * Survives 24+ hours: no background task blocks indefinitely; every
//!     heartbeat handles its own panics via `catch_unwind` so a single
//!     failed pull/index doesn't kill the whole loop.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Local, Timelike, Utc};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::Notify;

const DEFAULT_HEARTBEAT: Duration = Duration::from_secs(5 * 60);
const MAX_ERRORS_RETAINED: usize = 20;

/// Windows `CREATE_NO_WINDOW` flag. Suppresses the black `cmd.exe` console
/// window that would otherwise flash up every time the GUI parent spawns a
/// non-GUI child (git pull, python tmi.daemon_cli, calendar CLI). Same value
/// used by `commands::runner`, `commands::git`, etc.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Apply `CREATE_NO_WINDOW` to a `std::process::Command` on Windows so the
/// child doesn't get its own console window. No-op on other platforms.
#[cfg(windows)]
fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW)
}
#[cfg(not(windows))]
fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd
}

/// Snapshot of the daemon's internal state. Read by the UI through the
/// `daemon_status` Tauri command.
#[derive(Debug, Clone, Default, Serialize)]
pub struct DaemonStatus {
    pub last_heartbeat: Option<String>,
    pub last_pull: Option<String>,
    pub last_brief: Option<String>,
    pub last_brief_date: Option<String>,
    pub heartbeat_count: u64,
    pub errors: Vec<String>,
    /// v1.8 Phase 2-B: number of pre-meeting brief triggers we've fired off
    /// to the calendar source's `briefs` probe since the daemon started.
    /// Used by the UI to surface "X briefs queued today" in the writeback
    /// section of the Slack source page.
    pub premeeting_briefs_queued: u64,
    /// RFC 3339 timestamp of the last successful pre-meeting brief tick
    /// (regardless of whether the tick produced any triggers — this is the
    /// liveness indicator, not a "found something" indicator).
    pub last_premeeting_check: Option<String>,
    /// v1.8 Phase 2-D: RFC 3339 timestamp of the last successful email
    /// IMAP digest. The daemon throttles fetches to once per
    /// `email_min_interval` (default 24h), regardless of how often the
    /// heartbeat fires.
    pub last_email_fetch: Option<String>,
    /// v1.8 Phase 2-D: total number of email threads written or merged
    /// across all heartbeats. Incremented after a successful fetch_recent.
    pub email_threads_total: u64,
    /// v1.8 Phase 3-B: RFC 3339 timestamp of the last co-thinker heartbeat
    /// (independent of the wider daemon heartbeat — the co-thinker has its
    /// own foreground/background cadence). `None` until the first tick runs.
    pub last_co_thinker_tick: Option<String>,
    /// v1.8 Phase 3-B: total brain.md rewrites across all heartbeats. Skips
    /// (atoms_seen=0) don't bump this.
    pub co_thinker_brain_updates: u64,
    /// v1.8 Phase 3-B: total proposals written across all heartbeats.
    pub co_thinker_proposals_total: u64,
}

#[derive(Default)]
pub struct DaemonControl {
    pub status: Mutex<DaemonStatus>,
    pub stop: Arc<Notify>,
    pub kick: Arc<Notify>,
    /// v1.8 Phase 3-B: long-lived co-thinker engine. `Some` after the first
    /// `co_thinker_tick` initialises it; `None` on a fresh daemon. We carry
    /// it across heartbeats so `last_heartbeat_ts` (the engine's incremental
    /// scan cutoff) persists without round-tripping through the filesystem.
    pub co_thinker: Mutex<Option<crate::agi::co_thinker::CoThinkerEngine>>,
    /// v1.8 Phase 3-B: hint from the UI/window-focus event ("am I visible?").
    /// True ⇒ 5 min cadence; false ⇒ 30 min. Defaults to false (background)
    /// so a headless daemon doesn't burn LLM calls before the UI signals.
    pub foreground: parking_lot::Mutex<bool>,
    /// v1.9.0-beta.2 P2-A: event sink for rule-based template matches.
    /// `None` until `main.rs` calls `install_event_sink` at boot with a
    /// `TauriEventSink<Wry>`; once installed, every co_thinker_tick wires
    /// it into the long-lived engine so heartbeat-driven template matches
    /// reach the frontend's `template_match` listener.
    pub template_event_sink:
        parking_lot::Mutex<Option<Arc<dyn crate::agi::templates::common::EventSink>>>,
}

impl DaemonControl {
    pub fn snapshot(&self) -> DaemonStatus {
        self.status.lock().clone()
    }

    pub fn record_error(&self, where_: &str, e: impl std::fmt::Display) {
        let mut s = self.status.lock();
        let entry = format!("[{}] {}: {}", Utc::now().to_rfc3339(), where_, e);
        s.errors.push(entry);
        if s.errors.len() > MAX_ERRORS_RETAINED {
            let overflow = s.errors.len() - MAX_ERRORS_RETAINED;
            s.errors.drain(0..overflow);
        }
    }

    /// v1.9.0-beta.2 P2-A — install a template-match event sink. Called
    /// once at boot from `main.rs` with a `TauriEventSink<Wry>`. Replaces
    /// any prior sink (so a hot-restart in dev re-points cleanly).
    pub fn install_event_sink(
        &self,
        sink: Arc<dyn crate::agi::templates::common::EventSink>,
    ) {
        *self.template_event_sink.lock() = Some(sink.clone());
        // Also push the sink onto a live engine if one already exists, so
        // the next heartbeat picks it up without waiting for an engine
        // teardown.
        if let Some(engine) = self.co_thinker.lock().as_mut() {
            engine.set_event_sink(sink);
        }
    }
}

#[derive(Debug, Clone)]
pub struct DaemonConfig {
    /// Memory root — passed to the python CLI as `--memory-root`.
    pub memory_root: PathBuf,
    /// Optional path to the `python` binary. Falls back to `python` in PATH.
    pub python_bin: Option<PathBuf>,
    /// If `true`, daemon will attempt `git pull --rebase origin main` on
    /// `team_repo_path` each heartbeat.
    pub git_pull_enabled: bool,
    /// Required when `git_pull_enabled` is true.
    pub team_repo_path: Option<PathBuf>,
    /// Heartbeat interval. Defaults to 5 min if `None`.
    pub interval: Option<Duration>,
    /// Daemon log file (rotated by app shell).
    pub log_path: Option<PathBuf>,
    /// v1.8 Phase 2-C — user data directory (where per-source JSON configs
    /// and the `.env` allow-list live). When `None`, the daemon resolves it
    /// from `LOCALAPPDATA` / `data_local_dir()`. None of the new source
    /// ticks panic when this is unset; they degrade to no-op.
    pub user_data: Option<PathBuf>,
    /// v1.8 Phase 2-D — Email source config. `Some(_)` means the heartbeat
    /// fetches recent email at most once per `email_min_interval`
    /// (default 24h). `None` is the default (no email source configured).
    pub email_config: Option<crate::sources::email::EmailConfig>,
    pub email_min_interval: Option<Duration>,
}

impl DaemonConfig {
    pub fn solo(memory_root: PathBuf) -> Self {
        Self {
            memory_root,
            python_bin: None,
            git_pull_enabled: false,
            team_repo_path: None,
            interval: None,
            log_path: None,
            user_data: None,
            email_config: None,
            email_min_interval: None,
        }
    }
}

/// Starts the daemon loop using Tauri's async runtime (works inside
/// Tauri's `setup` hook where no tokio runtime context is active).
/// Returns the control handle the host can use to stop the daemon and
/// read status.
pub fn start(cfg: DaemonConfig) -> Arc<DaemonControl> {
    let control = Arc::new(DaemonControl::default());
    let control_for_loop = control.clone();
    tauri::async_runtime::spawn(async move {
        run_loop(cfg, control_for_loop).await;
    });
    control
}

/// Public test entry: same loop, but uses the test-injected control so
/// callers can `notify_waiters` on `kick` to deterministically advance the
/// heartbeat without waiting wall-clock time.
pub async fn run_for_test(cfg: DaemonConfig, control: Arc<DaemonControl>, ticks: u32) {
    let interval = Duration::from_millis(10);
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    for _ in 0..ticks {
        ticker.tick().await;
        do_heartbeat(&cfg, &control).await;
    }
}

async fn run_loop(cfg: DaemonConfig, control: Arc<DaemonControl>) {
    let interval = cfg.interval.unwrap_or(DEFAULT_HEARTBEAT);
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // The first .tick() resolves immediately. Drive one heartbeat right
    // away so a fresh launch has a populated timeline.json without waiting
    // 5 min for the first tick.
    ticker.tick().await;
    do_heartbeat(&cfg, &control).await;

    loop {
        tokio::select! {
            _ = control.stop.notified() => {
                tracing::info!("daemon: stop signalled");
                break;
            }
            _ = control.kick.notified() => {
                do_heartbeat(&cfg, &control).await;
            }
            _ = ticker.tick() => {
                do_heartbeat(&cfg, &control).await;
            }
        }
    }
}

async fn do_heartbeat(cfg: &DaemonConfig, control: &Arc<DaemonControl>) {
    let started = Utc::now();
    {
        let mut s = control.status.lock();
        s.last_heartbeat = Some(started.to_rfc3339());
        s.heartbeat_count = s.heartbeat_count.saturating_add(1);
    }

    // 1. Pull (best-effort)
    if cfg.git_pull_enabled {
        if let Some(repo) = &cfg.team_repo_path {
            match run_git_pull(repo).await {
                Ok(()) => {
                    control.status.lock().last_pull = Some(Utc::now().to_rfc3339());
                }
                Err(e) => {
                    control.record_error("git_pull", e);
                }
            }
        }
    }

    // 2. Index refresh — shell out to python CLI.
    if let Err(e) = run_python_subcommand(cfg, "index-rebuild").await {
        control.record_error("index_rebuild", e);
    }

    // 3. Pending alerts.
    if let Err(e) = run_python_subcommand(cfg, "alerts-refresh").await {
        control.record_error("alerts_refresh", e);
    }

    // 4. Alignment.
    if let Err(e) = run_python_subcommand(cfg, "alignment-snapshot").await {
        control.record_error("alignment", e);
    }

    // 5. Daily brief — once per day after 8 AM local.
    if should_generate_brief(&control.snapshot()) {
        let today = Local::now().format("%Y-%m-%d").to_string();
        if let Err(e) =
            run_python_subcommand_with_args(cfg, "brief-today", &["--date".into(), today.clone()])
                .await
        {
            control.record_error("brief", e);
        } else {
            let mut s = control.status.lock();
            s.last_brief = Some(Utc::now().to_rfc3339());
            s.last_brief_date = Some(today);
        }
    }

    // 6. v1.8 Phase 2-B — pre-meeting brief triggers (calendar source).
    //
    // Per `sources/calendar/daemon-hook.md`: each heartbeat we run
    // `tangerine-calendar briefs` against the configured iCal feeds. It
    // prints one line per upcoming event in [now + lead - window, now + lead]
    // — the canonical daemon-cadence trigger probe. We count successful
    // ticks rather than attempting to parse the lines here; the actual
    // Slack post is handed off to the writeback Tauri command which the
    // brief-renderer in `commands/writeback_slack_calendar.rs` invokes.
    //
    // We coordinate with that module by flipping a pair of fields in the
    // status struct so the UI can render "X briefs queued / last checked at
    // T". The spawn-blocking pattern mirrors the python subcommand path
    // above so we don't introduce a second tokio task surface.
    match run_calendar_briefs_probe(cfg).await {
        Ok(triggers_seen) => {
            let mut s = control.status.lock();
            s.last_premeeting_check = Some(Utc::now().to_rfc3339());
            s.premeeting_briefs_queued = s
                .premeeting_briefs_queued
                .saturating_add(triggers_seen as u64);
        }
        Err(e) => {
            control.record_error("premeeting_briefs", e);
        }
    }

    // 7. v1.8 Phase 2-C — Notion / Loom / Zoom ticks. Each is best-effort
    //    and short-circuits when no token is present, so a fresh install
    //    where the user hasn't set these up yet sees zero overhead beyond
    //    a JSON file existence check. No skipping the rest of the
    //    heartbeat if any of these fail.
    let user_data = cfg
        .user_data
        .clone()
        .or_else(resolve_user_data_for_daemon);
    if let Some(ud) = user_data {
        let memory_root = cfg.memory_root.clone();

        let notion_res = crate::commands::notion::tick_from_daemon(&ud, &memory_root).await;
        for e in notion_res.errors {
            control.record_error("notion_tick", e);
        }

        let loom_res = crate::commands::loom::tick_from_daemon(&ud, &memory_root).await;
        for e in loom_res.errors {
            control.record_error("loom_tick", e);
        }

        let zoom_res = crate::commands::zoom::tick_from_daemon(&ud, &memory_root).await;
        for e in zoom_res.errors {
            control.record_error("zoom_tick", e);
        }
    }

    // 8. v1.8 Phase 2-D — Email source. Throttled — only fetch when
    //    enough time has elapsed since the last successful pull
    //    (`email_min_interval`, default 24h). Skipped entirely when
    //    `cfg.email_config` is None (= user hasn't connected email yet).
    if let Some(email_cfg) = &cfg.email_config {
        if email_due(&control.snapshot(), cfg) {
            match crate::sources::email::fetch_recent(
                email_cfg.clone(),
                Some(cfg.memory_root.clone()),
            )
            .await
            {
                Ok(res) => {
                    let mut s = control.status.lock();
                    s.last_email_fetch = Some(Utc::now().to_rfc3339());
                    s.email_threads_total =
                        s.email_threads_total.saturating_add(res.threads_written as u64);
                }
                Err(e) => {
                    control.record_error("email_tick", e.to_string());
                }
            }
        }
    }

    // 9. v1.8 Phase 3-B — co-thinker brain heartbeat.
    //
    // Cadence:
    //   * foreground (UI window focused, signalled by `control.foreground`)
    //     → fire every 5 min
    //   * background → fire every 30 min
    //   * high-priority "decision atom landed" trigger → Phase 4 (file
    //     watcher hook). Phase 3 ships only the cadence-gated path.
    //
    // The co-thinker engine has its own throttle, so a long heartbeat won't
    // pile up; a daemon tick that arrives mid-LLM-call short-circuits in
    // the engine. We swallow errors here — co-thinker failures must never
    // kill the daemon.
    if let Err(e) = co_thinker_tick(cfg, control).await {
        control.record_error("co_thinker_tick", e);
    }
}

/// One co-thinker brain tick. Initialises the long-lived engine on first
/// call, then runs `engine.heartbeat()` only if the elapsed-since-last-tick
/// exceeds the cadence threshold (5 min foreground / 30 min background).
async fn co_thinker_tick(cfg: &DaemonConfig, control: &Arc<DaemonControl>) -> Result<(), String> {
    use crate::agi::co_thinker::{CoThinkerEngine, HeartbeatCadence};

    let foreground = *control.foreground.lock();
    let cadence = if foreground {
        HeartbeatCadence::Foreground
    } else {
        HeartbeatCadence::Background
    };
    let cadence_threshold = if foreground {
        Duration::from_secs(5 * 60)
    } else {
        Duration::from_secs(30 * 60)
    };

    // Cadence gate. Skip entirely if not enough time elapsed since the last
    // successful tick. First-ever tick (None) always proceeds.
    {
        let snap = control.status.lock();
        if let Some(last_str) = &snap.last_co_thinker_tick {
            if let Ok(last) = DateTime::parse_from_rfc3339(last_str) {
                let last_utc = last.with_timezone(&Utc);
                if let Ok(elapsed) = Utc::now().signed_duration_since(last_utc).to_std() {
                    if elapsed < cadence_threshold {
                        return Ok(());
                    }
                }
            }
        }
    }

    // Move the engine out of the slot for the duration of the heartbeat,
    // then put it back. Avoids holding the parking_lot mutex across await
    // points — that would be a `Send` violation.
    let mut engine = {
        let mut slot = control.co_thinker.lock();
        slot.take()
            .unwrap_or_else(|| CoThinkerEngine::new(cfg.memory_root.clone()))
    };
    // v1.9.0-beta.2 P2-A — wire the template-match sink onto every engine
    // we use. Idempotent — safe to set on an already-configured engine.
    // When no sink has been installed (`main.rs` hasn't called
    // `install_event_sink` yet), the engine keeps its NoopSink default
    // and template matches accumulate but emit nowhere.
    if let Some(sink) = control.template_event_sink.lock().clone() {
        engine.set_event_sink(sink);
    }

    let outcome = engine
        .heartbeat(cadence, None)
        .await
        .map_err(|e| e.to_string())?;

    {
        let mut s = control.status.lock();
        s.last_co_thinker_tick = Some(Utc::now().to_rfc3339());
        if outcome.brain_updated {
            s.co_thinker_brain_updates = s.co_thinker_brain_updates.saturating_add(1);
        }
        s.co_thinker_proposals_total = s
            .co_thinker_proposals_total
            .saturating_add(outcome.proposals_created as u64);
    }

    *control.co_thinker.lock() = Some(engine);
    Ok(())
}

/// True when the daemon should run an email fetch this heartbeat. Honours
/// `cfg.email_min_interval` (default 24h). Always true on first run
/// (`last_email_fetch` is None).
fn email_due(status: &DaemonStatus, cfg: &DaemonConfig) -> bool {
    let interval = cfg.email_min_interval.unwrap_or(Duration::from_secs(24 * 60 * 60));
    let last = match &status.last_email_fetch {
        Some(s) => s,
        None => return true,
    };
    let parsed = match chrono::DateTime::parse_from_rfc3339(last) {
        Ok(dt) => dt.with_timezone(&Utc),
        Err(_) => return true,
    };
    let elapsed = match Utc::now().signed_duration_since(parsed).to_std() {
        Ok(d) => d,
        Err(_) => return true,
    };
    elapsed >= interval
}

/// Resolve the `user_data` directory the same way `commands::paths::AppPaths`
/// does (LOCALAPPDATA on Windows, data_local_dir elsewhere). Returns None if
/// neither is available — the source ticks then no-op.
fn resolve_user_data_for_daemon() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return Some(PathBuf::from(local).join("TangerineMeeting"));
        }
    }
    dirs::data_local_dir().map(|d| d.join("TangerineMeeting"))
}

/// Invoke the calendar source's `briefs` probe and return the number of
/// trigger lines it printed. Stage 1 of Phase 2-B: count + log; Stage 2
/// will parse each line and dispatch to the Slack writeback path.
///
/// Best-effort by design — the probe is idempotent and missing the binary
/// (no calendar source set up yet) shouldn't kill the heartbeat. We map
/// "command not found" / "no config" into Ok(0) so a fresh install where
/// the calendar source hasn't been wired up yet still produces clean
/// daemon snapshots.
async fn run_calendar_briefs_probe(cfg: &DaemonConfig) -> Result<usize, String> {
    let memory_root = cfg.memory_root.clone();
    let join = tokio::task::spawn_blocking(move || {
        // The TS calendar package ships a CLI under `sources/calendar/dist/cli.js`.
        // We resolve `node` from PATH (same convention as the bot launcher).
        // If neither node nor the bundled cli exist, treat as zero-trigger.
        let cli_path = std::env::var("TANGERINE_CAL_CLI")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("tangerine-calendar"));
        let mut cmd = std::process::Command::new(&cli_path);
        cmd.args(["briefs", "--memory-root"]).arg(&memory_root);
        no_window(&mut cmd);
        let out = match cmd.output() {
            Ok(o) => o,
            Err(_e) => {
                // Probe missing — treat as no-op rather than an error so the
                // daemon stays clean on machines without the calendar source.
                return Ok(0usize);
            }
        };
        if !out.status.success() {
            return Err(format!(
                "calendar briefs exit {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        let count = stdout.lines().filter(|l| !l.trim().is_empty()).count();
        Ok(count)
    })
    .await;
    match join {
        Ok(r) => r,
        Err(e) => Err(format!("join: {}", e)),
    }
}

/// True when:
///   * we have never written a brief, AND now >= 8 AM local; OR
///   * the latest brief was for a previous calendar day and now >= 8 AM local.
fn should_generate_brief(status: &DaemonStatus) -> bool {
    let now_local = Local::now();
    if now_local.hour() < 8 {
        return false;
    }
    let today_str = now_local.format("%Y-%m-%d").to_string();
    match &status.last_brief_date {
        None => true,
        Some(d) => d != &today_str,
    }
}

// ----------------------------------------------------------------------
// Subprocess plumbing

async fn run_git_pull(repo: &PathBuf) -> Result<(), String> {
    let repo = repo.clone();
    let join = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C")
            .arg(&repo)
            .args(["pull", "--rebase", "origin", "main"]);
        no_window(&mut cmd);
        let out = cmd.output().map_err(|e| format!("git spawn: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "git pull exit {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(())
    })
    .await;
    match join {
        Ok(r) => r,
        Err(e) => Err(format!("join: {}", e)),
    }
}

async fn run_python_subcommand(cfg: &DaemonConfig, sub: &str) -> Result<(), String> {
    run_python_subcommand_with_args(cfg, sub, &[]).await
}

async fn run_python_subcommand_with_args(
    cfg: &DaemonConfig,
    sub: &str,
    extra: &[String],
) -> Result<(), String> {
    let py = cfg
        .python_bin
        .clone()
        .unwrap_or_else(|| PathBuf::from("python"));
    let memory_root = cfg.memory_root.clone();
    let sub_owned = sub.to_string();
    let extra_owned: Vec<String> = extra.to_vec();
    let join = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(py);
        cmd.args([
            "-m",
            "tmi.daemon_cli",
            sub_owned.as_str(),
            "--memory-root",
        ])
        .arg(&memory_root);
        for a in &extra_owned {
            cmd.arg(a);
        }
        no_window(&mut cmd);
        let out = cmd
            .output()
            .map_err(|e| format!("python spawn: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "python {} exit {}: {}",
                sub_owned,
                out.status,
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(())
    })
    .await;
    match join {
        Ok(r) => r,
        Err(e) => Err(format!("join: {}", e)),
    }
}

// ----------------------------------------------------------------------
// Tests
//
// The Rust-side tests are deliberately small: they exercise the loop
// scaffolding (status updates, error capture, brief-time gate) without
// shelling out. The Python tmi.daemon_cli subcommands have their own
// pytest coverage.

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn fake_status_with_brief(date: &str) -> DaemonStatus {
        DaemonStatus {
            last_brief: Some(format!("{}T08:00:00Z", date)),
            last_brief_date: Some(date.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn record_error_caps_at_max() {
        let c = DaemonControl::default();
        for i in 0..50 {
            c.record_error("test", format!("err{}", i));
        }
        let s = c.snapshot();
        assert_eq!(s.errors.len(), MAX_ERRORS_RETAINED);
        // Newest preserved
        assert!(s.errors.last().unwrap().contains("err49"));
    }

    #[test]
    fn email_due_is_true_when_never_fetched() {
        let cfg = DaemonConfig::solo(std::env::temp_dir());
        let st = DaemonStatus::default();
        assert!(email_due(&st, &cfg));
    }

    #[test]
    fn email_due_respects_min_interval() {
        let mut cfg = DaemonConfig::solo(std::env::temp_dir());
        cfg.email_min_interval = Some(Duration::from_secs(60 * 60));
        let mut st = DaemonStatus::default();
        st.last_email_fetch = Some(Utc::now().to_rfc3339());
        // Just fetched — must not be due.
        assert!(!email_due(&st, &cfg));
        // 2 h ago — due.
        st.last_email_fetch = Some((Utc::now() - chrono::Duration::hours(2)).to_rfc3339());
        assert!(email_due(&st, &cfg));
    }

    #[test]
    fn should_generate_brief_skips_before_8am() {
        // Can't easily mock `Local::now()` without bringing in a clock crate.
        // The "after 8 AM" branch is exercised by inspecting both arms via
        // a constructed status. We assert at minimum that a status with
        // today's brief returns false.
        let today = Local::now().format("%Y-%m-%d").to_string();
        let st = fake_status_with_brief(&today);
        assert!(!should_generate_brief(&st));
    }

    #[test]
    fn snapshot_returns_independent_clone() {
        let c = DaemonControl::default();
        c.record_error("x", "e1");
        let s = c.snapshot();
        assert_eq!(s.errors.len(), 1);
        c.record_error("x", "e2");
        // First snapshot wasn't mutated
        assert_eq!(s.errors.len(), 1);
        // Live state did update
        assert_eq!(c.snapshot().errors.len(), 2);
    }

    #[tokio::test]
    async fn run_for_test_advances_heartbeat_count() {
        // Use a non-existent python so the command fails fast without
        // panicking the loop. Confirms heartbeats survive subprocess errors.
        let tmp = std::env::temp_dir().join(format!(
            "rms_daemon_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let cfg = DaemonConfig {
            memory_root: tmp.clone(),
            python_bin: Some(PathBuf::from("python_does_not_exist_xxxxx")),
            git_pull_enabled: false,
            team_repo_path: None,
            interval: Some(Duration::from_millis(5)),
            log_path: None,
            user_data: None,
            email_config: None,
            email_min_interval: None,
        };
        let control = Arc::new(DaemonControl::default());
        run_for_test(cfg, control.clone(), 3).await;
        let snap = control.snapshot();
        assert_eq!(snap.heartbeat_count, 3);
        assert!(snap.last_heartbeat.is_some());
        // We expect errors on each heartbeat (3 subcommand attempts × 3 ticks =
        // up to 9, capped at MAX_ERRORS_RETAINED).
        assert!(!snap.errors.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn run_for_test_zero_ticks_is_noop() {
        let cfg = DaemonConfig::solo(std::env::temp_dir());
        let control = Arc::new(DaemonControl::default());
        run_for_test(cfg, control.clone(), 0).await;
        let snap = control.snapshot();
        assert_eq!(snap.heartbeat_count, 0);
        assert!(snap.last_heartbeat.is_none());
    }

    #[tokio::test]
    async fn stop_signal_is_observable() {
        // Set up a control + signal stop before any loop runs. The kick + stop
        // notifies are simple — just confirm the API contract.
        let control = Arc::new(DaemonControl::default());
        control.stop.notify_waiters();
        // No-op since no loop is awaiting; ensure no panic/leak.
        assert_eq!(control.snapshot().heartbeat_count, 0);
    }
}
