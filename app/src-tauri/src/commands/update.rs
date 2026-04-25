//! `check_updates` — stub for v1.5.0-beta. The Tauri updater plugin will own
//! the real auto-update flow once T5 ships. For now this command returns
//! "no update available" so the UI's "Check for updates" button works without
//! a network call.

use serde::Serialize;

use super::AppError;

#[derive(Debug, Serialize)]
pub struct UpdateCheckResult {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
}

#[tauri::command]
pub async fn check_updates() -> Result<UpdateCheckResult, AppError> {
    // T5 will replace this with a GitHub Releases API call against
    // https://api.github.com/repos/Tangerine-Intelligence/tangerine-meeting-live/releases/latest
    Ok(UpdateCheckResult {
        available: false,
        version: None,
        notes: None,
    })
}
