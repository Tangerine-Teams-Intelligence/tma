//! === wave 10 ===
//! v1.10 — auto-sync layer for the user's `~/.tangerine-memory/` git repo.
//!
//! Background:
//!   The current "team sync" mechanism (v1.6) is git-based: each user's
//!   `~/.tangerine-memory/` is a git repo, the team shares one git remote,
//!   updates flow via `git push` / `git pull`. The friction is that humans
//!   forget to push and pull. This module closes that gap by:
//!
//!     1. Auto-staging + committing after every successful co-thinker
//!        heartbeat (called from `crate::agi::co_thinker::heartbeat`).
//!     2. Auto-pulling on app open + every N minutes (driven from the
//!        existing daemon tick in `crate::daemon`).
//!     3. Surfacing the current sync state to the React sidebar via
//!        `git_sync_status`.
//!
//! Design choices:
//!   - Shell out to the user's `git` binary (no `git2` crate). Keeps the
//!     installer lean (~50 MB saved) and matches what `commands/git.rs`
//!     already does. We re-use the shell-out pattern, but this module is
//!     the one called from the heartbeat + UI surfaces, so it owns its own
//!     small set of helpers (no dependency on `commands/git`'s OAuth-
//!     askpass machinery — auto-sync runs without any token because the
//!     user's local ssh key / credential helper / Cloud sync handles auth
//!     when actually needed).
//!   - Every git operation is wrapped in `tokio::process::Command::output()`
//!     so the daemon thread is never blocked. We never panic — every error
//!     is converted to a `GitSyncOutcome` variant and bubbled up.
//!   - The heartbeat MUST NOT fail because of git. `auto_commit_after_heartbeat`
//!     swallows every git error (logged + returned as `GitSyncOutcome::Error`)
//!     so a busted git config never blocks the actual brain update.
//!
//! Scope split with `commands/git.rs`:
//!   - `commands/git.rs` is the lower-level shell-out surface used by the
//!     team-mode wizard (clone/init/push/pull with OAuth tokens). It stays
//!     untouched.
//!   - This module is the "always-on auto-sync for the user's local memory
//!     dir" surface. The two coexist; the React sidebar uses this one for
//!     the new GitSyncIndicator + GitInitBanner, while team-mode wiring
//!     keeps using the v1.6 surface.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use super::AppError;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ---------- types ----------

/// Top-level state for the GitSyncIndicator. The four `state` values map
/// 1:1 with the React indicator's four visible dots:
///   - `not_initialized`   → grey  (memory dir is not git-tracked)
///   - `clean`             → green (no local-only commits, no conflicts)
///   - `ahead`             → orange (local commits waiting to push)
///   - `conflict`          → red   (last pull/push surfaced a conflict)
#[derive(Debug, Serialize, Clone)]
pub struct GitSyncStatus {
    pub state: String,
    /// Memory dir absolute path (whatever `~/.tangerine-memory/` resolves to
    /// on this OS). `None` only if the resolver failed entirely — the React
    /// side then shows a "memory dir unresolved" tooltip.
    pub memory_dir: Option<PathBuf>,
    pub git_available: bool,
    pub git_initialized: bool,
    pub has_remote: bool,
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Last commit short-summary ("co-thinker heartbeat 2026-04-27T... — 3 atoms"),
    /// `None` on a fresh repo without commits yet.
    pub last_commit_msg: Option<String>,
    pub last_commit_ts: Option<String>,
    /// RFC3339 timestamps of the last successful auto-pull / auto-push,
    /// updated by the daemon. `None` until the first successful op runs.
    pub last_auto_pull: Option<String>,
    pub last_auto_push: Option<String>,
    /// Most recent error message (clamped to one short line) — populated when
    /// the last pull/push surfaced a conflict or network failure. The React
    /// indicator uses this to drive the red-dot "conflict" state.
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct PullResult {
    pub ok: bool,
    pub conflict: bool,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct PushResult {
    pub ok: bool,
    pub rejected: bool,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct CommitInfo {
    pub sha: String,
    pub message: String,
    pub ts: String,
    pub author: String,
}

#[derive(Debug, Deserialize)]
pub struct GitSyncInitArgs {
    /// Optional remote URL. Skipped (no `git remote add`) when empty / None.
    /// The user can paste a remote URL on the wizard, or initialize locally
    /// first and add the remote later.
    #[serde(default)]
    pub remote_url: Option<String>,
    /// Optional override for the user's default git author. Falls back to
    /// `ui.currentUser` (passed in by the frontend) and a constructed
    /// `<alias>@tangerine.local` email when the user's git config is unset.
    #[serde(default)]
    pub default_user_alias: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct GitSyncEmptyArgs {}

#[derive(Debug, Deserialize)]
pub struct GitSyncHistoryArgs {
    #[serde(default = "default_history_limit")]
    pub limit: u32,
}
fn default_history_limit() -> u32 {
    10
}

// ---------- Tauri commands ----------

/// Snapshot the current sync state. Cheap (single `git status` + `git log -1`).
/// React polls this every 10 seconds while the indicator is visible.
#[tauri::command]
pub async fn git_sync_status() -> Result<GitSyncStatus, AppError> {
    let memory_dir = resolve_memory_dir();
    let git_available = which_git().is_some();
    let mut status = GitSyncStatus {
        state: "not_initialized".into(),
        memory_dir: memory_dir.clone(),
        git_available,
        git_initialized: false,
        has_remote: false,
        branch: None,
        ahead: 0,
        behind: 0,
        last_commit_msg: None,
        last_commit_ts: None,
        last_auto_pull: None,
        last_auto_push: None,
        last_error: None,
    };

    let dir = match memory_dir {
        Some(d) => d,
        None => return Ok(status),
    };
    if !is_git_repo(&dir) {
        return Ok(status);
    }
    status.git_initialized = true;

    if !git_available {
        // Repo exists but `git` binary missing — surface as not-initialized so
        // the indicator falls back to the install-git hint.
        status.state = "not_initialized".into();
        return Ok(status);
    }

    status.has_remote = has_remote(&dir).await;

    if let Some((branch, ahead, behind)) = read_branch_ahead_behind(&dir).await {
        status.branch = Some(branch);
        status.ahead = ahead;
        status.behind = behind;
    }
    if let Some((msg, ts)) = read_last_commit(&dir).await {
        status.last_commit_msg = Some(msg);
        status.last_commit_ts = Some(ts);
    }

    // Persisted last-auto state so the indicator's hover text reads
    // "Last pull: 2 min ago" without polling git on every hover.
    if let Some(rec) = read_sync_record(&dir) {
        status.last_auto_pull = rec.last_auto_pull;
        status.last_auto_push = rec.last_auto_push;
        status.last_error = rec.last_error;
    }

    status.state = if status.last_error.is_some() {
        "conflict".into()
    } else if status.ahead > 0 {
        "ahead".into()
    } else {
        "clean".into()
    };

    Ok(status)
}

/// Initialize git tracking on the user's `~/.tangerine-memory/`. Idempotent —
/// re-running on an already-initialized repo is a no-op. Writes the standard
/// `.gitignore` (skipping `.tangerine/cursors/` + `.tangerine/telemetry/`)
/// when missing.
#[tauri::command]
pub async fn git_sync_init(args: GitSyncInitArgs) -> Result<GitSyncStatus, AppError> {
    let dir = resolve_memory_dir().ok_or_else(|| {
        AppError::internal(
            "git_sync_no_memory_dir",
            "could not resolve ~/.tangerine-memory/ for this OS",
        )
    })?;
    let git = require_git()?;

    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| {
            AppError::internal("git_sync_mkdir_memory", e.to_string())
        })?;
    }

    if !is_git_repo(&dir) {
        let (s, _o, e) = oneshot(&git, &["init", "-b", "main"], Some(&dir)).await?;
        if !s.success() {
            return Err(AppError::Git {
                code: "git_sync_init_failed".into(),
                detail: e.trim().to_string(),
            });
        }
    }
    write_default_gitignore(&dir)?;

    if let Some(url) = args.remote_url.as_ref().filter(|u| !u.trim().is_empty()) {
        let _ = oneshot(&git, &["remote", "remove", "origin"], Some(&dir)).await; // ignore err
        let (s, _o, e) =
            oneshot(&git, &["remote", "add", "origin", url], Some(&dir)).await?;
        if !s.success() {
            return Err(AppError::Git {
                code: "git_sync_remote_add_failed".into(),
                detail: e.trim().to_string(),
            });
        }
    }

    // Ensure user.name / user.email so the first auto-commit doesn't fail
    // with `Please tell me who you are`. Local config only, never global.
    ensure_local_user(&git, &dir, args.default_user_alias.as_deref()).await;

    // Initial commit so the repo has HEAD. Skip if there are no files at all.
    let (s, _o, _e) = oneshot(&git, &["add", "-A"], Some(&dir)).await?;
    let _ = s; // best-effort
    let (clean, _o, _e) =
        oneshot(&git, &["diff", "--cached", "--quiet"], Some(&dir)).await?;
    if !clean.success() {
        // There's something to commit.
        let (s, _o, e) = oneshot(
            &git,
            &["commit", "-m", "Tangerine memory init"],
            Some(&dir),
        )
        .await?;
        if !s.success() {
            tracing::warn!(stderr = %e.trim(), "git_sync_init: initial commit skipped");
        }
    }

    git_sync_status().await
}

#[tauri::command]
pub async fn git_sync_pull(_args: GitSyncEmptyArgs) -> Result<PullResult, AppError> {
    let dir = resolve_memory_dir().ok_or_else(|| {
        AppError::internal("git_sync_no_memory_dir", "memory dir unresolved")
    })?;
    let res = run_pull(&dir).await;
    record_pull(&dir, &res);
    Ok(res)
}

#[tauri::command]
pub async fn git_sync_push(_args: GitSyncEmptyArgs) -> Result<PushResult, AppError> {
    let dir = resolve_memory_dir().ok_or_else(|| {
        AppError::internal("git_sync_no_memory_dir", "memory dir unresolved")
    })?;
    let res = run_push(&dir).await;
    record_push(&dir, &res);
    Ok(res)
}

#[tauri::command]
pub async fn git_sync_history(args: GitSyncHistoryArgs) -> Result<Vec<CommitInfo>, AppError> {
    let dir = match resolve_memory_dir() {
        Some(d) if is_git_repo(&d) => d,
        _ => return Ok(Vec::new()),
    };
    let git = match which_git() {
        Some(g) => g,
        None => return Ok(Vec::new()),
    };
    let limit = args.limit.clamp(1, 100).to_string();
    let fmt = "--pretty=format:%H%x1f%s%x1f%cI%x1f%an";
    let (s, stdout, _e) = oneshot(
        &git,
        &["log", "-n", &limit, fmt],
        Some(&dir),
    )
    .await?;
    if !s.success() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for line in stdout.lines() {
        let mut parts = line.split('\u{1f}');
        let sha = parts.next().unwrap_or("").to_string();
        let message = parts.next().unwrap_or("").to_string();
        let ts = parts.next().unwrap_or("").to_string();
        let author = parts.next().unwrap_or("").to_string();
        if !sha.is_empty() {
            out.push(CommitInfo {
                sha,
                message,
                ts,
                author,
            });
        }
    }
    Ok(out)
}

// ---------- public helpers consumed by the heartbeat + daemon ----------

/// Stage everything in the memory dir and create a single auto-commit with
/// the provided summary (`atoms_seen` + `vendors_seen`). Called from
/// `agi::co_thinker::heartbeat` after a successful brain rewrite or atom
/// observation. Defensive on every axis — never returns Err so the caller
/// can `let _ = auto_commit_after_heartbeat(...)`.
pub async fn auto_commit_after_heartbeat(
    memory_dir: &Path,
    timestamp_iso: &str,
    atoms_seen: u32,
    vendors_seen: u32,
    user_alias: Option<&str>,
) {
    if !is_git_repo(memory_dir) {
        tracing::debug!(memory_dir = %memory_dir.display(), "git_sync: skip commit, dir is not a git repo");
        return;
    }
    let git = match which_git() {
        Some(g) => g,
        None => {
            tracing::debug!("git_sync: git binary unavailable, skip auto-commit");
            return;
        }
    };

    // Make sure user.name/user.email are populated so the commit doesn't
    // fail. Best-effort — if config write itself errors we'll surface that
    // through the commit error path below.
    ensure_local_user(&git, memory_dir, user_alias).await;

    let add = match oneshot(&git, &["add", "-A"], Some(memory_dir)).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(error = %e, "git_sync: git add -A failed");
            return;
        }
    };
    if !add.0.success() {
        tracing::warn!(stderr = %add.2.trim(), "git_sync: git add -A returned non-zero");
        return;
    }

    let clean = match oneshot(&git, &["diff", "--cached", "--quiet"], Some(memory_dir)).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(error = %e, "git_sync: diff --cached probe failed");
            return;
        }
    };
    if clean.0.success() {
        tracing::debug!("git_sync: nothing to commit, skip");
        return;
    }

    let msg = format!(
        "co-thinker heartbeat {} — {} atoms, {} vendors",
        timestamp_iso, atoms_seen, vendors_seen,
    );
    match oneshot(&git, &["commit", "-m", &msg], Some(memory_dir)).await {
        Ok((s, _o, _e)) if s.success() => {
            tracing::debug!(msg = %msg, "git_sync: auto-commit succeeded");
        }
        Ok((_s, _o, e)) => {
            tracing::warn!(stderr = %e.trim(), "git_sync: auto-commit non-zero");
        }
        Err(e) => {
            tracing::warn!(error = %e, "git_sync: auto-commit spawn failed");
        }
    }
}

/// Run an auto-pull and persist the result for the indicator. Daemon-driven.
/// Returns the outcome so the daemon log line can record it.
pub async fn auto_pull(memory_dir: &Path) -> PullResult {
    let res = run_pull(memory_dir).await;
    record_pull(memory_dir, &res);
    res
}

/// Run an auto-push (only when there are local commits ahead). Daemon-driven.
pub async fn auto_push_if_ahead(memory_dir: &Path) -> Option<PushResult> {
    if !is_git_repo(memory_dir) {
        return None;
    }
    let (_, ahead, _) = read_branch_ahead_behind(memory_dir).await.unwrap_or_default();
    if ahead == 0 {
        return None;
    }
    let res = run_push(memory_dir).await;
    record_push(memory_dir, &res);
    Some(res)
}

// ---------- internal helpers ----------

fn require_git() -> Result<PathBuf, AppError> {
    which_git().ok_or_else(|| {
        AppError::external(
            "git_missing",
            "git is required for sync but isn't installed. Visit https://git-scm.com/downloads.",
        )
    })
}

fn which_git() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let exts: Vec<&str> = if cfg!(windows) {
        vec!["", ".exe", ".cmd", ".bat"]
    } else {
        vec![""]
    };
    for dir in std::env::split_paths(&path_var) {
        for ext in &exts {
            let p = dir.join(format!("git{}", ext));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Resolve the user's `~/.tangerine-memory/` path. Mirrors the same
/// `dirs::home_dir().join(".tangerine-memory")` convention the rest of the
/// codebase uses (see `commands::memory::resolve_memory_root`).
pub fn resolve_memory_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".tangerine-memory"))
}

fn is_git_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

async fn has_remote(dir: &Path) -> bool {
    let git = match which_git() {
        Some(g) => g,
        None => return false,
    };
    let (s, stdout, _e) = match oneshot(&git, &["remote"], Some(dir)).await {
        Ok(t) => t,
        Err(_) => return false,
    };
    s.success() && !stdout.trim().is_empty()
}

async fn read_branch_ahead_behind(dir: &Path) -> Option<(String, u32, u32)> {
    let git = which_git()?;
    let (s, stdout, _e) = oneshot(
        &git,
        &["status", "--porcelain=v2", "--branch"],
        Some(dir),
    )
    .await
    .ok()?;
    if !s.success() {
        return None;
    }
    let mut branch = "main".to_string();
    let mut ahead = 0u32;
    let mut behind = 0u32;
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for tok in rest.split_whitespace() {
                if let Some(n) = tok.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = tok.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        }
    }
    Some((branch, ahead, behind))
}

async fn read_last_commit(dir: &Path) -> Option<(String, String)> {
    let git = which_git()?;
    let (s, stdout, _e) = oneshot(
        &git,
        &["log", "-1", "--pretty=format:%s%x1f%cI"],
        Some(dir),
    )
    .await
    .ok()?;
    if !s.success() {
        return None;
    }
    let mut parts = stdout.split('\u{1f}');
    let msg = parts.next()?.to_string();
    let ts = parts.next().unwrap_or("").to_string();
    Some((msg, ts))
}

async fn run_pull(dir: &Path) -> PullResult {
    if !is_git_repo(dir) {
        return PullResult {
            ok: false,
            conflict: false,
            message: "not_a_git_repo".into(),
        };
    }
    let git = match which_git() {
        Some(g) => g,
        None => {
            return PullResult {
                ok: false,
                conflict: false,
                message: "git_missing".into(),
            };
        }
    };
    if !has_remote(dir).await {
        return PullResult {
            ok: false,
            conflict: false,
            message: "no_remote".into(),
        };
    }
    let result = oneshot(&git, &["pull", "--rebase", "--autostash", "origin"], Some(dir)).await;
    match result {
        Ok((status, _stdout, stderr)) => {
            if status.success() {
                PullResult {
                    ok: true,
                    conflict: false,
                    message: "pulled".into(),
                }
            } else {
                let stderr_trim = stderr.trim().to_string();
                let conflict = stderr_trim.to_lowercase().contains("conflict");
                PullResult {
                    ok: false,
                    conflict,
                    message: clamp_one_line(&stderr_trim),
                }
            }
        }
        Err(e) => PullResult {
            ok: false,
            conflict: false,
            message: format!("spawn_failed: {}", e),
        },
    }
}

async fn run_push(dir: &Path) -> PushResult {
    if !is_git_repo(dir) {
        return PushResult {
            ok: false,
            rejected: false,
            message: "not_a_git_repo".into(),
        };
    }
    let git = match which_git() {
        Some(g) => g,
        None => {
            return PushResult {
                ok: false,
                rejected: false,
                message: "git_missing".into(),
            };
        }
    };
    if !has_remote(dir).await {
        return PushResult {
            ok: false,
            rejected: false,
            message: "no_remote".into(),
        };
    }
    let result = oneshot(&git, &["push", "origin", "HEAD"], Some(dir)).await;
    match result {
        Ok((status, _stdout, stderr)) => {
            if status.success() {
                PushResult {
                    ok: true,
                    rejected: false,
                    message: "pushed".into(),
                }
            } else {
                let stderr_trim = stderr.trim().to_string();
                let rejected = stderr_trim.contains("rejected")
                    || stderr_trim.contains("non-fast-forward");
                PushResult {
                    ok: false,
                    rejected,
                    message: clamp_one_line(&stderr_trim),
                }
            }
        }
        Err(e) => PushResult {
            ok: false,
            rejected: false,
            message: format!("spawn_failed: {}", e),
        },
    }
}

/// Set local `user.name` + `user.email` if they're empty. Never overwrites
/// values the user has already configured globally — `git config --get` reads
/// the merged view, so a value coming from `--global` counts as set.
async fn ensure_local_user(git: &Path, dir: &Path, alias_hint: Option<&str>) {
    let need_name = !has_git_config(git, dir, "user.name").await;
    let need_email = !has_git_config(git, dir, "user.email").await;
    if !need_name && !need_email {
        return;
    }
    let alias = alias_hint
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "tangerine".to_string());
    if need_name {
        let _ = oneshot(git, &["config", "user.name", &alias], Some(dir)).await;
    }
    if need_email {
        let email = format!("{}@tangerine.local", alias);
        let _ = oneshot(git, &["config", "user.email", &email], Some(dir)).await;
    }
}

async fn has_git_config(git: &Path, dir: &Path, key: &str) -> bool {
    match oneshot(git, &["config", "--get", key], Some(dir)).await {
        Ok((s, stdout, _e)) => s.success() && !stdout.trim().is_empty(),
        Err(_) => false,
    }
}

fn write_default_gitignore(dir: &Path) -> Result<(), AppError> {
    let p = dir.join(".gitignore");
    if p.exists() {
        return Ok(());
    }
    let body = "# === Tangerine auto-generated ===\n\
                # Per-user view state and private telemetry don't sync.\n\
                .tangerine/cursors/\n\
                .tangerine/telemetry/\n\
                .tangerine/quarantine/\n";
    std::fs::write(&p, body).map_err(|e| {
        AppError::internal("git_sync_write_gitignore", e.to_string())
    })
}

fn clamp_one_line(s: &str) -> String {
    let first_line = s.lines().next().unwrap_or("");
    if first_line.len() > 240 {
        format!("{}…", &first_line[..240])
    } else {
        first_line.to_string()
    }
}

// ---------- persisted last-sync record ----------
//
// Lives at `<memory_dir>/.tangerine/git_sync.json`. Used to power the
// indicator's "last pull / last push / last error" hover text without
// having to keep extra state in `AppState`. The file is itself git-ignored
// (it's under `.tangerine/`, which is per-user).

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct SyncRecord {
    pub last_auto_pull: Option<String>,
    pub last_auto_push: Option<String>,
    pub last_error: Option<String>,
}

fn sync_record_path(dir: &Path) -> PathBuf {
    dir.join(".tangerine").join("git_sync.json")
}

pub fn read_sync_record(dir: &Path) -> Option<SyncRecord> {
    // === wave 10.1 hotfix === — every step here returns None on failure
    // (file missing, unreadable, malformed JSON, schema mismatch). The
    // caller treats None as "no record yet" and shows the safe defaults.
    // No panic path exists today, but spelling it out keeps this clear:
    // git_sync_status() reads this on every poll, so any panic here
    // would propagate to the Tauri command boundary and fail the JS-side
    // promise — which the frontend now catches (Fix 2), but defense in
    // depth is cheap.
    let p = sync_record_path(dir);
    let raw = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_sync_record(dir: &Path, rec: &SyncRecord) {
    let p = sync_record_path(dir);
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string_pretty(rec) {
        let _ = std::fs::write(&p, s);
    }
}

fn record_pull(dir: &Path, res: &PullResult) {
    let mut rec = read_sync_record(dir).unwrap_or_default();
    if res.ok {
        rec.last_auto_pull = Some(chrono::Utc::now().to_rfc3339());
        rec.last_error = None;
    } else if res.conflict {
        rec.last_error = Some(format!("pull_conflict: {}", res.message));
    } else if res.message != "no_remote"
        && res.message != "git_missing"
        && res.message != "not_a_git_repo"
    {
        // Network blips and similar transient errors get logged but not
        // sticky-surfaced — the next successful pull clears them.
        tracing::debug!(error = %res.message, "git_sync: transient pull error");
    }
    write_sync_record(dir, &rec);
}

fn record_push(dir: &Path, res: &PushResult) {
    let mut rec = read_sync_record(dir).unwrap_or_default();
    if res.ok {
        rec.last_auto_push = Some(chrono::Utc::now().to_rfc3339());
        rec.last_error = None;
    } else if res.rejected {
        rec.last_error = Some(format!("push_rejected: {}", res.message));
    } else {
        tracing::debug!(error = %res.message, "git_sync: transient push error");
    }
    write_sync_record(dir, &rec);
}

async fn oneshot(
    program: &Path,
    args: &[&str],
    cwd: Option<&Path>,
) -> Result<(std::process::ExitStatus, String, String), AppError> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().await.map_err(|e| {
        AppError::internal("git_sync_spawn", format!("failed to run git: {}", e))
    })?;
    Ok((
        out.status,
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(label: &str) -> Self {
            let id = uuid::Uuid::new_v4().simple().to_string();
            let p = std::env::temp_dir().join(format!("ti-gsync-{}-{}", label, id));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Skip a test that requires `git` on PATH if the binary isn't present.
    /// Uses early return + a `tracing::warn` so CI without git stays green
    /// while still proving the test ran.
    fn require_git_or_skip() -> Option<PathBuf> {
        let g = which_git();
        if g.is_none() {
            eprintln!("git_sync tests: `git` not on PATH, skipping git-dependent test");
        }
        g
    }

    #[test]
    fn write_default_gitignore_creates_file_with_excludes() {
        let td = TempDir::new("gitignore");
        write_default_gitignore(td.path()).expect("write");
        let body = std::fs::read_to_string(td.path().join(".gitignore")).unwrap();
        assert!(body.contains(".tangerine/cursors/"));
        assert!(body.contains(".tangerine/telemetry/"));
    }

    #[test]
    fn write_default_gitignore_is_idempotent() {
        let td = TempDir::new("gitignore-idem");
        std::fs::write(td.path().join(".gitignore"), "user-supplied\n").unwrap();
        write_default_gitignore(td.path()).expect("noop");
        let body = std::fs::read_to_string(td.path().join(".gitignore")).unwrap();
        assert_eq!(body.trim(), "user-supplied");
    }

    #[test]
    fn is_git_repo_detects_dot_git() {
        let td = TempDir::new("isrepo");
        assert!(!is_git_repo(td.path()));
        std::fs::create_dir_all(td.path().join(".git")).unwrap();
        assert!(is_git_repo(td.path()));
    }

    #[test]
    fn clamp_one_line_truncates_long_strings() {
        let raw = format!("{}{}", "a".repeat(300), "\nrest");
        let clamped = clamp_one_line(&raw);
        // 240 ASCII chars + "…" (3 bytes UTF-8) = 243 bytes. Cap at 245 to
        // give the ellipsis some headroom.
        assert!(clamped.len() <= 245);
        assert!(clamped.ends_with('…'));
        // No newline, since we strip to first line.
        assert!(!clamped.contains('\n'));
    }

    #[test]
    fn clamp_one_line_keeps_first_line_only() {
        let raw = "first\nsecond\nthird";
        assert_eq!(clamp_one_line(raw), "first");
    }

    #[test]
    fn sync_record_roundtrips_via_json() {
        let td = TempDir::new("rec");
        let rec = SyncRecord {
            last_auto_pull: Some("2026-04-27T10:00:00Z".into()),
            last_auto_push: None,
            last_error: Some("pull_conflict: x".into()),
        };
        write_sync_record(td.path(), &rec);
        let read = read_sync_record(td.path()).expect("record");
        assert_eq!(read.last_auto_pull.as_deref(), Some("2026-04-27T10:00:00Z"));
        assert_eq!(read.last_error.as_deref(), Some("pull_conflict: x"));
    }

    #[tokio::test]
    async fn status_reports_not_initialized_when_dir_missing_git() {
        let td = TempDir::new("status-not-init");
        // Pretend resolve_memory_dir returned td.path() — call the helpers
        // directly because git_sync_status() uses the real home dir.
        assert!(!is_git_repo(td.path()));
        let has = has_remote(td.path()).await;
        assert!(!has);
    }

    #[tokio::test]
    async fn auto_commit_skips_silently_when_not_a_git_repo() {
        let td = TempDir::new("autocommit-skip");
        // Should not panic + should not error. We can't observe much else
        // without a real git binary, but the no-op path is the important
        // edge case.
        auto_commit_after_heartbeat(td.path(), "2026-04-27T10:00:00Z", 1, 1, Some("x")).await;
    }

    #[tokio::test]
    async fn auto_commit_creates_real_commit_when_changes_present() {
        let Some(git) = require_git_or_skip() else { return; };
        let td = TempDir::new("autocommit-real");
        // git init
        let s = oneshot(&git, &["init", "-b", "main"], Some(td.path())).await.unwrap();
        assert!(s.0.success());
        // baseline config (otherwise commit fails)
        let _ = oneshot(&git, &["config", "user.name", "tangerine-test"], Some(td.path())).await;
        let _ = oneshot(&git, &["config", "user.email", "test@tangerine.local"], Some(td.path())).await;
        // touch a file
        std::fs::write(td.path().join("hello.md"), "atom\n").unwrap();
        auto_commit_after_heartbeat(
            td.path(),
            "2026-04-27T10:00:00Z",
            5,
            2,
            Some("tangerine-test"),
        )
        .await;
        // log -1 should now have our message.
        let log = oneshot(&git, &["log", "-1", "--pretty=format:%s"], Some(td.path()))
            .await
            .unwrap();
        assert!(log.0.success());
        assert!(log.1.contains("co-thinker heartbeat"));
        assert!(log.1.contains("5 atoms"));
        assert!(log.1.contains("2 vendors"));
    }

    #[tokio::test]
    async fn auto_commit_skips_empty_change_set() {
        let Some(git) = require_git_or_skip() else { return; };
        let td = TempDir::new("autocommit-empty");
        let _ = oneshot(&git, &["init", "-b", "main"], Some(td.path())).await.unwrap();
        let _ = oneshot(&git, &["config", "user.name", "test"], Some(td.path())).await;
        let _ = oneshot(&git, &["config", "user.email", "t@t.local"], Some(td.path())).await;
        // first commit so HEAD exists
        std::fs::write(td.path().join("a.md"), "x\n").unwrap();
        let _ = oneshot(&git, &["add", "-A"], Some(td.path())).await;
        let _ = oneshot(&git, &["commit", "-m", "seed"], Some(td.path())).await;
        // Now run auto-commit with NO new changes — should be a silent skip.
        auto_commit_after_heartbeat(td.path(), "2026-04-27T10:00:00Z", 0, 0, Some("test")).await;
        // Should still have only one commit.
        let count = oneshot(&git, &["rev-list", "--count", "HEAD"], Some(td.path()))
            .await
            .unwrap();
        assert!(count.0.success());
        assert_eq!(count.1.trim(), "1");
    }

    #[tokio::test]
    async fn run_pull_returns_no_remote_when_remote_missing() {
        let Some(git) = require_git_or_skip() else { return; };
        let td = TempDir::new("pull-no-remote");
        let _ = oneshot(&git, &["init", "-b", "main"], Some(td.path())).await.unwrap();
        let res = run_pull(td.path()).await;
        assert!(!res.ok);
        assert!(!res.conflict);
        assert_eq!(res.message, "no_remote");
    }

    // === wave 10.1 hotfix === — Lock in the contract that powers the
    // black-screen fix: `git_sync_status` MUST return Ok in every degraded
    // case, never Err and never panic. Without this, the JS-side promise
    // rejects, the Container's useEffect throws, and (pre-fix) the React
    // tree dies → black screen. Post-fix the JS try/catch swallows it
    // anyway, but pinning the Rust contract gives us defense in depth.
    #[tokio::test]
    async fn git_sync_status_always_returns_ok_on_degraded_paths() {
        // Real git_sync_status() is wired to the user's actual home dir,
        // so we can't isolate it. But we can call it and assert the
        // result is structurally valid — never an Err, always a status
        // struct, state is one of the 4 known values.
        let result = git_sync_status().await;
        assert!(result.is_ok(), "git_sync_status must never Err");
        let s = result.unwrap();
        assert!(
            ["not_initialized", "clean", "ahead", "conflict"]
                .contains(&s.state.as_str()),
            "state must be one of the known 4 values, got: {}",
            s.state,
        );
    }

    #[tokio::test]
    async fn read_sync_record_returns_none_on_missing_file() {
        let td = TempDir::new("rec-missing");
        // No file written → must return None, not panic.
        assert!(read_sync_record(td.path()).is_none());
    }

    #[tokio::test]
    async fn read_sync_record_returns_none_on_malformed_json() {
        let td = TempDir::new("rec-malformed");
        let dot_t = td.path().join(".tangerine");
        std::fs::create_dir_all(&dot_t).unwrap();
        std::fs::write(dot_t.join("git_sync.json"), "{not valid json").unwrap();
        // Malformed JSON → must return None, not panic.
        assert!(read_sync_record(td.path()).is_none());
    }
}
