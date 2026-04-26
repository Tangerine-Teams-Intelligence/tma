//! v1.8 Phase 4-C — AGI peer + propose-lock command surface.
//!
//! Frontend consumers:
//!   * `AgiStickyAffordances` calls `canvas_propose_lock` for the per-sticky
//!     "Propose as decision" button.
//!   * Manual / dogfood tests + the "Throw sticky" button on the canvas top
//!     bar call `agi_throw_sticky` / `agi_comment_sticky`.
//!
//! Implementation lives in `crate::agi::propose_lock` and
//! `crate::agi::canvas_writer`. These commands are thin envelopes returning
//! lossless paths/ids back to the React layer.

use crate::agi::canvas_writer;
use crate::agi::propose_lock;

use super::AppError;

/// Build / refresh a draft decision atom for one sticky on a canvas.
///
/// Returns the absolute path of the decision file. Idempotent — see
/// `propose_lock::propose_decision_from_sticky`'s docs for the rules.
#[tauri::command]
pub async fn canvas_propose_lock(
    project: String,
    topic: String,
    sticky_id: String,
) -> Result<String, AppError> {
    let path = propose_lock::propose_decision_from_sticky(project, topic, sticky_id).await?;
    Ok(path.to_string_lossy().to_string())
}

/// AGI-peer participation: throw a fresh sticky onto a canvas surface.
/// Returns the new sticky id.
#[tauri::command]
pub async fn agi_throw_sticky(
    project: String,
    topic: String,
    body: String,
    color: String,
) -> Result<String, AppError> {
    canvas_writer::agi_throw_sticky(project, topic, body, color).await
}

/// AGI-peer participation: append a comment to an existing sticky.
#[tauri::command]
pub async fn agi_comment_sticky(
    project: String,
    topic: String,
    sticky_id: String,
    body: String,
) -> Result<(), AppError> {
    canvas_writer::agi_comment_sticky(project, topic, sticky_id, body).await
}
