//! Background memory sync ticker + token storage.
//!
//! Behaviours wired here:
//!   - `sync_start(repo_path, login)` arms a background loop that pulls
//!     every 5 minutes and pushes whenever a debounced "memory dirty"
//!     signal fires. The sample debounce window is 30s so a flurry of
//!     transcript writes coalesces into one commit.
//!   - `sync_kick()` is the hook the Discord transcript writer + AI
//!     auto-tagger call after they touch `memory/`. It bumps the debounce
//!     timer; the sync loop picks it up.
//!   - `sync_stop()` cleanly tears the loop down (used when the user
//!     switches from team mode back to solo).
//!   - `sync_status()` returns the last_pull / last_push timestamps and
//!     pending-changes count; the SyncStatusIndicator polls this every 5s.
//!
//! Token storage:
//!   - Primary: OS keychain via the `keyring` crate (Windows Credential
//!     Manager / macOS Keychain / Linux Secret Service).
//!   - Fallback: a plaintext `<app_data>/sync/credentials.json` with mode
//!     0600 on POSIX. On Windows we rely on the user-profile ACL (the file
//!     is under `%LOCALAPPDATA%\TangerineMeeting\sync\` which is already
//!     restricted to the user). README.md documents the trade-off.
//!
//! Important: the token NEVER crosses the IPC boundary. The frontend asks
//! for a `login` (the GitHub username); commands here look the secret up
//! locally and pass it to git via askpass.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};
use tokio::sync::Notify;

use super::{AppError, AppState};

const KEYRING_SERVICE: &str = "ai.tangerineintelligence.meeting/github";
const DEFAULT_PULL_INTERVAL: Duration = Duration::from_secs(5 * 60);
const DEFAULT_PUSH_DEBOUNCE: Duration = Duration::from_secs(30);

/// In-memory state of the running sync loop. Held inside an `Arc<Mutex<>>` so
/// the React side can ask for status without coordinating with the loop task.
#[derive(Debug, Clone, Default)]
pub struct SyncState {
    pub running: bool,
    pub repo_path: Option<PathBuf>,
    pub login: Option<String>,
    pub last_pull: Option<DateTime<Utc>>,
    pub last_push: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub pending_changes: u32,
}

#[derive(Debug, Default)]
pub struct SyncControl {
    state: Mutex<SyncState>,
    /// Bumped by the FS watcher / Discord writer to coalesce a push.
    dirty: Arc<Notify>,
    /// Bumped by `sync_stop` to break the loop deterministically.
    stop: Arc<Notify>,
    /// Last "dirty" wall-clock instant so the debounce timer is correct
    /// regardless of how the Notify futures interleave.
    last_kick: Mutex<Option<Instant>>,
}

impl SyncControl {
    pub fn snapshot(&self) -> SyncState {
        self.state.lock().clone()
    }
}

/// Token storage abstraction. Try OS keychain first; on any error we fall
/// through to a per-user JSON file and log loudly.
pub struct TokenStore;

impl TokenStore {
    pub fn set(login: &str, token: &str) -> Result<(), AppError> {
        if login.is_empty() {
            return Err(AppError::user(
                "missing_login",
                "GitHub login is required to store a token.",
            ));
        }
        match keyring::Entry::new(KEYRING_SERVICE, login) {
            Ok(e) => match e.set_password(token) {
                Ok(()) => return Ok(()),
                Err(err) => {
                    tracing::warn!(error = %err, login = login, "keychain set failed; falling back to file");
                }
            },
            Err(err) => {
                tracing::warn!(error = %err, login = login, "keychain entry init failed; falling back to file");
            }
        }
        Self::file_set(login, token)
    }

    pub fn get(login: &str) -> Result<String, AppError> {
        if login.is_empty() {
            return Err(AppError::user(
                "missing_login",
                "GitHub login is required to look up a token.",
            ));
        }
        if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, login) {
            if let Ok(t) = e.get_password() {
                return Ok(t);
            }
        }
        Self::file_get(login)
    }

    pub fn delete(login: &str) -> Result<(), AppError> {
        if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, login) {
            let _ = e.delete_password();
        }
        let _ = Self::file_delete(login);
        Ok(())
    }

    fn file_path(login: &str) -> Result<PathBuf, AppError> {
        let dir = file_root()?;
        Ok(dir.join(format!("{}.token", sanitize_login(login))))
    }

    fn file_set(login: &str, token: &str) -> Result<(), AppError> {
        let path = Self::file_path(login)?;
        std::fs::write(&path, token)
            .map_err(|e| AppError::internal("token_file_write", e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&path)
                .map_err(|e| AppError::internal("token_file_meta", e.to_string()))?
                .permissions();
            perms.set_mode(0o600);
            std::fs::set_permissions(&path, perms)
                .map_err(|e| AppError::internal("token_file_perm", e.to_string()))?;
        }
        Ok(())
    }

    fn file_get(login: &str) -> Result<String, AppError> {
        let path = Self::file_path(login)?;
        std::fs::read_to_string(&path).map_err(|e| {
            AppError::user("token_missing", format!("no stored token for {}: {}", login, e))
        })
    }

    fn file_delete(login: &str) -> Result<(), AppError> {
        let path = Self::file_path(login)?;
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| AppError::internal("token_file_remove", e.to_string()))?;
        }
        Ok(())
    }
}

fn file_root() -> Result<PathBuf, AppError> {
    #[cfg(windows)]
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")));
    #[cfg(not(windows))]
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("TangerineMeeting").join("sync");
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal("sync_dir_mkdir", e.to_string()))?;
    Ok(dir)
}

fn sanitize_login(login: &str) -> String {
    login
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

#[derive(Debug, Deserialize)]
pub struct SyncStartArgs {
    pub repo_path: PathBuf,
    pub login: String,
}

#[tauri::command]
pub async fn sync_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    args: SyncStartArgs,
) -> Result<(), AppError> {
    let control = state.sync.clone();
    {
        let mut s = control.state.lock();
        if s.running {
            return Ok(()); // idempotent
        }
        s.running = true;
        s.repo_path = Some(args.repo_path.clone());
        s.login = Some(args.login.clone());
        s.last_error = None;
    }
    let dirty = control.dirty.clone();
    let stop = control.stop.clone();
    let app_handle = app.clone();
    let repo = args.repo_path.clone();
    let login = args.login.clone();
    let control_for_loop = control.clone();
    tokio::spawn(async move {
        run_sync_loop(app_handle, control_for_loop, dirty, stop, repo, login).await;
    });
    // Initial pull on launch — don't block; the loop will catch up.
    let initial_repo = args.repo_path.clone();
    let initial_login = args.login.clone();
    let initial_control = control.clone();
    tokio::spawn(async move {
        let token = TokenStore::get(&initial_login).ok();
        match super::git::git_pull(super::git::GitRepoArgs {
            repo: initial_repo.clone(),
            token,
        })
        .await
        {
            Ok(_) => {
                let mut s = initial_control.state.lock();
                s.last_pull = Some(Utc::now());
            }
            Err(e) => {
                tracing::warn!(error = %e, "initial pull failed");
                let mut s = initial_control.state.lock();
                s.last_error = Some(format_err(&e));
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn sync_stop(state: State<'_, AppState>) -> Result<(), AppError> {
    let control = state.sync.clone();
    let was_running;
    {
        let mut s = control.state.lock();
        was_running = s.running;
        s.running = false;
    }
    if was_running {
        control.stop.notify_waiters();
    }
    Ok(())
}

/// Bumps the debounce timer. Called by writers (Discord transcript flush,
/// AI auto-tag). Safe to invoke at high frequency.
#[tauri::command]
pub async fn sync_kick(state: State<'_, AppState>) -> Result<(), AppError> {
    let control = state.sync.clone();
    {
        let mut last = control.last_kick.lock();
        *last = Some(Instant::now());
    }
    {
        let mut s = control.state.lock();
        s.pending_changes = s.pending_changes.saturating_add(1);
    }
    control.dirty.notify_waiters();
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct SyncStatusOut {
    pub running: bool,
    pub repo_path: Option<String>,
    pub login: Option<String>,
    pub last_pull: Option<String>,
    pub last_push: Option<String>,
    pub last_error: Option<String>,
    pub pending_changes: u32,
}

#[tauri::command]
pub async fn sync_status(state: State<'_, AppState>) -> Result<SyncStatusOut, AppError> {
    let snap = state.sync.snapshot();
    Ok(SyncStatusOut {
        running: snap.running,
        repo_path: snap.repo_path.map(|p| p.to_string_lossy().to_string()),
        login: snap.login,
        last_pull: snap.last_pull.map(|t| t.to_rfc3339()),
        last_push: snap.last_push.map(|t| t.to_rfc3339()),
        last_error: snap.last_error,
        pending_changes: snap.pending_changes,
    })
}

async fn run_sync_loop<R: Runtime>(
    _app: AppHandle<R>,
    control: Arc<SyncControl>,
    dirty: Arc<Notify>,
    stop: Arc<Notify>,
    repo: PathBuf,
    login: String,
) {
    let mut pull_interval = tokio::time::interval(DEFAULT_PULL_INTERVAL);
    pull_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // First tick fires immediately by default; we want to wait the full
    // interval so the explicit initial pull above isn't doubled up.
    pull_interval.tick().await;

    loop {
        tokio::select! {
            _ = stop.notified() => {
                let mut s = control.state.lock();
                s.running = false;
                break;
            }
            _ = pull_interval.tick() => {
                if !control.state.lock().running { break; }
                let token = TokenStore::get(&login).ok();
                match super::git::git_pull(super::git::GitRepoArgs {
                    repo: repo.clone(),
                    token,
                })
                .await
                {
                    Ok(_) => {
                        let mut s = control.state.lock();
                        s.last_pull = Some(Utc::now());
                        s.last_error = None;
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "scheduled pull failed");
                        let mut s = control.state.lock();
                        s.last_error = Some(format_err(&e));
                    }
                }
            }
            _ = dirty.notified() => {
                if !control.state.lock().running { break; }
                // Debounce: wait until last_kick is older than DEFAULT_PUSH_DEBOUNCE.
                loop {
                    let last = *control.last_kick.lock();
                    let elapsed = match last {
                        Some(t) => Instant::now().saturating_duration_since(t),
                        None => DEFAULT_PUSH_DEBOUNCE,
                    };
                    if elapsed >= DEFAULT_PUSH_DEBOUNCE { break; }
                    let wait = DEFAULT_PUSH_DEBOUNCE - elapsed;
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {}
                        _ = dirty.notified() => { /* loop again */ }
                        _ = stop.notified() => {
                            control.state.lock().running = false;
                            return;
                        }
                    }
                }
                if !control.state.lock().running { break; }
                let pending = {
                    let mut s = control.state.lock();
                    let n = s.pending_changes;
                    s.pending_changes = 0;
                    n
                };
                let token_for_commit = TokenStore::get(&login).ok();
                let commit_msg = format!(
                    "memory: {} write{}",
                    pending,
                    if pending == 1 { "" } else { "s" }
                );
                if let Err(e) = super::git::git_commit_all(super::git::GitCommitArgs {
                    repo: repo.clone(),
                    message: commit_msg,
                    path_spec: Some("memory".into()),
                })
                .await
                {
                    tracing::warn!(error = %e, "commit failed");
                    let mut s = control.state.lock();
                    s.last_error = Some(format_err(&e));
                    continue;
                }
                if let Err(e) = super::git::git_push(super::git::GitRepoArgs {
                    repo: repo.clone(),
                    token: token_for_commit.clone(),
                })
                .await
                {
                    tracing::warn!(error = %e, "push failed; attempting pull --rebase + retry");
                    // Auto-recover from the common case where another teammate pushed first.
                    if let Err(pull_err) = super::git::git_pull(super::git::GitRepoArgs {
                        repo: repo.clone(),
                        token: token_for_commit.clone(),
                    }).await {
                        tracing::warn!(error = %pull_err, "rescue pull failed");
                        let mut s = control.state.lock();
                        s.last_error = Some(format_err(&pull_err));
                        continue;
                    }
                    if let Err(retry_err) = super::git::git_push(super::git::GitRepoArgs {
                        repo: repo.clone(),
                        token: token_for_commit.clone(),
                    }).await {
                        let mut s = control.state.lock();
                        s.last_error = Some(format_err(&retry_err));
                        continue;
                    }
                }
                let mut s = control.state.lock();
                s.last_push = Some(Utc::now());
                s.last_error = None;
            }
        }
    }
}

fn format_err(e: &AppError) -> String {
    match e {
        AppError::User { detail, .. }
        | AppError::Config { detail, .. }
        | AppError::External { detail, .. }
        | AppError::Git { detail, .. }
        | AppError::Internal { detail, .. } => detail.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_unsafe() {
        // `.`, `/`, `..` and other path-shaped chars become `_` so a malicious
        // login can't escape the sync dir.
        assert_eq!(sanitize_login("daizhe"), "daizhe".to_string());
        assert_eq!(sanitize_login("../etc/passwd"), "___etc_passwd".to_string());
        assert_eq!(sanitize_login("dz-zou"), "dz-zou".to_string());
        assert!(!sanitize_login("a/b").contains('/'));
        assert!(!sanitize_login("../foo").contains('.'));
    }

    #[test]
    fn token_store_file_roundtrip() {
        let login = format!("__test_{}", uuid::Uuid::new_v4().simple());
        // Forcing the file path keeps the test independent of any keychain.
        TokenStore::file_set(&login, "ghp_TEST").unwrap();
        let got = TokenStore::file_get(&login).unwrap();
        assert_eq!(got, "ghp_TEST");
        TokenStore::file_delete(&login).unwrap();
        assert!(TokenStore::file_get(&login).is_err());
    }

    #[test]
    fn sync_state_default_is_idle() {
        let s = SyncState::default();
        assert!(!s.running);
        assert_eq!(s.pending_changes, 0);
        assert!(s.last_push.is_none());
    }

    #[test]
    fn empty_login_rejected() {
        assert!(TokenStore::set("", "tok").is_err());
        assert!(TokenStore::get("").is_err());
    }
}
