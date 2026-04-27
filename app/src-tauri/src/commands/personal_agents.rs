//! v3.0 §1 + §5 — Tauri command surface for personal AI agent capture.
//!
//! All four sources (cursor / claude_code / codex / windsurf) share one
//! command surface so the React Settings page can render the per-source
//! status uniformly. Strict opt-in: a watcher tick only runs when the
//! per-source flag (`personalAgentsEnabled.{source}`) is on; the flag is
//! persisted in the per-user JSON config under
//! `<user_data>/personal_agents.json`.
//!
//! Commands:
//!   * `personal_agents_scan_all` — read-only probe; returns per-source
//!     detection status + conversation count.
//!   * `personal_agents_capture_<source>` — manual capture trigger; writes
//!     atoms under `personal/<user>/threads/<source>/`. Used by the
//!     "Sync now" button.
//!   * `personal_agents_get_settings` / `personal_agents_set_settings` —
//!     read/write the per-source enable flags. Backed by JSON file.
//!
//! Privacy: this module never returns conversation bodies to the React
//! side. Capture writes to disk, and the existing `list_atoms` /
//! `read_atom` Tauri commands are how the UI surfaces the resulting
//! thread atoms — same path every other source flows through.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::{AppError, AppState};
use crate::memory_paths::{resolve_atom_dir, AtomScope};
use crate::personal_agents::{
    self, claude_code, codex, cursor, windsurf, PersonalAgentCaptureResult,
    PersonalAgentSummary,
};

// --------------------------------------------------------------------------
// Per-source toggle storage
// --------------------------------------------------------------------------

/// Persisted per-user toggles. Lives at `<user_data>/personal_agents.json`.
/// Default is all-off (opt-in per spec §5.1).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct PersonalAgentSettings {
    #[serde(default)]
    pub cursor: bool,
    #[serde(default)]
    pub claude_code: bool,
    #[serde(default)]
    pub codex: bool,
    #[serde(default)]
    pub windsurf: bool,
    /// RFC 3339 timestamp of the last successful sweep (any source). The
    /// Settings UI renders this under each row when the source is on.
    #[serde(default)]
    pub last_sync_at: Option<String>,
}

impl PersonalAgentSettings {
    pub fn enabled(&self, source: &str) -> bool {
        match source {
            "cursor" => self.cursor,
            "claude_code" | "claude-code" => self.claude_code,
            "codex" => self.codex,
            "windsurf" => self.windsurf,
            _ => false,
        }
    }
}

fn settings_path(user_data: &Path) -> PathBuf {
    user_data.join("personal_agents.json")
}

pub fn load_settings(user_data: &Path) -> PersonalAgentSettings {
    let p = settings_path(user_data);
    let raw = match std::fs::read_to_string(&p) {
        Ok(s) => s,
        Err(_) => return PersonalAgentSettings::default(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_settings(user_data: &Path, settings: &PersonalAgentSettings) -> Result<(), String> {
    let p = settings_path(user_data);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create_dir_all: {}", e))?;
    }
    let body = serde_json::to_string_pretty(settings).map_err(|e| format!("serialize: {}", e))?;
    std::fs::write(&p, body).map_err(|e| format!("write {}: {}", p.display(), e))
}

// --------------------------------------------------------------------------
// Tauri commands
// --------------------------------------------------------------------------

/// Read-only probe — for every source, reports whether the source's home
/// directory exists and how many conversation files were found. Never
/// writes anything. Used by the Settings page to render the per-source
/// rows on first paint.
#[tauri::command]
pub async fn personal_agents_scan_all() -> Result<Vec<PersonalAgentSummary>, AppError> {
    let mut out = Vec::with_capacity(4);
    out.push(PersonalAgentSummary {
        source: "cursor".to_string(),
        detected: cursor::detected(),
        home_path: cursor::cursor_home().to_string_lossy().to_string(),
        conversation_count: cursor::count_conversations(),
    });
    out.push(PersonalAgentSummary {
        source: "claude-code".to_string(),
        detected: claude_code::detected(),
        home_path: claude_code::claude_projects_root()
            .to_string_lossy()
            .to_string(),
        conversation_count: claude_code::count_conversations(),
    });
    out.push(PersonalAgentSummary {
        source: "codex".to_string(),
        detected: codex::detected(),
        home_path: codex::codex_home().to_string_lossy().to_string(),
        conversation_count: codex::count_conversations(),
    });
    out.push(PersonalAgentSummary {
        source: "windsurf".to_string(),
        detected: windsurf::detected(),
        home_path: windsurf::windsurf_home().to_string_lossy().to_string(),
        conversation_count: windsurf::count_conversations(),
    });
    Ok(out)
}

#[derive(Debug, Deserialize)]
pub struct CaptureArgs {
    /// Caller passes `ui.currentUser` from zustand. Falls back to "me"
    /// when omitted so the destination dir always resolves under
    /// `personal/<safe-user>/threads/<source>/`.
    pub current_user: Option<String>,
}

/// Resolve the personal threads directory (`<memory_root>/personal/<user>/threads/`).
/// `memory_root` mirrors the v2.0 layout — `~/.tangerine-memory/` in solo mode.
/// We deliberately match `voice_notes::default_memory_root` rather than reusing
/// `state.paths.meetings_repo` because the meetings repo is a separate concern.
fn resolve_dest_root(_state: &AppState, current_user: Option<&str>) -> PathBuf {
    let memory_root = dirs::home_dir()
        .map(|h| h.join(".tangerine-memory"))
        .unwrap_or_else(|| PathBuf::from(".tangerine-memory"));
    let user = current_user.unwrap_or("me");
    resolve_atom_dir(&memory_root, AtomScope::Personal, user, "threads")
}

#[tauri::command]
pub async fn personal_agents_capture_cursor(
    args: Option<CaptureArgs>,
    state: State<'_, AppState>,
) -> Result<PersonalAgentCaptureResult, AppError> {
    let user = args.as_ref().and_then(|a| a.current_user.as_deref());
    let dest = resolve_dest_root(&state, user);
    let result = tauri::async_runtime::spawn_blocking(move || cursor::capture(&dest))
        .await
        .map_err(|e| AppError::internal("personal_agents_cursor_join", e.to_string()))?;
    update_last_sync(&state).ok();
    Ok(result)
}

#[tauri::command]
pub async fn personal_agents_capture_claude_code(
    args: Option<CaptureArgs>,
    state: State<'_, AppState>,
) -> Result<PersonalAgentCaptureResult, AppError> {
    let user = args.as_ref().and_then(|a| a.current_user.as_deref());
    let dest = resolve_dest_root(&state, user);
    let result = tauri::async_runtime::spawn_blocking(move || claude_code::capture(&dest))
        .await
        .map_err(|e| AppError::internal("personal_agents_cc_join", e.to_string()))?;
    update_last_sync(&state).ok();
    Ok(result)
}

#[tauri::command]
pub async fn personal_agents_capture_codex(
    args: Option<CaptureArgs>,
    state: State<'_, AppState>,
) -> Result<PersonalAgentCaptureResult, AppError> {
    let user = args.as_ref().and_then(|a| a.current_user.as_deref());
    let dest = resolve_dest_root(&state, user);
    let result = tauri::async_runtime::spawn_blocking(move || codex::capture(&dest))
        .await
        .map_err(|e| AppError::internal("personal_agents_codex_join", e.to_string()))?;
    update_last_sync(&state).ok();
    Ok(result)
}

#[tauri::command]
pub async fn personal_agents_capture_windsurf(
    args: Option<CaptureArgs>,
    state: State<'_, AppState>,
) -> Result<PersonalAgentCaptureResult, AppError> {
    let user = args.as_ref().and_then(|a| a.current_user.as_deref());
    let dest = resolve_dest_root(&state, user);
    let result = tauri::async_runtime::spawn_blocking(move || windsurf::capture(&dest))
        .await
        .map_err(|e| AppError::internal("personal_agents_windsurf_join", e.to_string()))?;
    update_last_sync(&state).ok();
    Ok(result)
}

#[tauri::command]
pub async fn personal_agents_get_settings(
    state: State<'_, AppState>,
) -> Result<PersonalAgentSettings, AppError> {
    let user_data = state.paths.user_data.clone();
    Ok(load_settings(&user_data))
}

#[derive(Debug, Deserialize)]
pub struct SetSettingsArgs {
    pub settings: PersonalAgentSettings,
}

#[tauri::command]
pub async fn personal_agents_set_settings(
    args: SetSettingsArgs,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let user_data = state.paths.user_data.clone();
    save_settings(&user_data, &args.settings)
        .map_err(|e| AppError::internal("personal_agents_save_settings", e))
}

#[derive(Debug, Deserialize)]
pub struct SetWatcherArgs {
    pub agent_id: String,
    pub enabled: bool,
}

/// Toggle a single agent's watcher. Convenience wrapper over
/// `personal_agents_set_settings` so the UI can flip one row without
/// round-tripping the whole settings struct. Returns the updated settings.
#[tauri::command]
pub async fn personal_agents_set_watcher(
    args: SetWatcherArgs,
    state: State<'_, AppState>,
) -> Result<PersonalAgentSettings, AppError> {
    let user_data = state.paths.user_data.clone();
    let mut settings = load_settings(&user_data);
    match args.agent_id.as_str() {
        "cursor" => settings.cursor = args.enabled,
        "claude_code" | "claude-code" => settings.claude_code = args.enabled,
        "codex" => settings.codex = args.enabled,
        "windsurf" => settings.windsurf = args.enabled,
        other => {
            return Err(AppError::user(
                "unknown_agent",
                format!("unknown agent_id: {}", other),
            ))
        }
    }
    save_settings(&user_data, &settings)
        .map_err(|e| AppError::internal("personal_agents_save_settings", e))?;
    Ok(settings)
}

fn update_last_sync(state: &AppState) -> Result<(), String> {
    let user_data = state.paths.user_data.clone();
    let mut settings = load_settings(&user_data);
    settings.last_sync_at = Some(chrono::Utc::now().to_rfc3339());
    save_settings(&user_data, &settings)
}

// --------------------------------------------------------------------------
// Daemon hook
// --------------------------------------------------------------------------

/// Invoked from the daemon heartbeat (`crate::daemon::do_heartbeat`).
/// Walks every enabled source and runs its capture. Errors are returned
/// as a flat list — the daemon swallows them into its `record_error`
/// surface so a per-source failure never kills the loop.
///
/// Pure data in / data out — no Tauri State, lives outside the command
/// surface so the daemon can call it without owning an `AppHandle`.
pub fn tick_from_daemon(
    user_data: &Path,
    memory_root: &Path,
    current_user: &str,
) -> Vec<PersonalAgentCaptureResult> {
    let settings = load_settings(user_data);
    let mut out = Vec::new();
    let dest = resolve_atom_dir(memory_root, AtomScope::Personal, current_user, "threads");
    if settings.cursor {
        out.push(personal_agents::cursor::capture(&dest));
    }
    if settings.claude_code {
        out.push(personal_agents::claude_code::capture(&dest));
    }
    if settings.codex {
        out.push(personal_agents::codex::capture(&dest));
    }
    if settings.windsurf {
        out.push(personal_agents::windsurf::capture(&dest));
    }
    if !out.is_empty() {
        // Roll the last_sync_at forward only when we actually swept
        // something. A heartbeat with all toggles off is silent.
        let mut s = settings.clone();
        s.last_sync_at = Some(chrono::Utc::now().to_rfc3339());
        let _ = save_settings(user_data, &s);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_is_all_off() {
        let s = PersonalAgentSettings::default();
        assert!(!s.cursor);
        assert!(!s.claude_code);
        assert!(!s.codex);
        assert!(!s.windsurf);
        assert!(s.last_sync_at.is_none());
    }

    #[test]
    fn save_load_round_trip() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_settings_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut s = PersonalAgentSettings::default();
        s.cursor = true;
        s.claude_code = true;
        save_settings(&tmp, &s).unwrap();
        let loaded = load_settings(&tmp);
        assert!(loaded.cursor);
        assert!(loaded.claude_code);
        assert!(!loaded.codex);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn tick_from_daemon_is_no_op_when_all_off() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_tick_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        // Default settings (all off) → no captures.
        let memory_root = tmp.join("mem");
        std::fs::create_dir_all(&memory_root).unwrap();
        let results = tick_from_daemon(&tmp, &memory_root, "me");
        assert!(results.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn settings_enabled_alias_handling() {
        let mut s = PersonalAgentSettings::default();
        s.claude_code = true;
        // Both "claude_code" (config key) and "claude-code" (atom dir name)
        // resolve to the same flag.
        assert!(s.enabled("claude_code"));
        assert!(s.enabled("claude-code"));
        assert!(!s.enabled("cursor"));
    }
}
