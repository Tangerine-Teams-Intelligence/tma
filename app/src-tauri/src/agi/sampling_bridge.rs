//! v1.9 Wave 4-A — MCP sampling bridge registry.
//!
//! When Tangerine is running, the MCP server child process spawned by the
//! user's editor (Cursor / Claude Code) opens a persistent ws connection back
//! to Tangerine on `ws://127.0.0.1:<port>/sampler` and registers itself under
//! a `tool_id` (passed via env var `TANGERINE_MCP_TOOL_ID`). This module
//! owns the table mapping `tool_id → live socket sender` plus the in-flight
//! `request_id → oneshot` map for matching `sample_response` frames back to
//! their callers.
//!
//! Without this registry, `session_borrower::dispatch_mcp_sampling` has no
//! way to reach the editor's LLM — the MCP server is the only process that
//! holds the stdio pipe to the host. We turn that one-way pipe into a real
//! borrow channel by piggy-backing on the existing localhost ws server.
//!
//! Two-way protocol (frames over the registered socket):
//!   * Tangerine → MCP server: `{ "op": "sample", "request_id": "<uuid>", ...LlmRequest }`
//!   * MCP server → Tangerine: `{ "op": "sample_response", "request_id": "<uuid>", "ok": true, "text": "..." }`
//!                              `{ "op": "sample_response", "request_id": "<uuid>", "ok": false, "error": "..." }`
//!   * MCP server → Tangerine on connect: `{ "op": "register_sampler", "tool_id": "cursor" }`
//!
//! The MCP server's persistent socket is full-duplex; this matches the MCP
//! spec semantics where `sampling/createMessage` flows server → host (here
//! Tangerine plays the "server" role logically — i.e. it asks for a sample).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

/// Frame Tangerine sends to a registered sampler asking for a completion.
/// Matches what `session_borrower::LlmRequest` would expose plus a routing
/// `request_id` so multiple in-flight calls don't tangle on one socket.
#[derive(Debug, Clone, Serialize)]
pub struct SampleRequestFrame {
    pub op: &'static str, // always "sample"
    pub request_id: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

/// Frame MCP server sends back. `ok=true` means `text` is populated; `ok=false`
/// means `error` describes the host's failure (sampling not supported,
/// rejected, timeout, etc.).
#[derive(Debug, Clone, Deserialize)]
pub struct SampleResponseFrame {
    #[allow(dead_code)] // used for op-tag routing in ws_server.rs
    pub op: String, // "sample_response"
    pub request_id: String,
    pub ok: bool,
    pub text: Option<String>,
    pub error: Option<String>,
}

/// Frame the MCP server sends on connect to identify itself.
#[derive(Debug, Clone, Deserialize)]
pub struct RegisterSamplerFrame {
    #[allow(dead_code)]
    pub op: String, // "register_sampler"
    pub tool_id: String,
}

/// Per-registered-connection state. The accept loop owns the receiving half
/// of the channel; this struct holds the sending half so dispatchers can
/// push `sample` frames into the socket from anywhere.
struct SamplerSlot {
    /// Tool id this socket registered as ("cursor", "claude-code", ...).
    /// Held for diagnostics — surfaces in `tracing::info!` and lets future
    /// `health` endpoints list active samplers.
    #[allow(dead_code)]
    tool_id: String,
    /// JSON-encoded frames the ws task should write next.
    sender: mpsc::UnboundedSender<String>,
}

/// Registry of live samplers. Keyed by `tool_id`. If two MCP servers register
/// the same tool_id (rare — only one editor at a time normally) the newer
/// one wins; the older socket's outbound channel will eventually error out
/// when written to and the ws task will drop it.
#[derive(Default)]
struct RegistryInner {
    samplers: HashMap<String, SamplerSlot>,
    in_flight: HashMap<String, oneshot::Sender<SampleResponseFrame>>,
}

#[derive(Clone, Default)]
pub struct SamplerRegistry {
    inner: Arc<Mutex<RegistryInner>>,
}

/// Outcome of a request to a registered sampler. Distinct from
/// `BorrowError` so the caller can map cleanly into its own error type.
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

impl SamplerRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a new sampler keyed by `tool_id`. Returns the receiving half
    /// of the channel — the caller (ws_server) owns the read loop and must
    /// drain it onto its socket. Dropping the returned receiver effectively
    /// deregisters the sampler.
    pub fn register(&self, tool_id: &str) -> mpsc::UnboundedReceiver<String> {
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        let mut g = self.inner.lock();
        g.samplers.insert(
            tool_id.to_string(),
            SamplerSlot {
                tool_id: tool_id.to_string(),
                sender: tx,
            },
        );
        rx
    }

    /// Remove a sampler entry. Idempotent. Called by ws_server when the
    /// socket closes.
    pub fn deregister(&self, tool_id: &str) {
        let mut g = self.inner.lock();
        if let Some(slot) = g.samplers.remove(tool_id) {
            // Drop the held sender so the receiver loop in ws_server exits.
            drop(slot);
        }
    }

    /// Returns true if a sampler is registered for the given tool_id.
    pub fn has(&self, tool_id: &str) -> bool {
        self.inner.lock().samplers.contains_key(tool_id)
    }

    /// Forward a `sample_response` frame from the MCP server to whoever is
    /// awaiting that request_id. If nobody is awaiting (timed out, race) the
    /// frame is silently dropped.
    pub fn deliver_response(&self, frame: SampleResponseFrame) {
        let request_id = frame.request_id.clone();
        let mut g = self.inner.lock();
        if let Some(tx) = g.in_flight.remove(&request_id) {
            // Receiver may have dropped (timeout); ignore send error.
            let _ = tx.send(frame);
        }
    }

    /// Send a `sample` request to the registered sampler for `tool_id` and
    /// await its response or fail with timeout / disconnect / NotRegistered.
    pub async fn request(
        &self,
        tool_id: &str,
        system_prompt: String,
        user_prompt: String,
        max_tokens: Option<u32>,
        temperature: Option<f32>,
        timeout: Duration,
    ) -> Result<String, SampleError> {
        let request_id = Uuid::new_v4().simple().to_string();
        let frame = SampleRequestFrame {
            op: "sample",
            request_id: request_id.clone(),
            system_prompt,
            user_prompt,
            max_tokens,
            temperature,
        };
        let json = serde_json::to_string(&frame)
            .map_err(|e| SampleError::Internal(format!("serialize: {e}")))?;

        // Hold the lock briefly: register the oneshot + grab the sender.
        let (resp_tx, resp_rx) = oneshot::channel::<SampleResponseFrame>();
        {
            let mut g = self.inner.lock();
            let sender = match g.samplers.get(tool_id) {
                Some(slot) => slot.sender.clone(),
                None => return Err(SampleError::NotRegistered(tool_id.to_string())),
            };
            g.in_flight.insert(request_id.clone(), resp_tx);
            // Send under the lock-held sender clone; the channel is unbounded
            // so this is non-blocking.
            if sender.send(json).is_err() {
                g.in_flight.remove(&request_id);
                g.samplers.remove(tool_id);
                return Err(SampleError::Disconnected);
            }
        }

        // Await with timeout.
        match tokio::time::timeout(timeout, resp_rx).await {
            Err(_) => {
                // Clean the slot so we don't leak.
                self.inner.lock().in_flight.remove(&request_id);
                Err(SampleError::Timeout(timeout))
            }
            Ok(Err(_recv)) => Err(SampleError::Disconnected),
            Ok(Ok(frame)) => {
                if frame.ok {
                    Ok(frame.text.unwrap_or_default())
                } else {
                    Err(SampleError::SamplerFailed(
                        frame.error.unwrap_or_else(|| "unknown".to_string()),
                    ))
                }
            }
        }
    }
}

// Process-wide handle. The ws_server reads/writes this; `session_borrower`
// reads it. Tests can construct fresh registries without touching the global.
use once_cell::sync::Lazy;

static GLOBAL: Lazy<SamplerRegistry> = Lazy::new(SamplerRegistry::new);

/// Access the process-wide sampler registry. Used by ws_server (to register
/// incoming /sampler connections) and by session_borrower (to dispatch
/// requests).
pub fn global() -> SamplerRegistry {
    GLOBAL.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn request_returns_not_registered_when_empty() {
        let reg = SamplerRegistry::new();
        let err = reg
            .request(
                "cursor",
                "sys".into(),
                "user".into(),
                None,
                None,
                Duration::from_millis(100),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, SampleError::NotRegistered(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn register_and_dispatch_routes_frame_to_socket() {
        let reg = SamplerRegistry::new();
        let mut rx = reg.register("cursor");
        // Spawn a fake "MCP server" that reads the request and replies.
        let reg_clone = reg.clone();
        tokio::spawn(async move {
            let raw = rx.recv().await.expect("sample frame");
            let req: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(req["op"], "sample");
            let request_id = req["request_id"].as_str().unwrap().to_string();
            // Reply with a synthesised response.
            reg_clone.deliver_response(SampleResponseFrame {
                op: "sample_response".into(),
                request_id,
                ok: true,
                text: Some("borrowed answer from cursor".into()),
                error: None,
            });
        });
        let out = reg
            .request(
                "cursor",
                "sys".into(),
                "user".into(),
                Some(500),
                Some(0.4),
                Duration::from_secs(2),
            )
            .await
            .expect("real response");
        assert_eq!(out, "borrowed answer from cursor");
    }

    #[tokio::test]
    async fn request_times_out_when_sampler_silent() {
        let reg = SamplerRegistry::new();
        let _rx = reg.register("cursor");
        let err = reg
            .request(
                "cursor",
                "sys".into(),
                "user".into(),
                None,
                None,
                Duration::from_millis(50),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, SampleError::Timeout(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn deregister_removes_sampler() {
        let reg = SamplerRegistry::new();
        let _rx = reg.register("cursor");
        assert!(reg.has("cursor"));
        reg.deregister("cursor");
        assert!(!reg.has("cursor"));
    }

    #[tokio::test]
    async fn sampler_failure_propagates_error() {
        let reg = SamplerRegistry::new();
        let mut rx = reg.register("claude-code");
        let reg_clone = reg.clone();
        tokio::spawn(async move {
            let raw = rx.recv().await.expect("frame");
            let req: serde_json::Value = serde_json::from_str(&raw).unwrap();
            let request_id = req["request_id"].as_str().unwrap().to_string();
            reg_clone.deliver_response(SampleResponseFrame {
                op: "sample_response".into(),
                request_id,
                ok: false,
                text: None,
                error: Some("host rejected sampling".into()),
            });
        });
        let err = reg
            .request(
                "claude-code",
                "sys".into(),
                "user".into(),
                None,
                None,
                Duration::from_secs(1),
            )
            .await
            .unwrap_err();
        match err {
            SampleError::SamplerFailed(msg) => assert!(msg.contains("host rejected")),
            other => panic!("expected SamplerFailed, got {other:?}"),
        }
    }

    /// Field present so dead-code lint doesn't fire on `tool_id` — the field
    /// is used for diagnostics in future logging hooks.
    #[test]
    fn slot_holds_tool_id() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let s = SamplerSlot {
            tool_id: "cursor".into(),
            sender: tx,
        };
        assert_eq!(s.tool_id, "cursor");
    }
}
