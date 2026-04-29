//! v1.16 Wave 1 — LLM dispatch removed.
//!
//! Tangerine no longer borrows the user's editor LLM session. Claude Code
//! does not implement the MCP `sampling` capability (latency 1-5ms instant
//! reject, confirmed by W1 tracer probes), so the protocol-layer route is
//! shut. All `dispatch*` calls below now return
//! `BorrowError::AllExhausted` honestly — no silent fallback, no canned
//! answer.
//!
//! This file is kept as a stub so the wave-11 `setup_wizard.rs` (owned by
//! W1A2) still compiles while it is reworked. The public surface
//! (`LlmRequest` / `LlmResponse` / `BorrowError` / `PrimaryUnreachableCause`
//! / `SpecificChannel` / `dispatch*`) is preserved by-shape; every
//! function is now a thin error-emitter.
//!
//! Once W1A2 deletes the setup_wizard imports and W2 reworks the test
//! surface, this whole file goes away.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Inbound LLM call envelope. Kept by-shape so callers in
/// `setup_wizard.rs` still compile; no production path consumes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmRequest {
    pub system_prompt: String,
    pub user_prompt: String,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

/// Response shape preserved for callers; never produced in v1.16.
#[derive(Debug, Clone, Serialize)]
pub struct LlmResponse {
    pub text: String,
    pub channel_used: String,
    pub tool_id: String,
    pub latency_ms: u64,
    pub tokens_estimate: u32,
}

/// All ways `dispatch()` can fail. v1.16: every call returns either
/// `AllExhausted` (no channel exists) or a `PrimaryUnreachable` carrying
/// the `removed_in_v1_16` reason.
#[derive(Debug, thiserror::Error, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BorrowError {
    #[error("primary tool {tool_id} unreachable: {reason}")]
    PrimaryUnreachable {
        tool_id: String,
        reason: String,
        #[serde(default)]
        cause: PrimaryUnreachableCause,
    },
    #[error("all channels exhausted")]
    AllExhausted,
    #[error("not implemented: {0}")]
    NotImplemented(String),
}

/// Structured reason for a `PrimaryUnreachable`. Kept verbatim so wave-11
/// setup wizard's diagnostic UI does not break; v1.16 only ever produces
/// `Unknown` from this stub.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrimaryUnreachableCause {
    #[default]
    Unknown,
    McpSamplerNotRegistered,
    McpSamplerTimeout {
        timeout_ms: u64,
    },
    McpSamplerDisconnected,
    McpHostRejected {
        detail: String,
    },
    McpBridgeInternal {
        detail: String,
    },
    OllamaClientInit {
        detail: String,
    },
    OllamaConnectionRefused {
        detail: String,
    },
    OllamaHttpStatus {
        status: u16,
        detail: String,
    },
    OllamaParseError {
        detail: String,
    },
}

/// Logical channel id used by `dispatch_specific_channel`. Preserved
/// for setup_wizard.rs compile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecificChannel {
    McpSampling,
    BrowserExt,
    Ollama,
}

const REMOVED_REASON: &str =
    "LLM borrowing removed in v1.16 (Claude Code does not support MCP sampling)";

/// v1.16 — always errors. The dispatcher is dead; no channel is reachable.
pub async fn dispatch(
    _request: LlmRequest,
    primary_tool_id: Option<String>,
) -> Result<LlmResponse, BorrowError> {
    Err(BorrowError::PrimaryUnreachable {
        tool_id: primary_tool_id.unwrap_or_else(|| "(none)".to_string()),
        reason: REMOVED_REASON.to_string(),
        cause: PrimaryUnreachableCause::Unknown,
    })
}

/// v1.16 — always errors. Same as `dispatch`; the base url is ignored.
pub async fn dispatch_with_base_url(
    _request: LlmRequest,
    primary_tool_id: Option<String>,
    _ollama_base_url: &str,
) -> Result<LlmResponse, BorrowError> {
    Err(BorrowError::PrimaryUnreachable {
        tool_id: primary_tool_id.unwrap_or_else(|| "(none)".to_string()),
        reason: REMOVED_REASON.to_string(),
        cause: PrimaryUnreachableCause::Unknown,
    })
}

/// v1.16 — always errors. Channel-specific test surface used by setup
/// wizard; honest "removed" error so the wizard never claims a channel
/// is healthy.
pub async fn dispatch_specific_channel(
    request: LlmRequest,
    channel: SpecificChannel,
    tool_id: Option<String>,
) -> Result<LlmResponse, BorrowError> {
    dispatch_specific_channel_with_base_url(request, channel, tool_id, "").await
}

/// v1.16 — always errors. Test-injection variant signature preserved.
pub async fn dispatch_specific_channel_with_base_url(
    _request: LlmRequest,
    _channel: SpecificChannel,
    tool_id: Option<String>,
    _ollama_base_url: &str,
) -> Result<LlmResponse, BorrowError> {
    Err(BorrowError::PrimaryUnreachable {
        tool_id: tool_id.unwrap_or_else(|| "(none)".to_string()),
        reason: REMOVED_REASON.to_string(),
        cause: PrimaryUnreachableCause::Unknown,
    })
}

/// Pinned for backwards compatibility with old setup_wizard probes that
/// used to await this; v1.16 never starts a dispatch so the duration is
/// purely informational.
pub const REMOVED_TIMEOUT: Duration = Duration::from_millis(0);

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dispatch_returns_removed_error() {
        let req = LlmRequest {
            system_prompt: "x".into(),
            user_prompt: "y".into(),
            max_tokens: None,
            temperature: None,
        };
        let err = dispatch(req, Some("cursor".to_string()))
            .await
            .expect_err("v1.16 dispatch must always error");
        match err {
            BorrowError::PrimaryUnreachable { reason, .. } => {
                assert!(
                    reason.contains("removed"),
                    "stub must surface removed reason, got: {reason}"
                );
            }
            other => panic!("expected PrimaryUnreachable, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn dispatch_specific_channel_returns_removed_error() {
        let req = LlmRequest {
            system_prompt: "x".into(),
            user_prompt: "y".into(),
            max_tokens: None,
            temperature: None,
        };
        let err = dispatch_specific_channel(req, SpecificChannel::Ollama, None)
            .await
            .expect_err("v1.16 dispatch_specific_channel must always error");
        match err {
            BorrowError::PrimaryUnreachable { .. } => {}
            other => panic!("expected PrimaryUnreachable, got {other:?}"),
        }
    }
}
