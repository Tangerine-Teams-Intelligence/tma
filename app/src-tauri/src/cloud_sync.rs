//! v2.5 §5 — Cloud sync infrastructure (STUB).
//!
//! The production cloud sync (real `git push/pull` against
//! `git.tangerine.cloud/{team_slug}.git`) lands in v2.5 final per V2_5_SPEC §5.
//! This module is the API skeleton: real network calls are replaced with
//! tracing logs so the React side can wire the settings page now and the
//! Rust transport can be filled in without a frontend churn later.
//!
//! ## Shape
//!
//! `CloudSyncConfig` is the persisted per-team settings blob. `init_cloud_repo`
//! is what runs on team creation; `pull_team_memory` / `push_team_memory`
//! get called from a heartbeat tick (every 6th tick, per spec §5.2).
//!
//! All TODO markers below tag the lines that need real network code in the
//! v2.5 production milestone. No `reqwest` / `git2` is invoked from here —
//! the stub only does config-shape work + logging.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::commands::AppError;

/// Per-team cloud sync config. Lives in
/// `<memory_root>/team/config/cloud_sync.json` (gitignored — secrets later).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudSyncConfig {
    /// Master toggle. Off by default until the user opts in.
    pub enabled: bool,
    /// e.g. `https://git.tangerine.cloud/acme.git` — empty = unset.
    pub repo_url: String,
    /// Defaults to `main`.
    pub branch: String,
    /// How often the daemon should poke the sync orchestrator.
    pub sync_interval_min: u32,
}

impl Default for CloudSyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            repo_url: String::new(),
            branch: "main".into(),
            sync_interval_min: 5,
        }
    }
}

/// Outcome of one stub call. Kept minimal so the React indicator can render
/// without a v2.5-final-shape struct here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudSyncOutcome {
    pub ok: bool,
    /// Stub mode message — production will replace with real commit / pull
    /// summary fields (`commits_pulled`, `commits_pushed`, ...).
    pub message: String,
}

fn config_path(memory_root: &Path) -> PathBuf {
    memory_root.join("team").join("config").join("cloud_sync.json")
}

fn default_memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// Persist the per-team cloud sync config. Atomic-ish write (tmp + rename).
pub fn save_config(memory_root: &Path, cfg: &CloudSyncConfig) -> Result<(), AppError> {
    let p = config_path(memory_root);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir_cloud_sync", e.to_string()))?;
    }
    let json = serde_json::to_string_pretty(cfg)?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, &json)
        .map_err(|e| AppError::internal("write_cloud_sync_tmp", e.to_string()))?;
    std::fs::rename(&tmp, &p)
        .map_err(|e| AppError::internal("rename_cloud_sync", e.to_string()))?;
    Ok(())
}

/// Read the persisted config. Returns the default when the file is missing.
pub fn load_config(memory_root: &Path) -> Result<CloudSyncConfig, AppError> {
    let p = config_path(memory_root);
    if !p.exists() {
        return Ok(CloudSyncConfig::default());
    }
    let raw = std::fs::read_to_string(&p)
        .map_err(|e| AppError::internal("read_cloud_sync", e.to_string()))?;
    let cfg: CloudSyncConfig = serde_json::from_str(&raw)?;
    Ok(cfg)
}

/// `git init` + remote add. STUB — logs only, no real network.
///
/// TODO(v2.5 production): real network sync. Spawn `git init` against the
/// memory dir if needed, `git remote add origin <repo_url>`, push initial
/// commit. See V2_5_SPEC §5.2 for the orchestrator shape.
pub fn init_cloud_repo(cfg: &CloudSyncConfig) -> Result<CloudSyncOutcome, AppError> {
    tracing::info!(
        enabled = cfg.enabled,
        repo_url = %cfg.repo_url,
        branch = %cfg.branch,
        "[cloud_sync stub] init_cloud_repo — no real network call"
    );
    if !cfg.enabled {
        return Ok(CloudSyncOutcome {
            ok: true,
            message: "stub: sync disabled, skipping init".into(),
        });
    }
    if cfg.repo_url.is_empty() {
        return Err(AppError::user(
            "repo_url_missing",
            "set repo_url before calling init_cloud_repo",
        ));
    }
    Ok(CloudSyncOutcome {
        ok: true,
        message: format!("stub: would init git remote at {}", cfg.repo_url),
    })
}

/// `git fetch && git rebase --autostash`. STUB.
///
/// TODO(v2.5 production): real network sync. Mirrors V2_5_SPEC §5.3 —
/// local-first with rebase --autostash; 3 consecutive failures pause the
/// team's sync and surface a banner.
pub fn pull_team_memory(cfg: &CloudSyncConfig) -> Result<CloudSyncOutcome, AppError> {
    tracing::info!(
        enabled = cfg.enabled,
        repo_url = %cfg.repo_url,
        "[cloud_sync stub] pull_team_memory — no real network call"
    );
    Ok(CloudSyncOutcome {
        ok: true,
        message: "stub: pull skipped (network not implemented)".into(),
    })
}

/// `git push origin <branch>`. STUB.
///
/// TODO(v2.5 production): real network sync. Acquire `propose_lock` for the
/// rebase window so AGI heartbeat writes don't conflict. Per V2_5_SPEC §5.3.
pub fn push_team_memory(cfg: &CloudSyncConfig) -> Result<CloudSyncOutcome, AppError> {
    tracing::info!(
        enabled = cfg.enabled,
        repo_url = %cfg.repo_url,
        "[cloud_sync stub] push_team_memory — no real network call"
    );
    Ok(CloudSyncOutcome {
        ok: true,
        message: "stub: push skipped (network not implemented)".into(),
    })
}

// ---------------------------------------------------------------------------
// Tauri-callable wrappers (default-memory-root path)

#[tauri::command]
pub async fn cloud_sync_get_config() -> Result<CloudSyncConfig, AppError> {
    let root = default_memory_root()?;
    load_config(&root)
}

#[tauri::command]
pub async fn cloud_sync_set_config(config: CloudSyncConfig) -> Result<(), AppError> {
    let root = default_memory_root()?;
    save_config(&root, &config)
}

#[tauri::command]
pub async fn cloud_sync_init() -> Result<CloudSyncOutcome, AppError> {
    let root = default_memory_root()?;
    let cfg = load_config(&root)?;
    init_cloud_repo(&cfg)
}

#[tauri::command]
pub async fn cloud_sync_pull() -> Result<CloudSyncOutcome, AppError> {
    let root = default_memory_root()?;
    let cfg = load_config(&root)?;
    pull_team_memory(&cfg)
}

#[tauri::command]
pub async fn cloud_sync_push() -> Result<CloudSyncOutcome, AppError> {
    let root = default_memory_root()?;
    let cfg = load_config(&root)?;
    push_team_memory(&cfg)
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_cloud_sync_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn stub_returns_ok_without_network() {
        let cfg = CloudSyncConfig {
            enabled: true,
            repo_url: "https://git.tangerine.cloud/example.git".into(),
            branch: "main".into(),
            sync_interval_min: 5,
        };
        assert!(init_cloud_repo(&cfg).unwrap().ok);
        assert!(pull_team_memory(&cfg).unwrap().ok);
        assert!(push_team_memory(&cfg).unwrap().ok);
    }

    #[test]
    fn config_round_trips_to_disk() {
        let root = tmp_root();
        let cfg = CloudSyncConfig {
            enabled: true,
            repo_url: "https://example.test/x.git".into(),
            branch: "main".into(),
            sync_interval_min: 10,
        };
        save_config(&root, &cfg).unwrap();
        let loaded = load_config(&root).unwrap();
        assert!(loaded.enabled);
        assert_eq!(loaded.repo_url, cfg.repo_url);
        assert_eq!(loaded.sync_interval_min, 10);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn disabled_init_short_circuits() {
        let cfg = CloudSyncConfig::default();
        let outcome = init_cloud_repo(&cfg).unwrap();
        assert!(outcome.ok);
        assert!(outcome.message.contains("disabled"));
    }

    #[test]
    fn enabled_with_empty_url_errors() {
        let cfg = CloudSyncConfig { enabled: true, ..Default::default() };
        let err = init_cloud_repo(&cfg).unwrap_err();
        match err {
            AppError::User { code, .. } => assert_eq!(code, "repo_url_missing"),
            _ => panic!("expected user error"),
        }
    }
}
