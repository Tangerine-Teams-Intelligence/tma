//! v1.16 Wave 1 — Conversational onboarding agent removed.
//!
//! The original `onboarding_chat_turn` command sent the user's natural-language
//! setup message to the borrowed-LLM dispatcher (`session_borrower::dispatch`)
//! and parsed back a JSON action plan. With the LLM borrow stack gone, the
//! whole pipeline is dead.
//!
//! This stub keeps the Tauri command name registered so the React side does
//! not crash with `command not found`; every invocation returns an honest
//! `removed_in_v1_16` error envelope. W1A3 owns the React-side replacement
//! (form-based setup); W1A2 owns the underlying setup_wizard.
//!
//! The `OnboardingChatTurn` / `OnboardingAction` shapes are preserved by-name
//! so the React side's `lib/tauri.ts` invoke wrappers still type-check until
//! W1A3 deletes them.

use serde::{Deserialize, Serialize};

use super::AppError;

/// One conversational turn shape — preserved for React-side type compat.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnboardingChatTurn {
    pub role: String,
    pub content: String,
    pub actions_taken: Vec<OnboardingAction>,
    pub actions_pending: Vec<OnboardingAction>,
}

/// One concrete action shape — preserved for React-side type compat.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnboardingAction {
    pub kind: String,
    pub status: String,
    pub detail: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OnboardingChatTurnArgs {
    pub user_message: String,
    pub session_id: String,
    #[serde(default)]
    pub primary_tool_id: Option<String>,
}

/// v1.16 — always errors. The conversational onboarding agent depended on
/// the (removed) session-borrower; honest "removed" error is the only
/// truthful response.
#[tauri::command]
pub async fn onboarding_chat_turn(
    _args: OnboardingChatTurnArgs,
) -> Result<OnboardingChatTurn, AppError> {
    Err(AppError::external(
        "removed_in_v1_16",
        "Conversational onboarding agent removed in v1.16 — use the form-based \
         setup wizard from Cmd+K. (Tangerine no longer borrows editor LLM \
         sessions; Claude Code does not implement MCP sampling.)",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn turn_returns_removed_error() {
        let r = onboarding_chat_turn(OnboardingChatTurnArgs {
            user_message: "hi".into(),
            session_id: "s".into(),
            primary_tool_id: None,
        })
        .await;
        let err = r.expect_err("v1.16 onboarding_chat_turn must always error");
        let msg = format!("{err:?}");
        assert!(
            msg.contains("removed_in_v1_16"),
            "stub must surface removed_in_v1_16, got: {msg}"
        );
    }
}
