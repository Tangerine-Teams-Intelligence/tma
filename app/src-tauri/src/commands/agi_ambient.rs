//! v1.8 Phase 4-A — Tauri command surface for the ambient input analyser.
//!
//! Single command (`agi_analyze_input`) the React side
//! (`AmbientInputObserver`) calls once per debounced edit. Wraps
//! [`crate::agi::ambient::analyze_input`].

use super::AppError;
use crate::agi::ambient::{analyze_input, AmbientAnalyzeResult};

/// Run one ambient analysis pass over `text`. `surface_id` is forwarded
/// for future use (per-surface logging / cache keys); today the analyser
/// doesn't read it. `primary_tool_id` mirrors `ui.primaryAITool` so the
/// session_borrower can pin the dispatch to the user's chosen tool.
#[tauri::command]
pub async fn agi_analyze_input(
    text: String,
    surface_id: String,
    primary_tool_id: Option<String>,
) -> Result<AmbientAnalyzeResult, AppError> {
    analyze_input(text, surface_id, primary_tool_id).await
}
