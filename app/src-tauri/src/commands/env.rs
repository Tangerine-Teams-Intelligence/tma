//! Environment-variable / secret store.
//!
//! ## De-scoping note (2026-04-24)
//!
//! The original APP-INTERFACES.md §3 SW-5 design called for writing
//! `DISCORD_BOT_TOKEN` and `OPENAI_API_KEY` to `HKCU\Environment` in the
//! Windows Registry, then broadcasting `WM_SETTINGCHANGE` to refresh
//! already-running shells. After review, we re-scoped this to a
//! **user-scoped `.env` file** at:
//!
//! ```text
//! %LOCALAPPDATA%\TangerineMeeting\.env
//! ```
//!
//! Reasons:
//!   1. Registry writes require careful UAC handling and are discouraged for
//!      per-user secrets — they pollute the user's global env beyond the app.
//!   2. The Tangerine AI Teams app spawns the frozen Python with explicit env
//!      overrides anyway (see `runner::spawn_streamed` calls in tmi.rs/bot.rs),
//!      so users do not need their shell to "see" the secret.
//!   3. Removing the Registry path means we can ship the unsigned beta on
//!      machines with locked-down group policy.
//!
//! Net behaviour change vs. the original spec: secrets only reach `tmi.cli` /
//! the bot when launched **from inside the app**. If the user runs `tmi` from
//! a separate terminal, they'll need to source the `.env` themselves. T6's
//! SETUP.md should document this.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{AppError, AppState};

// LINEAR_API_KEY added 2026-04-26 for v1.8 Phase 2 writeback. Linear's API
// is a personal-API-key Bearer flow (no OAuth device flow yet); we reuse the
// same .env mechanism rather than adding a new auth surface.
//
// Phase 2-C real-wire (Notion + Loom + Zoom) added 2026-04-26. Notion + Loom
// are bearer-token sources; Zoom uses Server-to-Server OAuth so we store the
// account/client triplet here and exchange it for a short-lived access token
// per heartbeat in commands/zoom.rs.
const ALLOWED_KEYS: &[&str] = &[
    "DISCORD_BOT_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "LINEAR_API_KEY",
    "NOTION_API_TOKEN",
    "LOOM_API_TOKEN",
    "ZOOM_ACCOUNT_ID",
    "ZOOM_CLIENT_ID",
    "ZOOM_CLIENT_SECRET",
];

/// Read the .env file into a vec of (k, v) pairs, returning empty if the
/// file is missing or unreadable. Used by `runner::spawn_streamed` callers
/// to override child env without invoking IPC.
pub fn load_env_file(path: &Path) -> Result<Vec<(String, String)>, AppError> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path)?;
    let mut out = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
            let v = v.trim().trim_matches('"');
            if ALLOWED_KEYS.contains(&k) {
                out.push((k.to_string(), v.to_string()));
            }
        }
    }
    Ok(out)
}

fn write_env_table(path: &Path, table: &HashMap<String, String>) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("env.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        writeln!(
            f,
            "# Tangerine AI Teams user-scoped secrets — managed by the app.\n# Do not edit while the app is running."
        )?;
        for (k, v) in table.iter() {
            // simple shell-safe quoting
            let escaped = v.replace('\\', "\\\\").replace('"', "\\\"");
            writeln!(f, "{}=\"{}\"", k, escaped)?;
        }
    }
    std::fs::rename(&tmp, path)?;
    // Best-effort POSIX mode 600 on platforms that support it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn read_env_table(path: &Path) -> Result<HashMap<String, String>, AppError> {
    Ok(load_env_file(path)?.into_iter().collect())
}

#[derive(Debug, Deserialize)]
pub struct GetSecretArgs {
    pub name: String,
}
#[derive(Debug, Serialize)]
pub struct GetSecretResult {
    pub value: Option<String>,
}

#[tauri::command]
pub async fn get_secret(
    state: State<'_, AppState>,
    args: GetSecretArgs,
) -> Result<GetSecretResult, AppError> {
    if !ALLOWED_KEYS.contains(&args.name.as_str()) {
        return Err(AppError::user(
            "secret_not_allowed",
            format!("'{}' not in allow-list", args.name),
        ));
    }
    let table = read_env_table(&state.paths.env_file)?;
    Ok(GetSecretResult {
        value: table.get(&args.name).cloned(),
    })
}

#[derive(Debug, Deserialize)]
pub struct SetSecretArgs {
    pub name: String,
    pub value: String,
}

#[tauri::command]
pub async fn set_secret(
    state: State<'_, AppState>,
    args: SetSecretArgs,
) -> Result<(), AppError> {
    if !ALLOWED_KEYS.contains(&args.name.as_str()) {
        return Err(AppError::user(
            "secret_not_allowed",
            format!("'{}' not in allow-list", args.name),
        ));
    }
    let mut table = read_env_table(&state.paths.env_file)?;
    table.insert(args.name, args.value);
    write_env_table(&state.paths.env_file, &table)
}

#[derive(Debug, Deserialize)]
pub struct WriteEnvFileArgs {
    pub entries: HashMap<String, String>,
}

/// Bulk-replace the .env file. Used by SW-5 when the wizard finishes.
#[tauri::command]
pub async fn write_env_file(
    state: State<'_, AppState>,
    args: WriteEnvFileArgs,
) -> Result<(), AppError> {
    let mut filtered = HashMap::new();
    for (k, v) in args.entries {
        if ALLOWED_KEYS.contains(&k.as_str()) {
            filtered.insert(k, v);
        }
    }
    write_env_table(&state.paths.env_file, &filtered)
}
