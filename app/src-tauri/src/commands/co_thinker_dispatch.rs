//! Perf (API_SURFACE_SPEC §5): `co_thinker_dispatch` is the LLM dispatch
//! bucket → 5 s p95 for one round trip. Exhausting every channel and returning
//! `AppError::External { code: "all_channels_exhausted" }` MUST also fit in 5 s
//! (each channel is bounded by its own per-channel timeout).
//!
//! v1.8 Phase 3-A — Tauri command surface for the session borrower.
//!
//! Single command (`co_thinker_dispatch`) the React side calls when it needs
//! to send a borrowed LLM request through one of the user's AI tools. Wraps
//! [`crate::agi::session_borrower::dispatch`] so the React side never has
//! to know about channel routing.
//!
//! The AI tool setup page's "Test query" buttons are the first consumers
//! (see `app/src/components/ai-tools/AIToolSetupPage.tsx`); P3-B's co-thinker
//! brain will call this same command when it asks the user's primary tool to
//! summarise a meeting.

use super::AppError;
use crate::agi::session_borrower::{dispatch, BorrowError, LlmRequest, LlmResponse};

/// Map a `BorrowError` onto Tangerine's `AppError` so the React side gets the
/// same envelope as every other Tauri command. We collapse the variant tag
/// into the `code` field so the message stays readable in DevTools.
impl From<BorrowError> for AppError {
    fn from(e: BorrowError) -> Self {
        match e {
            BorrowError::PrimaryUnreachable { tool_id, reason } => AppError::external(
                "primary_unreachable",
                format!("{tool_id}: {reason}"),
            ),
            BorrowError::AllExhausted => {
                AppError::external("all_channels_exhausted", "no AI tool channel succeeded")
            }
            BorrowError::NotImplemented(msg) => AppError::external("not_implemented", msg),
        }
    }
}

/// Dispatch one LLM request through the session borrower.
///
/// `primary_tool_id` mirrors the user's setting in `ui.primaryAITool`. Pass
/// `None` to use the global priority order from the start.
#[tauri::command]
pub async fn co_thinker_dispatch(
    request: LlmRequest,
    primary_tool_id: Option<String>,
) -> Result<LlmResponse, AppError> {
    dispatch(request, primary_tool_id).await.map_err(Into::into)
}
