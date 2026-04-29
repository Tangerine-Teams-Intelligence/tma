//! v1.16 Wave 1 — MCP sampling bridge removed.
//!
//! The Wave 4-A `sampling/createMessage` flow is dead (Claude Code does
//! not implement MCP sampling). This file is kept as a stub so the
//! wave-11 `setup_wizard.rs` (W1A2-owned) and `ws_server.rs` `/sampler`
//! handler still compile while they are reworked. Every public method
//! returns `false` / `Err(SampleError::NotRegistered(...))` — no fake
//! "Ok" path remains. R6/R7/R8/R9 honest-failure invariant preserved.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

/// Frame Tangerine sends to a registered sampler — kept by-shape; never
/// emitted by v1.16.
#[derive(Debug, Clone, Serialize)]
pub struct SampleRequestFrame {
    pub op: &'static str,
    pub request_id: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

/// Frame the MCP server sends back. Preserved so `ws_server::handle_sampler_connection`
/// still compiles while it is removed.
#[derive(Debug, Clone, Deserialize)]
pub struct SampleResponseFrame {
    #[allow(dead_code)]
    pub op: String,
    pub request_id: String,
    pub ok: bool,
    pub text: Option<String>,
    pub error: Option<String>,
}

/// Frame the MCP server sends on connect. Preserved for ws_server compile.
#[derive(Debug, Clone, Deserialize)]
pub struct RegisterSamplerFrame {
    #[allow(dead_code)]
    pub op: String,
    pub tool_id: String,
}

/// Outcome of a request to a registered sampler. v1.16 only ever returns
/// `NotRegistered` — there is no live registry.
#[derive(Debug, thiserror::Error)]
pub enum SampleError {
    #[error("no registered sampler for tool_id={0}")]
    NotRegistered(String),
    #[error("sampler dropped before answering")]
    Disconnected,
    #[error("timed out after {0:?}")]
    Timeout(Duration),
    #[error("sampler reported failure: {0}")]
    SamplerFailed(String),
    #[error("internal: {0}")]
    Internal(String),
}

/// Empty registry. All operations are no-ops or honest "not registered".
#[derive(Clone, Default)]
pub struct SamplerRegistry;

impl SamplerRegistry {
    pub fn new() -> Self {
        Self
    }

    /// v1.16 — accept the registration (returns a dead receiver) but never
    /// route anything to it. The ws_server holds the receiver until the
    /// socket closes; nothing will ever be pushed.
    pub fn register(&self, _tool_id: &str) -> mpsc::UnboundedReceiver<String> {
        let (_tx, rx) = mpsc::unbounded_channel();
        rx
    }

    /// v1.16 — no-op.
    pub fn deregister(&self, _tool_id: &str) {}

    /// v1.16 — always false. Setup wizard reads this to decide whether
    /// MCP sampling is healthy; honest "no" is the right answer.
    pub fn has(&self, _tool_id: &str) -> bool {
        false
    }

    /// v1.16 — no-op. ws_server calls this when forwarding inbound
    /// `sample_response` frames; we drop them on the floor since no
    /// in-flight oneshots exist.
    pub fn deliver_response(&self, _frame: SampleResponseFrame) {}

    /// v1.16 — always errors. No registered sampler can ever be reached.
    pub async fn request(
        &self,
        tool_id: &str,
        _system_prompt: String,
        _user_prompt: String,
        _max_tokens: Option<u32>,
        _temperature: Option<f32>,
        _timeout: Duration,
    ) -> Result<String, SampleError> {
        Err(SampleError::NotRegistered(tool_id.to_string()))
    }
}

/// Process-wide registry handle. Preserved so setup_wizard.rs callers
/// like `crate::agi::sampling_bridge::global().has(tid)` compile.
pub fn global() -> SamplerRegistry {
    SamplerRegistry
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_always_false() {
        assert!(!global().has("cursor"));
        assert!(!global().has("claude-code"));
    }

    #[tokio::test]
    async fn request_always_returns_not_registered() {
        let r = global()
            .request(
                "cursor",
                "s".into(),
                "u".into(),
                None,
                None,
                Duration::from_secs(1),
            )
            .await;
        match r {
            Err(SampleError::NotRegistered(t)) => assert_eq!(t, "cursor"),
            other => panic!("expected NotRegistered, got {other:?}"),
        }
    }
}
