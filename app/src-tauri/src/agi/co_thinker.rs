//! v1.8 Phase 3-B — Co-thinker brain engine.
//!
//! The co-thinker is Tangerine's persistent stateful AGI brain. It runs as a
//! daemon-driven heartbeat (see `daemon::do_heartbeat`'s `co_thinker_tick` at
//! the bottom of every tick): every 5 minutes when the app is in foreground,
//! every 30 minutes when backgrounded.
//!
//! Each tick we:
//!   1. Scan the memory tree for atoms whose mtime is >= the last heartbeat
//!      (incremental — we don't re-feed the whole memory dir every tick).
//!   2. Read the current `agi/co-thinker.md` brain doc as self-context.
//!   3. Dispatch one LLM call through the `LlmDispatcher` (P3-A's
//!      `session_borrower::dispatch` is the production impl; tests inject a
//!      `MockDispatcher`).
//!   4. Apply the **grounding rule** — every claim in the response must be
//!      followed by a `path/to/atom.md` citation; uncited paragraphs are
//!      silently dropped before we write the brain doc. The brain.md must be
//!      100% citation-grounded so the user can audit any claim back to a
//!      source file.
//!   5. Atomically replace `agi/co-thinker.md`.
//!   6. Append a single line to `agi/observations/{YYYY-MM-DD}.md` (audit log).
//!   7. Detect `PROPOSAL:` sentinels in the response → write
//!      `agi/proposals/{type}-{slug}-{date}.md`.
//!
//! Markdown is the source of truth. Every artefact this engine touches is a
//! plain `.md` file the user can `cat`, edit, or git-blame. The brain isn't a
//! black-box LLM context — it's a doc you can read.
//!
//! Throttle: a `tokio::sync::Mutex` (the heartbeat semaphore) ensures only one
//! heartbeat runs at a time. A second concurrent call short-circuits with
//! `error: Some("throttled — another heartbeat is in flight")`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, Utc};
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};

use crate::commands::AppError;

use super::canvas_writer;
use super::observations;
// v1.9.0-beta.2 P2-A — rule-based suggestion templates run at the bottom of
// every heartbeat. The engine holds an `EventSink` (default = NoopSink) so
// daemon-driven heartbeats stay silent until a Tauri AppHandle is plumbed
// in (manual-trigger path + final v1.9 wiring). The dispatch lives in
// `templates::registry::evaluate_and_emit` so adding a new template never
// touches this file — see the marker block in `heartbeat`.
use super::templates::common::{EventSink, NoopSink, TemplateContext};
use super::templates::registry as templates_registry;

// ---------------------------------------------------------------------------
// LlmDispatcher trait — abstracts P3-A's `session_borrower::dispatch`.
//
// In production, an adapter for `crate::agi::session_borrower::dispatch` is
// plugged in; in tests we plug in `MockDispatcher`. We keep the engine
// independent of P3-A's file layout so neither agent has to wait for the
// other to land before unit tests can run.

/// One-shot LLM request envelope. The system prompt is fixed; user prompt is
/// the rendered brain-update prompt (current brain.md + new atom summary).
#[derive(Debug, Clone)]
pub struct LlmRequest {
    pub system: String,
    pub user: String,
    /// Optional pin to a specific tool id (cursor / claude-code / ollama / ...);
    /// when None, the dispatcher picks per its own policy.
    pub primary_tool_id: Option<String>,
}

/// LLM response. `channel_used` reports which tool actually answered (mcp /
/// browser_ext / local_http / mock) so the heartbeat outcome can surface it
/// to the UI.
#[derive(Debug, Clone)]
pub struct LlmResponse {
    pub text: String,
    pub channel_used: String,
}

/// The trait the engine consumes. P3-A's `session_borrower::dispatch` is
/// adapted onto this trait by the production impl below. We use `BoxFuture`
/// instead of an `async fn` so the trait is dyn-compatible (Rust's native
/// async-fn-in-trait is not yet `dyn`-compatible without the `async_trait`
/// macro, and the crate isn't in our dep tree).
pub trait LlmDispatcher: Send + Sync {
    fn dispatch<'a>(
        &'a self,
        req: LlmRequest,
    ) -> BoxFuture<'a, Result<LlmResponse, AppError>>;
}

/// Default production dispatcher. Routes through P3-A's
/// `session_borrower::dispatch` (sibling module).
///
/// **Merge-watch point — INTEGRATION POINT:** the call into
/// `crate::agi::session_borrower::dispatch` happens inside
/// `dispatch_via_session_borrower`. P3-A owns the upstream API; if the
/// upstream signature changes, this function is the one place to update.
pub struct ProductionDispatcher;

impl LlmDispatcher for ProductionDispatcher {
    fn dispatch<'a>(
        &'a self,
        req: LlmRequest,
    ) -> BoxFuture<'a, Result<LlmResponse, AppError>> {
        Box::pin(dispatch_via_session_borrower(req))
    }
}

async fn dispatch_via_session_borrower(req: LlmRequest) -> Result<LlmResponse, AppError> {
    // INTEGRATION POINT — wired to P3-A's session_borrower. Their LlmRequest
    // shape uses snake-case `system_prompt` / `user_prompt` and an explicit
    // `primary_tool_id` second arg. We adapt back to our internal struct on
    // the way out.
    use crate::agi::session_borrower as sb;
    let upstream_req = sb::LlmRequest {
        system_prompt: req.system,
        user_prompt: req.user,
        max_tokens: None,
        temperature: None,
    };
    match sb::dispatch(upstream_req, req.primary_tool_id).await {
        Ok(resp) => Ok(LlmResponse {
            text: resp.text,
            channel_used: resp.channel_used,
        }),
        Err(e) => Err(AppError::external("session_borrower", e.to_string())),
    }
}

// ---------------------------------------------------------------------------
// Engine

/// Cadence of a single heartbeat. Foreground = 5 min, Background = 30 min,
/// Manual = user pressed the "Trigger heartbeat now" button in /co-thinker.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HeartbeatCadence {
    Foreground,
    Background,
    Manual,
}

impl HeartbeatCadence {
    /// Display string used in the brain.md "Last heartbeat" line.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Foreground => "5min foreground",
            Self::Background => "30min background",
            Self::Manual => "manual",
        }
    }
}

/// Wave 3 cross-cut — outcome of `recover_from_corrupt`.
/// Returned so the caller (Tauri command / daemon hook) can surface a
/// toast and log structured fields.
#[derive(Debug, Clone, Serialize)]
pub struct RecoveryOutcome {
    /// Path of the quarantined brain copy. `None` when nothing needed
    /// recovery (healthy brain or absent file).
    pub quarantined: Option<PathBuf>,
    /// Whether `co-thinker.md` was regenerated from the seed template.
    pub regenerated: bool,
    /// Plain-English reason — surfaces in support logs.
    pub reason: String,
}

/// Wave 3 cross-cut — corruption sniff for the brain doc.
///
/// Three "obviously corrupt" markers we treat as recoverable:
///   * Empty file (or whitespace-only).
///   * Mid-file `<<<<<<<` / `>>>>>>>` git conflict markers.
///   * No `# ` heading at all (every healthy seed starts with one).
///
/// We deliberately don't try to parse the full markdown — false negatives
/// here are fine (the heartbeat will keep using the file) but a false
/// positive throws away the user's brain. So the test is intentionally
/// conservative.
pub fn is_brain_corrupt(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return true;
    }
    if trimmed.contains("<<<<<<<") || trimmed.contains(">>>>>>>") {
        return true;
    }
    // No top-level heading anywhere → almost certainly truncated.
    if !raw.lines().any(|l| l.trim_start().starts_with("# ")) {
        return true;
    }
    false
}

/// Outcome of one heartbeat. Returned by `heartbeat()` and the
/// `co_thinker_trigger_heartbeat` Tauri command.
#[derive(Debug, Clone, Serialize)]
pub struct HeartbeatOutcome {
    /// Number of atoms changed since the last heartbeat (mtime >= last).
    pub atoms_seen: u32,
    /// True if `co-thinker.md` was rewritten this tick.
    pub brain_updated: bool,
    /// Number of `proposals/*.md` files created this tick.
    pub proposals_created: u32,
    /// Tool channel that answered the LLM call ("mcp" / "browser_ext" /
    /// "local_http" / "mock" / "none").
    pub channel_used: String,
    /// Wall-clock latency from heartbeat entry to brain.md write.
    pub latency_ms: u64,
    /// Soft error message when something failed but the daemon survived.
    /// `None` = clean tick.
    pub error: Option<String>,
    /// v1.9.0-beta.2 — number of rule-based template matches emitted this
    /// tick via `EventSink::emit_template_match`. Populated even when the
    /// LLM dispatch is skipped (skip path) so deadline / conflict / pattern
    /// detection still fires on otherwise-quiet heartbeats. Default 0 keeps
    /// older Serialize callers happy.
    #[serde(default)]
    pub template_matches_emitted: u32,
}

/// The engine. Owns the memory root + tracks last-heartbeat-ts for
/// incremental scans. The dispatcher is injected so tests can swap in a mock.
pub struct CoThinkerEngine {
    pub memory_root: PathBuf,
    pub last_heartbeat_ts: Option<DateTime<Utc>>,
    /// `Arc<dyn LlmDispatcher>` so the engine can be cheaply cloned across
    /// the daemon + Tauri command surfaces without leaking lifetimes.
    pub dispatcher: Arc<dyn LlmDispatcher>,
    /// v1.9.0-beta.2 — destination for rule-based template matches. Default
    /// is `NoopSink`; the daemon (or a Tauri command surface holding an
    /// `AppHandle`) calls `set_event_sink` to install a real Tauri-backed
    /// sink that forwards to the frontend's `template_match` listener.
    pub event_sink: Arc<dyn EventSink>,
    /// Throttle: heartbeat takes this lock; a second concurrent call gets
    /// `try_lock` → None → short-circuits with "throttled".
    throttle: Arc<tokio::sync::Mutex<()>>,
}

impl CoThinkerEngine {
    /// New engine wired to the production session-borrower dispatcher.
    pub fn new(memory_root: PathBuf) -> Self {
        Self {
            memory_root,
            last_heartbeat_ts: None,
            dispatcher: Arc::new(ProductionDispatcher),
            event_sink: Arc::new(NoopSink),
            throttle: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// Test/integration constructor — inject a custom dispatcher.
    pub fn with_dispatcher(memory_root: PathBuf, dispatcher: Arc<dyn LlmDispatcher>) -> Self {
        Self {
            memory_root,
            last_heartbeat_ts: None,
            dispatcher,
            event_sink: Arc::new(NoopSink),
            throttle: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// v1.9.0-beta.2 — install a custom event sink. Used by the manual-
    /// trigger Tauri command (which has an `AppHandle`) and tests that need
    /// to assert on emitted matches. Returns `&mut Self` for chaining.
    pub fn set_event_sink(&mut self, sink: Arc<dyn EventSink>) -> &mut Self {
        self.event_sink = sink;
        self
    }

    /// Path to the brain doc.
    ///
    /// === wave 6 === BUG #1 — moved from `agi/co-thinker.md` to
    /// `team/co-thinker.md` so the on-disk path matches what the README,
    /// dogfood checklist, and welcome overlay all describe ("team brain").
    /// `read_brain_doc` lazy-migrates from the legacy `agi/` location on
    /// first read so existing dogfood installs upgrade cleanly.
    pub fn brain_doc_path(&self) -> PathBuf {
        self.memory_root.join("team").join("co-thinker.md")
    }

    /// === wave 6 === BUG #1 — legacy v1.9.2-and-earlier brain doc location.
    /// Kept so `read_brain_doc` can lazy-migrate from the old path without
    /// the user losing brain content on upgrade.
    fn legacy_brain_doc_path(&self) -> PathBuf {
        self.memory_root.join("agi").join("co-thinker.md")
    }

    /// Read the brain doc. Returns the seed when the file doesn't exist —
    /// the user-facing /co-thinker route always has something to render.
    ///
    /// === wave 6 === BUG #1 — lazy migration from `agi/co-thinker.md` to
    /// `team/co-thinker.md`. If the new path is missing but the legacy path
    /// exists, copy it into place + leave the legacy file untouched (the
    /// next write will overwrite the new path; the legacy file stays as a
    /// safety blanket until the user decides to delete it).
    pub fn read_brain_doc(&self) -> Result<String, AppError> {
        let p = self.brain_doc_path();
        match std::fs::read_to_string(&p) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Try the legacy path before falling back to the seed.
                let legacy = self.legacy_brain_doc_path();
                if let Ok(content) = std::fs::read_to_string(&legacy) {
                    // Best-effort migrate — write the legacy content to the
                    // new path so subsequent reads + heartbeat writes line up.
                    // Failure is non-fatal; we still return the content the
                    // user wrote.
                    if let Some(parent) = p.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = atomic_write(&p, &content);
                    return Ok(content);
                }
                Ok(seed_brain_doc(Utc::now()))
            }
            Err(e) => Err(AppError::internal("read_brain", e.to_string())),
        }
    }

    /// Write the brain doc atomically (write-temp + rename). The user-edited
    /// brain.md from the /co-thinker route lands here too.
    pub fn write_brain_doc(&self, content: &str) -> Result<(), AppError> {
        let p = self.brain_doc_path();
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::internal("mkdir_team", e.to_string()))?;
        }
        atomic_write(&p, content)
    }

    /// Wave 3 cross-cut — corruption recovery (OBSERVABILITY_SPEC §8 edge
    /// case "Co-thinker brain corrupt").
    ///
    /// When the brain doc parses cleanly we read it, fine. When the parser
    /// trips (frontmatter unparseable / sentinel-only file / truncated
    /// write from a power loss), we:
    ///   1. Move the corrupt file to `.tangerine/quarantine/{ts}.md` so
    ///      the user can grep-recover anything they cared about.
    ///   2. Re-seed the brain from `seed_brain_doc(now)` — the same
    ///      neutral skeleton a fresh install starts with.
    ///   3. Return `RecoveryOutcome` describing what happened so the
    ///      caller can surface a toast ("Co-thinker brain refreshed").
    ///
    /// Idempotent: `recover_from_corrupt` on a healthy brain is a no-op
    /// (returns `RecoveryOutcome { quarantined: None, ... }`). Cheap to
    /// call from a daemon tick that already failed to parse.
    pub fn recover_from_corrupt(&self) -> Result<RecoveryOutcome, AppError> {
        let brain_path = self.brain_doc_path();
        // Healthy → no-op.
        if !brain_path.exists() {
            return Ok(RecoveryOutcome {
                quarantined: None,
                regenerated: false,
                reason: "brain doc absent — nothing to recover".into(),
            });
        }
        let raw = std::fs::read_to_string(&brain_path)
            .map_err(|e| AppError::internal("read_brain_for_recovery", e.to_string()))?;
        if !is_brain_corrupt(&raw) {
            return Ok(RecoveryOutcome {
                quarantined: None,
                regenerated: false,
                reason: "brain parses cleanly".into(),
            });
        }

        // Quarantine the corrupt file. The directory layout matches the
        // §2 crash-dump convention so support tickets can find both
        // brain quarantines + crash logs in adjacent folders.
        let now = Utc::now();
        let qdir = self
            .memory_root
            .join(".tangerine")
            .join("quarantine");
        std::fs::create_dir_all(&qdir)
            .map_err(|e| AppError::internal("mkdir_quarantine", e.to_string()))?;
        let qpath = qdir.join(format!(
            "co-thinker-{}.md",
            now.format("%Y-%m-%dT%H-%M-%SZ"),
        ));
        // `rename` works in-volume; quarantine + brain share the memory
        // root so cross-device rename is a non-issue here. We still
        // fall back to a copy + remove so the recovery never aborts.
        if let Err(e) = std::fs::rename(&brain_path, &qpath) {
            // Cross-device fallback (rare on Windows when memory root
            // and the OS temp dir end up on different volumes).
            std::fs::copy(&brain_path, &qpath).map_err(|e2| {
                AppError::internal(
                    "quarantine_brain",
                    format!("rename={e}; copy={e2}"),
                )
            })?;
            let _ = std::fs::remove_file(&brain_path);
        }

        // Regenerate from seed. Atomic write so a second crash mid-recover
        // leaves either the old brain (already quarantined) or the new
        // seed — never a half file.
        let seed = seed_brain_doc(now);
        atomic_write(&brain_path, &seed)?;
        Ok(RecoveryOutcome {
            quarantined: Some(qpath),
            regenerated: true,
            reason: "brain marker missing or parse failed".into(),
        })
    }

    /// Run one heartbeat. See module-level docs for the flow.
    pub async fn heartbeat(
        &mut self,
        cadence: HeartbeatCadence,
        primary_tool_id: Option<String>,
    ) -> Result<HeartbeatOutcome, AppError> {
        let started_inst = Instant::now();
        let started = Utc::now();

        // 0. Throttle. A second concurrent heartbeat short-circuits.
        let _guard = match self.throttle.clone().try_lock_owned() {
            Ok(g) => g,
            Err(_) => {
                return Ok(HeartbeatOutcome {
                    atoms_seen: 0,
                    brain_updated: false,
                    proposals_created: 0,
                    channel_used: "none".into(),
                    latency_ms: started_inst.elapsed().as_millis() as u64,
                    error: Some("throttled — another heartbeat is in flight".into()),
                    template_matches_emitted: 0,
                });
            }
        };

        // 1. Scan for new atoms since last_heartbeat_ts. On first run we look
        //    at the last hour so a fresh install with bundled samples gets a
        //    populated brain.md right away.
        let cutoff = self
            .last_heartbeat_ts
            .unwrap_or_else(|| started - chrono::Duration::hours(1));
        let atoms = scan_atoms_since(&self.memory_root, cutoff);
        let atoms_seen = atoms.len() as u32;

        // 2. Read current brain doc (or seed).
        let brain_existed = self.brain_doc_path().exists();
        let current_brain = self.read_brain_doc()?;

        // Fast path: no new atoms AND brain already exists → don't waste an
        // LLM call. We still evaluate rule-based templates (deadlines /
        // pattern recurrence / conflicts don't depend on a fresh LLM call;
        // they read from filesystem + telemetry directly), then bump
        // last_heartbeat_ts and emit an empty observation. This is the
        // steady-state path 90% of heartbeats hit.
        if atoms_seen == 0 && brain_existed {
            // === v1.9 P2: rule-based templates evaluation (skip-path) ===
            // Consolidated dispatch — registry handles all 7 templates
            // (P2-A: deadline / pattern_recurrence / conflict;
            //  P2-B: decision_drift / long_thread / catchup_hint;
            //  P2-C: newcomer_onboarding) and throttles to MAX_PER_HEARTBEAT.
            let template_matches_emitted =
                self.evaluate_templates(started).await as u32;
            // === end v1.9 P2 ===
            observations::append_observation(
                &self.memory_root,
                started,
                &format!(
                    "{} cadence={} atoms_seen=0 channel=skip templates={} brief=\"no new atoms\"",
                    started.format("%H:%M:%S"),
                    cadence.label(),
                    template_matches_emitted,
                ),
            )?;
            self.last_heartbeat_ts = Some(started);
            return Ok(HeartbeatOutcome {
                atoms_seen: 0,
                brain_updated: false,
                proposals_created: 0,
                channel_used: "skip".into(),
                latency_ms: started_inst.elapsed().as_millis() as u64,
                error: None,
                template_matches_emitted,
            });
        }

        // 3. Build the prompt.
        let req = build_llm_request(&current_brain, &atoms, cadence, started, primary_tool_id);

        // 4. Dispatch.
        let (response_text, channel_used, dispatch_error) =
            match self.dispatcher.dispatch(req).await {
                Ok(r) => (r.text, r.channel_used, None),
                Err(e) => (String::new(), "none".to_string(), Some(e.to_string())),
            };

        // If the LLM call failed, log + bail. We do NOT overwrite the brain
        // with empty content — a transient dispatch error keeps the existing
        // brain intact. Templates STILL evaluate — they don't depend on the
        // LLM response, so a transient dispatch outage shouldn't suppress
        // deadline / pattern / conflict suggestions.
        if let Some(err) = dispatch_error {
            // === v1.9 P2: rule-based templates evaluation (dispatch-error path) ===
            // Consolidated dispatch — see registry.rs for the 7-template list.
            let template_matches_emitted =
                self.evaluate_templates(started).await as u32;
            // === end v1.9 P2 ===
            observations::append_observation(
                &self.memory_root,
                started,
                &format!(
                    "{} cadence={} atoms_seen={} channel=none templates={} brief=\"dispatch failed: {}\"",
                    started.format("%H:%M:%S"),
                    cadence.label(),
                    atoms_seen,
                    template_matches_emitted,
                    err,
                ),
            )?;
            self.last_heartbeat_ts = Some(started);
            return Ok(HeartbeatOutcome {
                atoms_seen,
                brain_updated: false,
                proposals_created: 0,
                channel_used: "none".into(),
                latency_ms: started_inst.elapsed().as_millis() as u64,
                error: Some(err),
                template_matches_emitted,
            });
        }

        // 5. Validate + apply the grounding rule.
        let validated = validate_and_ground(&response_text, &current_brain);

        // 6. Write brain.md atomically.
        if !validated.is_empty() {
            self.write_brain_doc(&validated)?;
        }
        let brain_updated = !validated.is_empty();

        // 7. Detect proposals (lines starting with `PROPOSAL:`) and write them.
        let proposals_created = write_proposals(&self.memory_root, &response_text, started)?;

        // 7b. v1.8 Phase 4-C — detect canvas-peer sentinels and act on them.
        //     `THROW_STICKY:` → AGI puts a fresh sticky on a canvas.
        //     `COMMENT_STICKY:` → AGI replies on an existing sticky.
        //     Each successful throw also appends a `Recent reasoning` anchor
        //     (`[sticky:{project}/{topic}/{stickyid}]`) to the brain doc so the
        //     /co-thinker route can scroll to the matching reasoning entry
        //     when "View AGI reasoning" is clicked.
        let canvas_anchors =
            apply_canvas_sentinels(&self.memory_root, &response_text, started).await;
        if !canvas_anchors.is_empty() && brain_updated {
            // Append the reasoning anchors to the just-written brain doc.
            // Best-effort — failure does not roll back the heartbeat.
            let _ = append_canvas_reasoning_anchors(&self.brain_doc_path(), &canvas_anchors);
        }

        // === v1.9 P2: rule-based templates evaluation (main path) ===
        // Single integration point for all 7 v1.9 rule-based templates
        // (P2-A: deadline / pattern_recurrence / conflict;
        //  P2-B: decision_drift / long_thread / catchup_hint;
        //  P2-C: newcomer_onboarding). The dispatch lives in
        // `templates::registry::evaluate_and_emit` — registry sorts by
        // priority desc + truncates to MAX_PER_HEARTBEAT (3) before emitting
        // through the engine's `EventSink`. Adding a new template is a
        // one-line change to `registry::all_templates()` — never this file.
        // Runs after the brain doc has been written and canvas sentinels
        // acted on, but BEFORE the observation log so the log line carries
        // the template count.
        let template_matches_emitted =
            self.evaluate_templates(started).await as u32;
        // === end v1.9 P2 ===

        // 8. Append observation log entry.
        let brief = first_reasoning_line(&validated)
            .unwrap_or_else(|| "(no brief extracted)".to_string());
        observations::append_observation(
            &self.memory_root,
            started,
            &format!(
                "{} cadence={} atoms_seen={} channel={} proposals={} templates={} brief=\"{}\"",
                started.format("%H:%M:%S"),
                cadence.label(),
                atoms_seen,
                channel_used,
                proposals_created,
                template_matches_emitted,
                escape_for_log(&brief),
            ),
        )?;

        // 9. Update last_heartbeat_ts.
        self.last_heartbeat_ts = Some(started);

        // === wave 10 === — auto-commit the memory dir if it's git-tracked.
        // Defensive: never block the heartbeat. The helper itself logs +
        // returns silently on any git error (missing binary / not a repo /
        // bad config / locked index). `vendors_seen` is derived from the
        // distinct AI-tool-keyword count in the new atoms' rel_paths.
        if brain_updated || atoms_seen > 0 {
            let memory_dir = self.memory_root.clone();
            let ts = started.to_rfc3339();
            let vendors_seen = count_vendors_in_atoms(&atoms);
            // Best-effort: spawn so we don't extend the heartbeat's
            // wall-clock latency by waiting on git. The throttle has been
            // released by here, so a slow `git add -A` on a huge memory
            // dir doesn't keep the next heartbeat waiting either.
            tokio::spawn(async move {
                crate::commands::git_sync::auto_commit_after_heartbeat(
                    &memory_dir,
                    &ts,
                    atoms_seen,
                    vendors_seen,
                    None,
                )
                .await;
            });
        }
        // === end wave 10 ===

        Ok(HeartbeatOutcome {
            atoms_seen,
            brain_updated,
            proposals_created,
            channel_used,
            latency_ms: started_inst.elapsed().as_millis() as u64,
            error: None,
            template_matches_emitted,
        })
    }

    /// v1.9.0-beta.2 — build a [`TemplateContext`] (loading the 7-day
    /// telemetry window) and ask `templates::registry::evaluate_and_emit`
    /// to run every registered template + emit the top
    /// `MAX_PER_HEARTBEAT` matches via the engine's `EventSink`.
    ///
    /// Telemetry read failures are absorbed (treated as empty window) — a
    /// transient telemetry IO blip should never stop deadline / conflict
    /// templates from firing.
    ///
    /// Returns the number of matches emitted (post-throttle), which the
    /// caller threads into `HeartbeatOutcome::template_matches_emitted`.
    ///
    /// v1.9.0 P4-A — routes through `evaluate_and_emit_with_enrichment`
    /// so the rule emit kicks off a fire-and-forget LLM enrichment task
    /// per match (subject to the per-heartbeat budget). Enrichment is
    /// always enabled at this layer; the bus + frontend gate per-user
    /// preference (agiVolume / agiParticipation). The daemon-driven
    /// heartbeat carries no `primary_tool_id` — the session_borrower
    /// falls back through its priority list.
    async fn evaluate_templates(&self, now: DateTime<Utc>) -> usize {
        // 7 days = 168 hours. Spec §4 row 4 (pattern_recurrence) anchors the
        // window length; other templates ignore the field.
        let recent_telemetry = match crate::agi::telemetry::read_events_window(
            &self.memory_root,
            7 * 24,
        )
        .await
        {
            Ok(v) => v,
            Err(_) => Vec::new(),
        };
        let ctx = TemplateContext {
            memory_root: &self.memory_root,
            now,
            recent_telemetry,
        };
        templates_registry::evaluate_and_emit_with_enrichment(
            &ctx,
            Arc::clone(&self.event_sink),
            self.memory_root.clone(),
            None,
            true,
        )
        .await
    }
}

// ---------------------------------------------------------------------------
// Brain doc seeding

/// Initial brain doc written on cold start (heartbeat where no atoms exist
/// yet, AND the brain.md doesn't exist yet). User-readable from the
/// /co-thinker route on day-zero.
pub fn seed_brain_doc(now: DateTime<Utc>) -> String {
    format!(
        "# Tangerine Co-Thinker\n\
Initialized: {ts}\n\
\n\
## What I'm watching\n\
- (No atoms captured yet — the brain warms up after a few sources have data.)\n\
\n\
## Active threads\n\
- (None.)\n\
\n\
## My todo (next 24h, ranked)\n\
- [ ] Wait for sources to capture team data.\n\
\n\
## Recent reasoning\n\
- {ts} → Cold start. Will populate as atoms accumulate.\n\
\n\
## Cited atoms (grounding)\n\
- (None yet.)\n",
        ts = now.format("%Y-%m-%d %H:%M UTC"),
    )
}

// ---------------------------------------------------------------------------
// Atom scanning

/// One atom file the brain has noticed since the last heartbeat. We carry the
/// repo-relative path because the citation rule wants the path string the
/// user would see in the markdown, not the absolute filesystem path.
#[derive(Debug, Clone)]
pub struct AtomSummary {
    /// Path relative to memory_root, with forward slashes (e.g.
    /// `decisions/sample-pricing-20-seat.md`).
    pub rel_path: String,
    /// First non-empty line of the file's body (post-frontmatter), capped at
    /// 200 chars. Used in the LLM prompt's "new atoms" section.
    pub blurb: String,
}

/// Walk the memory dir, return atoms whose mtime is >= cutoff. Skips dotted
/// dirs (`.tangerine`, `.git`) and the `agi/` subtree itself (we don't want
/// the brain reasoning about its own reasoning log).
pub fn scan_atoms_since(memory_root: &Path, cutoff: DateTime<Utc>) -> Vec<AtomSummary> {
    let mut out = Vec::new();
    let cutoff_secs = cutoff.timestamp();
    let _ = walk_dir(memory_root, memory_root, cutoff_secs, &mut out);
    // Stable order so prompt + tests are deterministic.
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

fn walk_dir(
    root: &Path,
    dir: &Path,
    cutoff_secs: i64,
    out: &mut Vec<AtomSummary>,
) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        // Skip our own subtree to avoid feeding the brain its own logs.
        if path == root.join("agi") {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            let _ = walk_dir(root, &path, cutoff_secs, out);
        } else if ft.is_file() {
            if !name_str.ends_with(".md") {
                continue;
            }
            // === wave 6 === BUG #1 — the brain doc moved to
            // `team/co-thinker.md`. Exclude it from atom scans so the
            // heartbeat doesn't feed the brain its own previous tick output.
            if path == root.join("team").join("co-thinker.md") {
                continue;
            }
            let mtime = match entry.metadata().and_then(|m| m.modified()) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime_secs = match mtime.duration_since(std::time::UNIX_EPOCH) {
                Ok(d) => d.as_secs() as i64,
                Err(_) => continue,
            };
            if mtime_secs < cutoff_secs {
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let blurb = read_blurb(&path);
            out.push(AtomSummary {
                rel_path: rel,
                blurb,
            });
        }
    }
    Ok(())
}

// === wave 10 ===
/// Count distinct AI-tool vendors mentioned in the atoms' rel_paths. Used
/// for the auto-commit message (`X atoms, Y vendors`). The match is a
/// dumb keyword scan against the rel_path — false positives are fine
/// because this is a commit-message hint, not a metric. The keyword list
/// matches `lib/ai-tools-config.ts` on the React side.
pub fn count_vendors_in_atoms(atoms: &[AtomSummary]) -> u32 {
    const VENDORS: &[&str] = &[
        "cursor", "claude", "codex", "windsurf", "chatgpt", "gemini",
        "copilot", "ollama", "v0", "devin", "replit",
    ];
    let mut seen = std::collections::HashSet::new();
    for atom in atoms {
        let lower = atom.rel_path.to_lowercase();
        for v in VENDORS {
            if lower.contains(v) {
                seen.insert(*v);
            }
        }
    }
    seen.len() as u32
}
// === end wave 10 ===

/// Read the first non-frontmatter, non-empty line. Capped at 200 chars.
fn read_blurb(path: &Path) -> String {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    let mut in_fm = false;
    let mut fm_done = false;
    for (i, line) in raw.lines().enumerate() {
        if i == 0 && line.trim() == "---" {
            in_fm = true;
            continue;
        }
        if in_fm && !fm_done {
            if line.trim() == "---" {
                fm_done = true;
            }
            continue;
        }
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let mut buf = String::new();
        for (n, c) in t.chars().enumerate() {
            if n >= 200 {
                buf.push('…');
                break;
            }
            buf.push(c);
        }
        return buf;
    }
    String::new()
}

// ---------------------------------------------------------------------------
// LLM prompt construction

const SYSTEM_PROMPT: &str = "You are Tangerine's co-thinker, a persistent team-memory analyst. \
You read the team's atoms (decisions, meetings, threads, canvas/<project>/<topic>.md) and \
maintain a brain doc the user can audit. Every claim you make MUST be followed by a \
citation in the form `[path/to/atom.md]` or it will be silently dropped. Only output the \
new full markdown for co-thinker.md — no preamble, no fences, no commentary outside the \
doc. Use exactly these section headings: \
`## What I'm watching`, `## Active threads`, `## My todo (next 24h, ranked)`, \
`## Recent reasoning`, `## Cited atoms (grounding)`. \
When you propose a decision lock or notification, prefix the line with `PROPOSAL:` and \
include `type=decision|notification` and a short slug. \
\
You can also participate on Canvas surfaces as a peer — when reading a `canvas/<p>/<t>.md` \
atom suggests it, emit a sentinel line OUTSIDE the brain doc body (the host strips these \
before writing brain.md): \
`THROW_STICKY: project={p} topic={t} body={b} color=yellow` to propose a new sticky, or \
`COMMENT_STICKY: project={p} topic={t} sticky_id={id} body={b}` to reply on a sticky. Be \
sparing — at most 1 throw + 1 comment per heartbeat unless the team is very active.";

fn build_llm_request(
    current_brain: &str,
    atoms: &[AtomSummary],
    cadence: HeartbeatCadence,
    now: DateTime<Utc>,
    primary_tool_id: Option<String>,
) -> LlmRequest {
    let mut user = String::new();
    user.push_str("# Heartbeat\n");
    user.push_str(&format!(
        "Now: {} ({})\n\n",
        now.format("%Y-%m-%d %H:%M UTC"),
        cadence.label()
    ));
    user.push_str("## Current brain doc\n\n");
    user.push_str(current_brain);
    user.push_str("\n\n## New atoms since last heartbeat\n\n");
    if atoms.is_empty() {
        user.push_str("(none — refresh recent reasoning only)\n");
    } else {
        for a in atoms {
            user.push_str(&format!("- `[{}]` — {}\n", a.rel_path, a.blurb));
        }
    }
    user.push_str(
        "\n## Task\n\n\
Update brain.md sections in place. Cite every claim with an atom path in `[…]` form. \
Drop sections that have no grounding. Output only the new full markdown for co-thinker.md.\n",
    );

    LlmRequest {
        system: SYSTEM_PROMPT.to_string(),
        user,
        primary_tool_id,
    }
}

// ---------------------------------------------------------------------------
// Validation + grounding rule

/// Required section headings. If the response is missing any of these, we
/// fall back to the existing brain doc rather than corrupting it.
const REQUIRED_HEADINGS: &[&str] = &[
    "## What I'm watching",
    "## Active threads",
    "## My todo (next 24h, ranked)",
    "## Recent reasoning",
    "## Cited atoms (grounding)",
];

/// Apply the grounding rule + section validation. Returns "" when the
/// response is malformed (caller treats empty as "don't overwrite the brain").
pub fn validate_and_ground(response: &str, current_brain: &str) -> String {
    let trimmed = response.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Strip leading code fences if the model wrapped its output anyway.
    let body = trimmed
        .trim_start_matches("```markdown")
        .trim_start_matches("```md")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    // Must contain every required heading. Missing any → bail.
    for h in REQUIRED_HEADINGS {
        if !body.contains(h) {
            return String::new();
        }
    }

    // Drop uncited bullet/dash claims. The rule:
    //   - lines starting with `- ` or `* ` or numbered (`1. `) MUST contain
    //     a `[…md]` token (or an in-parens pseudo-citation like `(no atoms…)`)
    //     to survive.
    // Heading lines, blank lines, the `Last heartbeat:` line, and
    // intentional placeholders (containing `(None)` / `(none)` / `(No atoms`)
    // pass through untouched.
    //
    // v1.8 Phase 4-C: also drop `THROW_STICKY:` / `COMMENT_STICKY:` sentinel
    // lines — those are out-of-band instructions for the canvas peer, not
    // brain-doc content. The host parses them BEFORE calling this validator
    // (see `apply_canvas_sentinels`).
    let mut out = String::new();
    for line in body.lines() {
        if is_claim_line(line) && !has_citation(line) {
            // Drop silently.
            continue;
        }
        if is_canvas_sentinel(line) {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }

    let cleaned = out.trim_end().to_string();

    // Re-validate post-strip — if dropping uncited claims removed a section
    // entirely, fall back rather than write a doc with empty headings.
    for h in REQUIRED_HEADINGS {
        if !cleaned.contains(h) {
            // Same heading might have lost all its claims. Synthesize a
            // safe doc by fusing cleaned content with a "(no grounded
            // claims)" placeholder under each missing heading.
            return repair_missing_sections(&cleaned, current_brain);
        }
    }
    cleaned
}

fn is_claim_line(line: &str) -> bool {
    let t = line.trim_start();
    if t.starts_with('#') {
        return false;
    }
    if t.starts_with("- ") || t.starts_with("* ") {
        return true;
    }
    // Numbered list "1. ", "2. " ...
    let mut chars = t.chars();
    let mut saw_digit = false;
    while let Some(c) = chars.next() {
        if c.is_ascii_digit() {
            saw_digit = true;
            continue;
        }
        if saw_digit && c == '.' {
            if matches!(chars.next(), Some(' ')) {
                return true;
            }
        }
        break;
    }
    false
}

fn has_citation(line: &str) -> bool {
    // Accept `[path.md]` (the canonical form) or an explicit
    // `(no atoms ...)` / `(None)` placeholder.
    let lower = line.to_lowercase();
    if lower.contains("(none") || lower.contains("(no atoms") || lower.contains("(none.)") {
        return true;
    }
    // `[…md]` — find a `[` followed by `]` with `.md` inside.
    if let Some(open) = line.find('[') {
        if let Some(close_rel) = line[open..].find(']') {
            let inner = &line[open + 1..open + close_rel];
            if inner.contains(".md") {
                return true;
            }
        }
    }
    false
}

/// When the grounding-strip removed an entire heading's bullets, splice in a
/// `- (No grounded claims yet.)` line. This keeps the brain doc structurally
/// intact rather than discarding the whole tick.
fn repair_missing_sections(cleaned: &str, _current_brain: &str) -> String {
    let mut out = String::new();
    let mut sections_seen = std::collections::HashSet::new();
    for line in cleaned.lines() {
        out.push_str(line);
        out.push('\n');
        for h in REQUIRED_HEADINGS {
            if line.trim() == *h {
                sections_seen.insert(*h);
            }
        }
    }
    for h in REQUIRED_HEADINGS {
        if !sections_seen.contains(h) {
            out.push_str("\n");
            out.push_str(h);
            out.push_str("\n- (No grounded claims yet.)\n");
        }
    }
    out.trim_end().to_string()
}

/// Pull the first `## Recent reasoning` bullet out for the observation log.
fn first_reasoning_line(brain: &str) -> Option<String> {
    let mut in_section = false;
    for line in brain.lines() {
        let t = line.trim();
        if t == "## Recent reasoning" {
            in_section = true;
            continue;
        }
        if in_section {
            if t.starts_with("##") {
                break;
            }
            if let Some(rest) = t.strip_prefix("- ") {
                return Some(rest.to_string());
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Proposal detection

/// Scan the LLM response for `PROPOSAL:` sentinel lines and write each to
/// `agi/proposals/{type}-{slug}-{date}.md`. Returns the count written.
///
/// === v2.5 review wire ===
/// v2.5 §1 — when `kind == "decision"`, a `PROPOSAL:` no longer auto-commits
/// to `team/decisions/`. Instead we land a *draft* atom at
/// `team/decisions/{slug}.md` (status: draft) and immediately initialize a
/// review thread via `crate::agi::review::create_review_in`. Teammates vote
/// on `/reviews`; 2/3 quorum auto-promotes (status flips to `locked`).
/// Non-decision kinds (e.g. `notification`) keep the legacy path under
/// `agi/proposals/` since they don't need quorum.
/// === end v2.5 review wire ===
fn write_proposals(
    memory_root: &Path,
    response: &str,
    now: DateTime<Utc>,
) -> Result<u32, AppError> {
    let mut count = 0u32;
    for line in response.lines() {
        let t = line.trim_start();
        let body = match t.strip_prefix("PROPOSAL:") {
            Some(rest) => rest.trim(),
            None => continue,
        };
        let (kind, slug, summary) = parse_proposal_line(body);

        // === v2.5 review wire ===
        if kind == "decision" {
            let filename = format!("{}.md", slug);
            let path = memory_root.join("team").join("decisions").join(&filename);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| AppError::internal("mkdir_decisions", e.to_string()))?;
            }
            // Skip if a real (non-draft) atom already lives at this slug —
            // we never overwrite a locked decision.
            let already_locked = path.exists() && existing_decision_locked(&path)?;
            if !already_locked {
                let content = format!(
                    "---\n\
title: {slug}\n\
proposed_by: co-thinker\n\
proposed_at: {ts}\n\
status: draft\n\
---\n\
\n\
## Proposal\n\
\n\
{summary}\n",
                    slug = slug,
                    ts = now.to_rfc3339(),
                    summary = summary,
                );
                atomic_write(&path, &content)?;
            }
            // Idempotent — does nothing if the sidecar already exists.
            // Best-effort: a review-init failure must not crash the heartbeat.
            // Default team size = 3 (typical ICP per BUSINESS_MODEL §3.3).
            let _ = crate::agi::review::create_review_in(memory_root, &path, 3);
            count += 1;
            continue;
        }
        // === end v2.5 review wire ===

        // Legacy path for non-decision kinds (notification, etc.).
        let date = now.format("%Y-%m-%d");
        let filename = format!("{}-{}-{}.md", kind, slug, date);
        let path = memory_root.join("agi").join("proposals").join(&filename);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::internal("mkdir_proposals", e.to_string()))?;
        }
        let content = format!(
            "---\n\
type: {kind}\n\
slug: {slug}\n\
proposed_at: {ts}\n\
status: pending\n\
---\n\
\n\
## Proposal\n\
\n\
{summary}\n",
            kind = kind,
            slug = slug,
            ts = now.to_rfc3339(),
            summary = summary,
        );
        atomic_write(&path, &content)?;
        count += 1;
    }
    Ok(count)
}

/// === v2.5 review wire ===
/// Returns true when the existing decision atom at `path` has been promoted
/// past `draft` (status: locked / final / rejected). We use this to avoid
/// overwriting a quorum-promoted atom with a freshly re-fired co-thinker
/// proposal.
fn existing_decision_locked(path: &Path) -> Result<bool, AppError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| AppError::internal("read_decision_atom", e.to_string()))?;
    let mut in_fm = false;
    for (i, line) in raw.lines().enumerate() {
        if i == 0 && line.trim() == "---" {
            in_fm = true;
            continue;
        }
        if in_fm {
            if line.trim() == "---" {
                break;
            }
            if let Some(rest) = line.trim_start().strip_prefix("status:") {
                let s = rest.trim();
                return Ok(!s.eq_ignore_ascii_case("draft"));
            }
        }
    }
    Ok(false)
}
/// === end v2.5 review wire ===

/// Parse one `PROPOSAL:` line. Format:
///   `PROPOSAL: type=decision slug=pricing-lock <free-text summary>`
/// Defaults: type=decision, slug=item-{N}.
fn parse_proposal_line(body: &str) -> (String, String, String) {
    let mut kind = "decision".to_string();
    let mut slug = "item".to_string();
    let mut summary_parts: Vec<&str> = Vec::new();
    for tok in body.split_whitespace() {
        if let Some(v) = tok.strip_prefix("type=") {
            kind = sanitize_slug(v);
        } else if let Some(v) = tok.strip_prefix("slug=") {
            slug = sanitize_slug(v);
        } else {
            summary_parts.push(tok);
        }
    }
    let summary = summary_parts.join(" ");
    (
        kind,
        slug,
        if summary.is_empty() {
            "(no summary provided)".to_string()
        } else {
            summary
        },
    )
}

fn sanitize_slug(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Filesystem helpers

fn atomic_write(path: &Path, content: &str) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir", e.to_string()))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content).map_err(|e| AppError::internal("write_tmp", e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| AppError::internal("rename", e.to_string()))?;
    Ok(())
}

fn escape_for_log(s: &str) -> String {
    s.replace('"', "'").replace('\n', " ")
}

// ---------------------------------------------------------------------------
// v1.8 Phase 4-C — Canvas-peer sentinels.
//
// The LLM emits `THROW_STICKY:` / `COMMENT_STICKY:` lines outside the brain
// doc body. We strip them from the validated brain doc (see `validate_and_ground`)
// and act on them here.

/// Anchor shape used to splice "Recent reasoning" entries the /co-thinker
/// route can scroll to via `#sticky-{id}` URL fragments.
#[derive(Debug, Clone)]
pub struct CanvasReasoningAnchor {
    pub project: String,
    pub topic: String,
    pub sticky_id: String,
    /// Either `"throw"` or `"comment"` — used in the appended bullet line.
    pub kind: String,
    pub blurb: String,
}

/// True if `line` is a `THROW_STICKY:` / `COMMENT_STICKY:` sentinel. Used by
/// the validator to keep them out of the brain doc.
pub fn is_canvas_sentinel(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("THROW_STICKY:") || t.starts_with("COMMENT_STICKY:")
}

/// Parse + execute every canvas sentinel in the LLM response. Returns the
/// "Recent reasoning" anchors that should be appended to the brain doc.
///
/// Sentinel grammar (whitespace-tolerant):
///   `THROW_STICKY: project=<p> topic=<t> body=<b> color=<c>`
///   `COMMENT_STICKY: project=<p> topic=<t> sticky_id=<id> body=<b>`
///
/// `body` and `topic` may contain spaces — we treat them as `key=value` until
/// the next `key=` token boundary. Failures are logged + skipped (we never
/// fail the whole heartbeat over a malformed sentinel).
pub async fn apply_canvas_sentinels(
    memory_root: &Path,
    response: &str,
    now: DateTime<Utc>,
) -> Vec<CanvasReasoningAnchor> {
    let mut anchors: Vec<CanvasReasoningAnchor> = Vec::new();
    for line in response.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("THROW_STICKY:") {
            let kv = parse_canvas_kv(rest);
            let project = kv.get("project").cloned().unwrap_or_default();
            let topic = kv.get("topic").cloned().unwrap_or_default();
            let body = kv.get("body").cloned().unwrap_or_default();
            let color = kv.get("color").cloned().unwrap_or_else(|| "yellow".into());
            if project.is_empty() || topic.is_empty() || body.is_empty() {
                tracing::debug!(
                    "co_thinker: skipping malformed THROW_STICKY (missing project/topic/body): {}",
                    line
                );
                continue;
            }
            match canvas_writer::agi_throw_sticky_in(
                memory_root,
                project.clone(),
                topic.clone(),
                body.clone(),
                color,
            )
            .await
            {
                Ok(id) => anchors.push(CanvasReasoningAnchor {
                    project,
                    topic,
                    sticky_id: id,
                    kind: "throw".into(),
                    blurb: short_blurb(&body),
                }),
                Err(e) => {
                    tracing::warn!(
                        "co_thinker: THROW_STICKY failed: {}, line={}",
                        e,
                        line
                    );
                }
            }
        } else if let Some(rest) = t.strip_prefix("COMMENT_STICKY:") {
            let kv = parse_canvas_kv(rest);
            let project = kv.get("project").cloned().unwrap_or_default();
            let topic = kv.get("topic").cloned().unwrap_or_default();
            let sticky_id = kv.get("sticky_id").cloned().unwrap_or_default();
            let body = kv.get("body").cloned().unwrap_or_default();
            if project.is_empty() || topic.is_empty() || sticky_id.is_empty() || body.is_empty() {
                tracing::debug!(
                    "co_thinker: skipping malformed COMMENT_STICKY: {}",
                    line
                );
                continue;
            }
            match canvas_writer::agi_comment_sticky_in(
                memory_root,
                project.clone(),
                topic.clone(),
                sticky_id.clone(),
                body.clone(),
            )
            .await
            {
                Ok(()) => anchors.push(CanvasReasoningAnchor {
                    project,
                    topic,
                    sticky_id,
                    kind: "comment".into(),
                    blurb: short_blurb(&body),
                }),
                Err(e) => {
                    tracing::warn!(
                        "co_thinker: COMMENT_STICKY failed: {}, line={}",
                        e,
                        line
                    );
                }
            }
        }
    }
    let _ = now;
    anchors
}

/// Parse `key=value key=value ...` where each value runs until the next
/// `key=` token (so `body=foo bar baz topic=x` correctly captures `foo bar baz`).
fn parse_canvas_kv(s: &str) -> std::collections::HashMap<String, String> {
    // Pre-scan to find every `key=` index. Keys are alphanumeric + `_`.
    let chars: Vec<char> = s.chars().collect();
    let mut starts: Vec<(usize, String)> = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_alphabetic() {
            // Look ahead for `key=`.
            let mut j = i;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            if j < chars.len() && chars[j] == '=' && j > i {
                let key: String = chars[i..j].iter().collect();
                // Boundary check — preceding char must be start, whitespace, or `,`.
                let preceding_ok = i == 0
                    || matches!(chars.get(i - 1).copied(), Some(c) if c.is_whitespace() || c == ',');
                if preceding_ok {
                    starts.push((j + 1, key.to_lowercase())); // value starts after `=`
                    i = j + 1;
                    continue;
                }
            }
        }
        i += 1;
    }

    // Carve substrings between consecutive starts.
    let mut out = std::collections::HashMap::new();
    for k in 0..starts.len() {
        let (vstart, ref key) = starts[k];
        let vend = if k + 1 < starts.len() {
            // value ends just before the next key (which is at chars[start..]).
            // We scanned the next key's position as `(start_of_value, key)`,
            // and the actual key char starts at: prev_value_end such that
            // chars[prev_value_end..next_value_start - 1] == "<key>=".
            let next_vstart = starts[k + 1].0;
            // The next key occupies chars[next_key_start..next_vstart - 1].
            // We need to walk back from next_vstart - 1 across `=` and the key
            // chars to find the boundary.
            let mut pos = next_vstart.saturating_sub(1); // points at '='
            while pos > 0 {
                let c = chars[pos - 1];
                if c.is_ascii_alphanumeric() || c == '_' {
                    pos -= 1;
                } else {
                    break;
                }
            }
            pos
        } else {
            chars.len()
        };
        let v: String = chars[vstart..vend].iter().collect();
        out.insert(key.clone(), v.trim().trim_end_matches(',').trim().to_string());
    }
    out
}

fn short_blurb(s: &str) -> String {
    let trimmed = s.replace('\n', " ");
    if trimmed.chars().count() <= 80 {
        trimmed
    } else {
        let mut out: String = trimmed.chars().take(80).collect();
        out.push('…');
        out
    }
}

/// Append `Recent reasoning` bullets (with `[sticky:p/t/id]` anchor markers)
/// to the just-written brain doc. Best-effort — IO failures are logged but
/// don't fail the heartbeat.
fn append_canvas_reasoning_anchors(
    brain_path: &Path,
    anchors: &[CanvasReasoningAnchor],
) -> Result<(), AppError> {
    if anchors.is_empty() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(brain_path)
        .map_err(|e| AppError::internal("read_brain_for_anchor", e.to_string()))?;

    // Find the `## Recent reasoning` heading; insert immediately after it.
    let lines: Vec<&str> = raw.lines().collect();
    let mut insert_at: Option<usize> = None;
    for (i, l) in lines.iter().enumerate() {
        if l.trim() == "## Recent reasoning" {
            insert_at = Some(i + 1);
            break;
        }
    }
    let insert_at = match insert_at {
        Some(n) => n,
        None => {
            // No section to append to — don't try to repair; just no-op.
            return Ok(());
        }
    };

    let mut new_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    for (k, a) in anchors.iter().enumerate() {
        let bullet = format!(
            "- {ts} → AGI {kind} on canvas `{p}/{t}` — {blurb} [sticky:{p}/{t}/{id}] [canvas/{p}/{t}.md]",
            ts = Utc::now().format("%Y-%m-%d %H:%M"),
            kind = a.kind,
            p = a.project,
            t = a.topic,
            id = a.sticky_id,
            blurb = a.blurb,
        );
        new_lines.insert(insert_at + k, bullet);
    }
    let mut out = new_lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    std::fs::write(brain_path, out)
        .map_err(|e| AppError::internal("write_brain_anchors", e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

    /// Simple deterministic dispatcher for unit tests.
    struct MockDispatcher {
        canned: StdMutex<Vec<Result<LlmResponse, AppError>>>,
        delay: Option<Duration>,
        calls: StdMutex<u32>,
    }

    impl MockDispatcher {
        fn ok(text: &str) -> Self {
            Self {
                canned: StdMutex::new(vec![Ok(LlmResponse {
                    text: text.to_string(),
                    channel_used: "mock".to_string(),
                })]),
                delay: None,
                calls: StdMutex::new(0),
            }
        }
        fn slow_ok(text: &str, delay: Duration) -> Self {
            Self {
                canned: StdMutex::new(vec![Ok(LlmResponse {
                    text: text.to_string(),
                    channel_used: "mock".to_string(),
                })]),
                delay: Some(delay),
                calls: StdMutex::new(0),
            }
        }
        fn calls(&self) -> u32 {
            *self.calls.lock().unwrap()
        }
    }

    impl LlmDispatcher for MockDispatcher {
        fn dispatch<'a>(
            &'a self,
            _req: LlmRequest,
        ) -> BoxFuture<'a, Result<LlmResponse, AppError>> {
            Box::pin(async move {
                *self.calls.lock().unwrap() += 1;
                if let Some(d) = self.delay {
                    tokio::time::sleep(d).await;
                }
                let next = {
                    let mut q = self.canned.lock().unwrap();
                    if q.len() > 1 {
                        q.remove(0)
                    } else {
                        q[0].clone()
                    }
                };
                next
            })
        }
    }

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_co_thinker_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn touch_atom(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
    }

    fn full_brain_response() -> String {
        r#"# Tangerine Co-Thinker
Last heartbeat: 2026-04-26 14:23 (cadence: manual)

## What I'm watching
- Pricing lock at $20/seat decided. [decisions/sample-pricing-20-seat.md]

## Active threads
1. Roadmap sync follow-ups [decisions/sample-pricing-20-seat.md]

## My todo (next 24h, ranked)
- [ ] Confirm 3-seat minimum with David. [decisions/sample-pricing-20-seat.md]

## Recent reasoning
- 2026-04-26 14:23 → New pricing decision detected. [decisions/sample-pricing-20-seat.md]

## Cited atoms (grounding)
- [decisions/sample-pricing-20-seat.md]
"#
        .to_string()
    }

    #[tokio::test]
    async fn test_heartbeat_writes_brain_doc() {
        let root = tmp_root();
        touch_atom(
            &root,
            "decisions/sample-pricing-20-seat.md",
            "---\nsource: meeting\ntitle: Pricing\n---\n\nPricing $20/seat\n",
        );
        let mock = Arc::new(MockDispatcher::ok(&full_brain_response()));
        let mut engine = CoThinkerEngine::with_dispatcher(root.clone(), mock.clone());
        let out = engine.heartbeat(HeartbeatCadence::Manual, None).await.unwrap();
        assert!(out.brain_updated, "brain should be written");
        assert_eq!(out.error, None);
        // === wave 6 === BUG #1 — brain doc moved to `team/co-thinker.md`.
        let brain = std::fs::read_to_string(root.join("team/co-thinker.md")).unwrap();
        for h in REQUIRED_HEADINGS {
            assert!(brain.contains(h), "missing heading {}", h);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_heartbeat_skips_when_no_new_atoms() {
        let root = tmp_root();
        // Pre-create the brain doc so the skip path is reachable on tick #2.
        // === wave 6 === BUG #1 — brain doc lives under `team/` now.
        std::fs::create_dir_all(root.join("team")).unwrap();
        std::fs::write(
            root.join("team/co-thinker.md"),
            seed_brain_doc(Utc::now()),
        )
        .unwrap();
        let mock = Arc::new(MockDispatcher::ok(&full_brain_response()));
        let mut engine = CoThinkerEngine::with_dispatcher(root.clone(), mock.clone());
        // First tick — no atoms (memory is empty), brain.md exists, expect skip.
        engine.last_heartbeat_ts = Some(Utc::now() - chrono::Duration::seconds(1));
        let out = engine.heartbeat(HeartbeatCadence::Manual, None).await.unwrap();
        assert_eq!(out.atoms_seen, 0);
        assert!(!out.brain_updated);
        assert_eq!(out.channel_used, "skip");
        // Second tick — still no atoms, still skip. No LLM calls total.
        let out2 = engine.heartbeat(HeartbeatCadence::Manual, None).await.unwrap();
        assert_eq!(out2.atoms_seen, 0);
        assert_eq!(mock.calls(), 0, "dispatcher must not be called on skip");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_grounding_rule_drops_uncited_claims() {
        let root = tmp_root();
        touch_atom(
            &root,
            "decisions/x.md",
            "---\ntitle: X\n---\n\nbody\n",
        );
        // Two claims under "What I'm watching" — one cited, one not.
        let mixed = r#"# Tangerine Co-Thinker
Last heartbeat: 2026-04-26

## What I'm watching
- This claim has a citation. [decisions/x.md]
- This claim is uncited and must be dropped.

## Active threads
- Thread one. [decisions/x.md]

## My todo (next 24h, ranked)
- [ ] Do the thing. [decisions/x.md]

## Recent reasoning
- 2026-04-26 → reasoning. [decisions/x.md]

## Cited atoms (grounding)
- [decisions/x.md]
"#;
        let mock = Arc::new(MockDispatcher::ok(mixed));
        let mut engine = CoThinkerEngine::with_dispatcher(root.clone(), mock.clone());
        let out = engine.heartbeat(HeartbeatCadence::Manual, None).await.unwrap();
        assert!(out.brain_updated);
        // === wave 6 === BUG #1 — brain doc moved to `team/co-thinker.md`.
        let brain = std::fs::read_to_string(root.join("team/co-thinker.md")).unwrap();
        assert!(brain.contains("This claim has a citation."));
        assert!(
            !brain.contains("This claim is uncited and must be dropped."),
            "uncited claim must be silently truncated"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_concurrent_heartbeat_is_throttled() {
        let root = tmp_root();
        touch_atom(&root, "decisions/x.md", "---\n---\n\nbody\n");
        // Slow dispatcher so the first heartbeat is still in-flight when the
        // second one tries to acquire the lock.
        let mock = Arc::new(MockDispatcher::slow_ok(
            &full_brain_response(),
            Duration::from_millis(150),
        ));
        let engine = CoThinkerEngine::with_dispatcher(root.clone(), mock.clone());
        // We need the engine to be Send across the join. CoThinkerEngine is
        // not Clone, but we can stage the second call inline using a shared
        // mock and a separate engine pointing at the same root.
        let mut engine2 = CoThinkerEngine::with_dispatcher(
            root.clone(),
            // Different dispatcher arc — but the throttle is *per-engine*.
            // To exercise the throttle we run the second heartbeat against
            // the SAME engine, so spawn the first via tokio.
            mock.clone(),
        );
        // Share the throttle so we actually exercise it.
        engine2.throttle = engine.throttle.clone();

        let mut e1 = engine;
        let h1 = tokio::spawn(async move {
            e1.heartbeat(HeartbeatCadence::Manual, None).await.unwrap()
        });
        // Brief yield so e1 has a chance to acquire the lock + start the
        // dispatcher delay before e2 calls.
        tokio::time::sleep(Duration::from_millis(20)).await;
        let out2 = engine2.heartbeat(HeartbeatCadence::Manual, None).await.unwrap();
        assert!(
            out2.error.as_deref().unwrap_or("").contains("throttled"),
            "second heartbeat must short-circuit, got {:?}",
            out2.error
        );
        let out1 = h1.await.unwrap();
        assert!(out1.brain_updated, "first heartbeat must complete normally");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_validate_drops_when_heading_missing() {
        let bad = "## What I'm watching\n- foo [a.md]\n";
        let res = validate_and_ground(bad, "");
        assert!(res.is_empty(), "missing 4/5 headings → drop");
    }

    #[test]
    fn test_seed_brain_has_all_sections() {
        let s = seed_brain_doc(Utc::now());
        for h in REQUIRED_HEADINGS {
            assert!(s.contains(h), "seed missing {}", h);
        }
    }

    #[test]
    fn test_parse_proposal_line() {
        let (k, s, sum) = parse_proposal_line("type=decision slug=pricing-lock confirm $20");
        assert_eq!(k, "decision");
        assert_eq!(s, "pricing-lock");
        assert_eq!(sum, "confirm $20");
    }

    #[test]
    fn test_proposal_written_to_disk() {
        // === v2.5 review wire ===
        // v2.5 §1: decision proposals now land in `team/decisions/{slug}.md`
        // (not `agi/proposals/decision-{slug}-{date}.md`) and a review
        // sidecar is initialized alongside.
        let root = tmp_root();
        let resp = "PROPOSAL: type=decision slug=pricing-lock confirm pricing\n";
        let n = write_proposals(&root, resp, Utc::now()).unwrap();
        assert_eq!(n, 1);
        let dir = root.join("team/decisions");
        let files: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(files.iter().any(|f| f == "pricing-lock.md"));
        assert!(
            files.iter().any(|f| f == "pricing-lock.md.review.json"),
            "review sidecar must be initialized alongside the draft atom"
        );
        // Non-decision kinds keep the legacy path.
        let resp2 = "PROPOSAL: type=notification slug=heads-up something\n";
        write_proposals(&root, resp2, Utc::now()).unwrap();
        let legacy_dir = root.join("agi/proposals");
        let legacy_files: Vec<_> = std::fs::read_dir(&legacy_dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(legacy_files.iter().any(|f| f.starts_with("notification-heads-up-")));
        // === end v2.5 review wire ===
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_scan_atoms_skips_agi_subtree() {
        let root = tmp_root();
        touch_atom(&root, "agi/observations/2026-04-26.md", "self");
        touch_atom(&root, "decisions/x.md", "---\n---\nbody");
        let atoms = scan_atoms_since(&root, Utc::now() - chrono::Duration::hours(1));
        assert!(
            atoms.iter().all(|a| !a.rel_path.starts_with("agi/")),
            "agi/ subtree must not be self-fed"
        );
        assert!(atoms.iter().any(|a| a.rel_path == "decisions/x.md"));
        let _ = std::fs::remove_dir_all(&root);
    }

    // === wave 6 === BUG #1 — brain doc now at team/co-thinker.md; verify
    // it is excluded from atom scans (otherwise the heartbeat would feed
    // its own previous tick output back into itself).
    #[test]
    fn test_scan_atoms_skips_team_brain_doc() {
        let root = tmp_root();
        touch_atom(&root, "team/co-thinker.md", "self");
        // Other team/ atoms (decisions in team mode) must still be picked up.
        touch_atom(&root, "team/decisions/y.md", "---\n---\nbody");
        let atoms = scan_atoms_since(&root, Utc::now() - chrono::Duration::hours(1));
        assert!(
            atoms.iter().all(|a| a.rel_path != "team/co-thinker.md"),
            "team/co-thinker.md must be excluded from self-feed"
        );
        assert!(atoms.iter().any(|a| a.rel_path == "team/decisions/y.md"));
        let _ = std::fs::remove_dir_all(&root);
    }

    // === wave 6 === BUG #1 — read_brain_doc must lazy-migrate from the
    // legacy agi/co-thinker.md to team/co-thinker.md so existing v1.9.2
    // installs don't lose their brain on upgrade.
    #[test]
    fn test_read_brain_doc_lazy_migrates_from_legacy_path() {
        let root = tmp_root();
        let legacy = root.join("agi").join("co-thinker.md");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        let user_content = "# my hand-edited brain\n\n## What I'm watching\n- a [x.md]\n";
        std::fs::write(&legacy, user_content).unwrap();
        let engine = CoThinkerEngine::new(root.clone());
        let read = engine.read_brain_doc().unwrap();
        assert_eq!(read, user_content);
        // Migration: the new path now exists with the same content.
        let new_path = root.join("team").join("co-thinker.md");
        assert!(new_path.exists());
        let new_content = std::fs::read_to_string(&new_path).unwrap();
        assert_eq!(new_content, user_content);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_scan_atoms_includes_canvas_subtree() {
        // Phase 4-C: canvas/ files become first-class atoms the brain can see.
        let root = tmp_root();
        touch_atom(&root, "canvas/tangerine/sync.md", "---\n---\n\n## Sticky stk-1\n");
        let atoms = scan_atoms_since(&root, Utc::now() - chrono::Duration::hours(1));
        assert!(
            atoms.iter().any(|a| a.rel_path == "canvas/tangerine/sync.md"),
            "canvas/ atoms must be visible to the heartbeat"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_is_canvas_sentinel_recognizes_both_kinds() {
        assert!(is_canvas_sentinel(
            "THROW_STICKY: project=p topic=t body=hello color=yellow"
        ));
        assert!(is_canvas_sentinel(
            "  COMMENT_STICKY: project=p topic=t sticky_id=stk-1 body=hi"
        ));
        assert!(!is_canvas_sentinel("- regular bullet"));
        assert!(!is_canvas_sentinel("PROPOSAL: type=decision slug=x"));
    }

    #[test]
    fn test_canvas_sentinel_dropped_from_brain_doc() {
        // Validator must strip the sentinels so they don't end up in brain.md.
        let resp = "# Tangerine Co-Thinker\nLast: ...\n\n## What I'm watching\n- foo [a.md]\n\n## Active threads\n- t [a.md]\n\n## My todo (next 24h, ranked)\n- [ ] x [a.md]\n\n## Recent reasoning\n- y [a.md]\n\n## Cited atoms (grounding)\n- [a.md]\n\nTHROW_STICKY: project=p topic=t body=hello color=yellow\n";
        let cleaned = validate_and_ground(resp, "");
        assert!(!cleaned.is_empty());
        assert!(!cleaned.contains("THROW_STICKY"));
        assert!(cleaned.contains("foo [a.md]"));
    }

    #[test]
    fn test_parse_canvas_kv_handles_spaces_in_body() {
        let kv = parse_canvas_kv(" project=tangerine topic=weekly-sync body=Reminder David promised follow-up by Fri color=yellow");
        assert_eq!(kv.get("project").map(|s| s.as_str()), Some("tangerine"));
        assert_eq!(kv.get("topic").map(|s| s.as_str()), Some("weekly-sync"));
        assert_eq!(
            kv.get("body").map(|s| s.as_str()),
            Some("Reminder David promised follow-up by Fri")
        );
        assert_eq!(kv.get("color").map(|s| s.as_str()), Some("yellow"));
    }

    #[tokio::test]
    async fn test_apply_canvas_sentinels_throws_a_sticky() {
        let root = tmp_root();
        let resp = "THROW_STICKY: project=ph4 topic=test body=hello world color=yellow\n";
        let anchors = apply_canvas_sentinels(&root, resp, Utc::now()).await;
        assert_eq!(anchors.len(), 1);
        assert_eq!(anchors[0].project, "ph4");
        assert_eq!(anchors[0].topic, "test");
        assert_eq!(anchors[0].kind, "throw");
        assert_eq!(anchors[0].sticky_id.len(), 12);
        // Verify the sticky landed in the test memory root (NOT the user's
        // real ~/.tangerine-memory).
        let p = root.join("canvas/ph4/test.md");
        assert!(p.exists(), "canvas topic file should exist after THROW_STICKY");
        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(raw.contains("hello world"));
        assert!(raw.contains("\"is_agi\":true"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_apply_canvas_sentinels_skips_malformed() {
        let root = tmp_root();
        let resp = "THROW_STICKY: project=p\nTHROW_STICKY: topic=only-topic body=incomplete\n";
        let anchors = apply_canvas_sentinels(&root, resp, Utc::now()).await;
        assert!(
            anchors.is_empty(),
            "missing fields → no anchor + no sticky written"
        );
        // Canvas dir should not exist at all (no successful writes).
        assert!(!root.join("canvas").exists() || std::fs::read_dir(root.join("canvas")).map(|d| d.count()).unwrap_or(0) == 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_append_canvas_reasoning_anchors_inserts_under_recent_reasoning() {
        let root = tmp_root();
        let brain = root.join("brain.md");
        let seed = "# Brain\n\n## What I'm watching\n- a [x.md]\n\n## Recent reasoning\n- earlier [x.md]\n\n## Cited atoms (grounding)\n- [x.md]\n";
        std::fs::write(&brain, seed).unwrap();
        let anchors = vec![CanvasReasoningAnchor {
            project: "p".into(),
            topic: "t".into(),
            sticky_id: "agi-abcd".into(),
            kind: "throw".into(),
            blurb: "hi there".into(),
        }];
        append_canvas_reasoning_anchors(&brain, &anchors).unwrap();
        let raw = std::fs::read_to_string(&brain).unwrap();
        assert!(raw.contains("[sticky:p/t/agi-abcd]"));
        // Should appear BEFORE the existing "earlier" entry (we insert
        // immediately after the heading).
        let sticky_pos = raw.find("[sticky:p/t/agi-abcd]").unwrap();
        let earlier_pos = raw.find("earlier").unwrap();
        assert!(sticky_pos < earlier_pos);
        let _ = std::fs::remove_dir_all(&root);
    }

    // === Wave 3 — corruption recovery tests (OBSERVABILITY_SPEC §8) ===

    #[test]
    fn corrupt_sniff_flags_empty_file() {
        assert!(is_brain_corrupt(""));
        assert!(is_brain_corrupt("   \n\n  \t"));
    }

    #[test]
    fn corrupt_sniff_flags_git_conflict_markers() {
        let raw = "# Brain\n<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>> branch\n";
        assert!(is_brain_corrupt(raw));
    }

    #[test]
    fn corrupt_sniff_flags_no_heading() {
        assert!(is_brain_corrupt("just some text\nno heading\n"));
    }

    #[test]
    fn corrupt_sniff_passes_healthy_brain() {
        let raw = seed_brain_doc(Utc::now());
        assert!(!is_brain_corrupt(&raw));
    }

    #[test]
    fn recover_quarantines_and_regenerates() {
        let root = tmp_root();
        let engine = CoThinkerEngine::new(root.clone());
        // Plant a corrupt brain.
        let brain_path = engine.brain_doc_path();
        std::fs::create_dir_all(brain_path.parent().unwrap()).unwrap();
        std::fs::write(&brain_path, "garbage\n<<<<<<< HEAD\noops").unwrap();
        let outcome = engine.recover_from_corrupt().unwrap();
        assert!(outcome.regenerated);
        assert!(outcome.quarantined.is_some());
        let q = outcome.quarantined.unwrap();
        assert!(q.exists());
        // New brain is the seed.
        let new_raw = std::fs::read_to_string(&brain_path).unwrap();
        assert!(!is_brain_corrupt(&new_raw));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn recover_noop_on_healthy_brain() {
        let root = tmp_root();
        let engine = CoThinkerEngine::new(root.clone());
        let brain_path = engine.brain_doc_path();
        std::fs::create_dir_all(brain_path.parent().unwrap()).unwrap();
        std::fs::write(&brain_path, seed_brain_doc(Utc::now())).unwrap();
        let outcome = engine.recover_from_corrupt().unwrap();
        assert!(!outcome.regenerated);
        assert!(outcome.quarantined.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn recover_noop_on_absent_file() {
        let root = tmp_root();
        let engine = CoThinkerEngine::new(root.clone());
        let outcome = engine.recover_from_corrupt().unwrap();
        assert!(!outcome.regenerated);
        assert!(outcome.quarantined.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }
}
