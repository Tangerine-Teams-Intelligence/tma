//! v1.8 Phase 3-A — Session borrowing layer (real MCP sampling cut: v1.9 Wave 4-A).
//!
//! Tangerine borrows the user's existing AI tool sessions instead of running
//! its own LLM. This dispatcher routes an `LlmRequest` to the right channel
//! based on (a) the user's primary-tool preference (Settings → primary AI
//! tool, persisted in `ui.primaryAITool`), and (b) the priority order from
//! `lib/ai-tools.ts::AI_TOOL_PRIORITY` if the primary is unreachable.
//!
//! Three channels:
//!   1. **MCP sampling** — for Cursor / Claude Code / Codex / Windsurf. Real
//!      `sampling/createMessage` flow wired in Wave 4-A. The MCP server
//!      child process opens a persistent ws back to Tangerine's localhost
//!      server (`/sampler` path) when env var `TANGERINE_SAMPLING_BRIDGE=1`
//!      is set, registers under its `tool_id`, and serves `sample` requests
//!      by reverse-calling the host's LLM. See `agi::sampling_bridge` for
//!      the registry + `mcp-server/src/sampling-bridge.ts` for the Node
//!      side. Returns `PrimaryUnreachable` (not error) when no sampler is
//!      registered, so the dispatcher falls through to the next channel.
//!   2. **Browser ext hidden conv** — for Claude.ai / ChatGPT / Gemini / v0
//!      / GitHub Copilot. Still stubbed (returns NotImplemented).
//!   3. **Ollama local fallback** — HTTP POST to `localhost:11434/api/generate`.
//!      Universal safety net.
//!
//! The dispatcher is the single entry point. P3-B's co-thinker brain calls
//! `dispatch()`; the Tauri command surface (`commands::co_thinker_dispatch`)
//! exposes it to the React side for the AI tool setup page's Test Query
//! buttons.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Fixed priority order matching `lib/ai-tools.ts::AI_TOOL_PRIORITY`. Editor
/// MCP clients first, then browser-only chat tools, then Copilot, then Ollama
/// as the last-resort local fallback.
const AI_TOOL_PRIORITY: &[&str] = &[
    "cursor",
    "claude-code",
    "codex",
    "windsurf",
    "claude-ai",
    "chatgpt",
    "gemini",
    "copilot",
    "v0",
    "ollama",
];

/// Inbound LLM call from P3-B / Tauri command. Token + temperature are
/// optional; defaults match the rest of Tangerine (`max_tokens=2000`,
/// `temperature=0.4`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmRequest {
    pub system_prompt: String,
    pub user_prompt: String,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

impl LlmRequest {
    fn max_tokens_or_default(&self) -> u32 {
        self.max_tokens.unwrap_or(2000)
    }
    fn temperature_or_default(&self) -> f32 {
        self.temperature.unwrap_or(0.4)
    }
}

/// Result returned to callers. `channel_used` is "mcp_sampling" | "ollama" |
/// "browser_ext"; `tool_id` is the upstream tool ("cursor", "ollama", ...)
/// — the React side uses this to label the answer card.
#[derive(Debug, Clone, Serialize)]
pub struct LlmResponse {
    pub text: String,
    pub channel_used: String,
    pub tool_id: String,
    pub latency_ms: u64,
    pub tokens_estimate: u32,
}

/// All ways `dispatch()` can fail. Serializable so the Tauri layer can
/// propagate the variant + payload to the React side without flattening.
///
/// === wave 11.1 ===
/// We extended `PrimaryUnreachable` with a structured `cause` so the wizard
/// can map the Rust failure mode to a human-readable error without parsing
/// the free-form `reason`. Existing callers still see `reason` populated;
/// only the new test-channel command inspects `cause`.
#[derive(Debug, thiserror::Error, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BorrowError {
    #[error("primary tool {tool_id} unreachable: {reason}")]
    PrimaryUnreachable {
        tool_id: String,
        reason: String,
        // === wave 11.1 ===
        #[serde(default)]
        cause: PrimaryUnreachableCause,
    },
    #[error("all channels exhausted")]
    AllExhausted,
    #[error("not implemented: {0}")]
    NotImplemented(String),
}

/// === wave 11.1 ===
/// Structured reason for a `PrimaryUnreachable`. Populated alongside the
/// free-form `reason` so the wizard can render channel-specific copy
/// (e.g. "did you restart your editor?" vs "Ollama is not running").
#[derive(Debug, Clone, Serialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrimaryUnreachableCause {
    #[default]
    Unknown,
    /// MCP sampler hasn't connected — user likely hasn't restarted their editor.
    McpSamplerNotRegistered,
    /// MCP sampler connected but didn't respond in the timeout window.
    McpSamplerTimeout {
        timeout_ms: u64,
    },
    /// MCP sampler dropped the socket mid-request.
    McpSamplerDisconnected,
    /// MCP host (the editor) rejected the sampling request.
    McpHostRejected {
        detail: String,
    },
    /// Internal bridge error (serialization, channel issue, etc.).
    McpBridgeInternal {
        detail: String,
    },
    /// Couldn't initialize the HTTP client.
    OllamaClientInit {
        detail: String,
    },
    /// Ollama TCP connect failed (not running on 127.0.0.1:11434).
    OllamaConnectionRefused {
        detail: String,
    },
    /// Ollama returned a non-2xx response — usually 404 model-not-pulled.
    OllamaHttpStatus {
        status: u16,
        detail: String,
    },
    /// Ollama returned 2xx but body parse failed.
    OllamaParseError {
        detail: String,
    },
}

/// Channel identifier for a tool id. Drives the dispatch fan-out below.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Channel {
    McpSampling,
    BrowserExt,
    Ollama,
}

fn channel_for(tool_id: &str) -> Option<Channel> {
    match tool_id {
        "cursor" | "claude-code" | "codex" | "windsurf" => Some(Channel::McpSampling),
        "claude-ai" | "chatgpt" | "gemini" | "v0" | "copilot" => Some(Channel::BrowserExt),
        "ollama" => Some(Channel::Ollama),
        _ => None,
    }
}

/// Public dispatch entry point.
///
/// Logic:
///   1. If `primary_tool_id` is set, attempt that tool's channel first.
///   2. On error (or when no primary set), fall through `AI_TOOL_PRIORITY`
///      skipping the primary if already tried, and return the first OK.
///   3. If every channel fails, return `BorrowError::AllExhausted`.
///
/// Note: in production this hits the Ollama endpoint at the real
/// `localhost:11434`. Tests should use [`dispatch_with_base_url`] to inject a
/// mock HTTP base so the suite doesn't depend on a running daemon.
pub async fn dispatch(
    request: LlmRequest,
    primary_tool_id: Option<String>,
) -> Result<LlmResponse, BorrowError> {
    dispatch_with_base_url(request, primary_tool_id, OLLAMA_BASE_URL).await
}

/// Test-friendly variant — `ollama_base_url` is the prefix (no trailing slash)
/// where `/api/generate` will be POSTed. The real entry point passes
/// [`OLLAMA_BASE_URL`].
pub async fn dispatch_with_base_url(
    request: LlmRequest,
    primary_tool_id: Option<String>,
    ollama_base_url: &str,
) -> Result<LlmResponse, BorrowError> {
    // Build the attempt order: primary first (if set + valid), then the rest
    // of the priority list with the primary skipped.
    let mut attempts: Vec<&str> = Vec::with_capacity(AI_TOOL_PRIORITY.len());
    if let Some(ref id) = primary_tool_id {
        if channel_for(id).is_some() {
            attempts.push(id.as_str());
        }
    }
    for &id in AI_TOOL_PRIORITY {
        if Some(id) != primary_tool_id.as_deref() {
            attempts.push(id);
        }
    }

    // Track the first PrimaryUnreachable so callers can see which primary
    // failed first (purely informational right now — we still fall through).
    let mut last_err: Option<BorrowError> = None;

    for tool_id in attempts {
        let channel = match channel_for(tool_id) {
            Some(c) => c,
            None => continue,
        };
        let res = match channel {
            Channel::McpSampling => dispatch_mcp_sampling(tool_id, &request).await,
            Channel::BrowserExt => dispatch_browser_ext_stub(tool_id, &request).await,
            Channel::Ollama => dispatch_ollama(&request, ollama_base_url).await,
        };
        match res {
            Ok(r) => return Ok(r),
            Err(e) => {
                last_err = Some(e);
                continue;
            }
        }
    }
    Err(last_err.unwrap_or(BorrowError::AllExhausted))
}

// === wave 11.1 ===
/// Logical channel id used by `dispatch_specific_channel`. Exposed so the
/// setup wizard can ask the dispatcher to try EXACTLY ONE channel and fail
/// cleanly when it can't satisfy — rather than silently falling through
/// the priority list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecificChannel {
    McpSampling,
    BrowserExt,
    Ollama,
}

// === wave 11.1 ===
/// Send `request` through ONLY the named channel. Never falls through to
/// other channels. Used by `setup_wizard_test_channel` so the user gets a
/// truthful error about the channel they actually picked, not whatever the
/// last-tried channel happened to return.
///
/// For `McpSampling`, `tool_id` must be set to the editor key
/// (cursor / claude-code / codex / windsurf). For Ollama / BrowserExt
/// `tool_id` is ignored.
pub async fn dispatch_specific_channel(
    request: LlmRequest,
    channel: SpecificChannel,
    tool_id: Option<String>,
) -> Result<LlmResponse, BorrowError> {
    dispatch_specific_channel_with_base_url(request, channel, tool_id, OLLAMA_BASE_URL).await
}

// === wave 11.1 ===
/// Test-injection variant — same contract as `dispatch_specific_channel`
/// but the Ollama base URL can be overridden so unit tests can target a
/// mock HTTP server.
pub async fn dispatch_specific_channel_with_base_url(
    request: LlmRequest,
    channel: SpecificChannel,
    tool_id: Option<String>,
    ollama_base_url: &str,
) -> Result<LlmResponse, BorrowError> {
    match channel {
        SpecificChannel::McpSampling => {
            let tid = match tool_id.as_deref() {
                Some(t) if channel_for(t) == Some(Channel::McpSampling) => t,
                Some(t) => {
                    return Err(BorrowError::PrimaryUnreachable {
                        tool_id: t.to_string(),
                        reason: format!("tool_id {t} is not an MCP-sampling tool"),
                        cause: PrimaryUnreachableCause::McpSamplerNotRegistered,
                    });
                }
                None => {
                    return Err(BorrowError::PrimaryUnreachable {
                        tool_id: "(none)".to_string(),
                        reason: "MCP sampling channel requires a tool_id".to_string(),
                        cause: PrimaryUnreachableCause::McpSamplerNotRegistered,
                    });
                }
            };
            dispatch_mcp_sampling(tid, &request).await
        }
        SpecificChannel::BrowserExt => {
            // Direct call — never falls through.
            let id = tool_id.as_deref().unwrap_or("browser_ext");
            dispatch_browser_ext_stub(id, &request).await
        }
        SpecificChannel::Ollama => dispatch_ollama(&request, ollama_base_url).await,
    }
}

// ---------------------------------------------------------------------------
// MCP sampling channel — REAL via sampling_bridge registry.
// ---------------------------------------------------------------------------

use super::sampling_bridge::{self, SampleError};

/// Per-call timeout for MCP sampling. The MCP host (Cursor / Claude Code)
/// can take several seconds to run its LLM and reply; 10s lines up with the
/// session-borrower's overall budget (the dispatcher's outer call site sees
/// this directly via `co_thinker_dispatch`'s 5s p95 target — anything slower
/// than that signals the host is overloaded and we should fall through).
const MCP_SAMPLING_TIMEOUT: Duration = Duration::from_secs(10);

/// Real MCP sampling.
///
/// Architecture: the MCP server child process spawned by the user's editor
/// (Cursor / Claude Code) opens a persistent ws back to Tangerine's localhost
/// server on `/sampler` and registers itself under its `tool_id` (passed via
/// env var `TANGERINE_MCP_TOOL_ID` when Tangerine spawns it, or detected from
/// `MCP_CLIENT` if the editor exports one). When this dispatcher fires, we
/// look up the live socket and send a `sample` frame; the MCP server runs
/// `server.createMessage()` against its host (the editor) and posts back a
/// `sample_response` frame.
///
/// If no sampler is registered for the requested tool_id, we return
/// `PrimaryUnreachable` so the dispatcher falls through to the next channel
/// in the priority list (browser_ext / Ollama).
///
/// **Acceptance bound:** the only canned-text path that remains is the test
/// suite. In production this returns the editor's real LLM output or an
/// error.
async fn dispatch_mcp_sampling(
    tool_id: &str,
    req: &LlmRequest,
) -> Result<LlmResponse, BorrowError> {
    let start = Instant::now();
    let registry = sampling_bridge::global();
    let res = registry
        .request(
            tool_id,
            req.system_prompt.clone(),
            req.user_prompt.clone(),
            req.max_tokens,
            req.temperature,
            MCP_SAMPLING_TIMEOUT,
        )
        .await;

    match res {
        Ok(text) => Ok(LlmResponse {
            tokens_estimate: estimate_tokens(&text),
            text,
            channel_used: "mcp_sampling".to_string(),
            tool_id: tool_id.to_string(),
            latency_ms: start.elapsed().as_millis() as u64,
        }),
        // === wave 11.1 ===
        Err(SampleError::NotRegistered(_)) => Err(BorrowError::PrimaryUnreachable {
            tool_id: tool_id.to_string(),
            reason: "MCP sampler not registered (start your editor with Tangerine MCP enabled)"
                .to_string(),
            cause: PrimaryUnreachableCause::McpSamplerNotRegistered,
        }),
        Err(SampleError::Timeout(d)) => Err(BorrowError::PrimaryUnreachable {
            tool_id: tool_id.to_string(),
            reason: format!("MCP sampling timed out after {d:?}"),
            cause: PrimaryUnreachableCause::McpSamplerTimeout {
                timeout_ms: d.as_millis() as u64,
            },
        }),
        Err(SampleError::Disconnected) => Err(BorrowError::PrimaryUnreachable {
            tool_id: tool_id.to_string(),
            reason: "MCP sampler disconnected mid-request".to_string(),
            cause: PrimaryUnreachableCause::McpSamplerDisconnected,
        }),
        Err(SampleError::SamplerFailed(msg)) => Err(BorrowError::PrimaryUnreachable {
            tool_id: tool_id.to_string(),
            reason: format!("MCP host rejected sampling: {msg}"),
            cause: PrimaryUnreachableCause::McpHostRejected { detail: msg },
        }),
        Err(SampleError::Internal(msg)) => Err(BorrowError::PrimaryUnreachable {
            tool_id: tool_id.to_string(),
            reason: format!("MCP bridge internal: {msg}"),
            cause: PrimaryUnreachableCause::McpBridgeInternal { detail: msg },
        }),
    }
}

// ---------------------------------------------------------------------------
// Browser-ext channel — STUBBED for Phase 3 (never returns Ok).
// ---------------------------------------------------------------------------

async fn dispatch_browser_ext_stub(
    tool_id: &str,
    _req: &LlmRequest,
) -> Result<LlmResponse, BorrowError> {
    Err(BorrowError::NotImplemented(format!(
        "browser_ext channel for {tool_id} wires in Phase 4"
    )))
}

// ---------------------------------------------------------------------------
// Ollama channel — REAL HTTP today.
// ---------------------------------------------------------------------------

const OLLAMA_BASE_URL: &str = "http://localhost:11434";
const OLLAMA_MODEL: &str = "llama3.1:8b-instruct-q4_K_M";

/// Body shape for `POST /api/generate`. Ollama accepts a single `prompt`
/// string (no separate system/user roles for this endpoint), so we splice
/// the system prompt onto the front in the canonical "[system]\n{system}\n\n
/// [user]\n{user}" format.
#[derive(Serialize)]
struct OllamaGenerateRequest<'a> {
    model: &'a str,
    prompt: String,
    stream: bool,
    options: OllamaOptions,
}

#[derive(Serialize)]
struct OllamaOptions {
    temperature: f32,
    num_predict: u32,
}

#[derive(Deserialize)]
struct OllamaGenerateResponse {
    response: String,
}

async fn dispatch_ollama(
    req: &LlmRequest,
    base_url: &str,
) -> Result<LlmResponse, BorrowError> {
    let start = Instant::now();
    // Connect timeout 5s, total request timeout 60s — long enough for an
    // 8B model to reply on a laptop, short enough that an unreachable
    // localhost:11434 fails fast.
    // === wave 11.1 ===
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| BorrowError::PrimaryUnreachable {
            tool_id: "ollama".to_string(),
            reason: format!("http client init: {e}"),
            cause: PrimaryUnreachableCause::OllamaClientInit { detail: e.to_string() },
        })?;

    let prompt = format!(
        "[system]\n{}\n\n[user]\n{}",
        req.system_prompt, req.user_prompt
    );
    let body = OllamaGenerateRequest {
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: OllamaOptions {
            temperature: req.temperature_or_default(),
            num_predict: req.max_tokens_or_default(),
        },
    };

    let url = format!("{}/api/generate", base_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| BorrowError::PrimaryUnreachable {
            tool_id: "ollama".to_string(),
            reason: format!("connect: {e}"),
            cause: PrimaryUnreachableCause::OllamaConnectionRefused { detail: e.to_string() },
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        return Err(BorrowError::PrimaryUnreachable {
            tool_id: "ollama".to_string(),
            reason: format!("http {}", status),
            cause: PrimaryUnreachableCause::OllamaHttpStatus {
                status: status.as_u16(),
                detail: status
                    .canonical_reason()
                    .unwrap_or("")
                    .to_string(),
            },
        });
    }

    let parsed: OllamaGenerateResponse =
        resp.json().await.map_err(|e| BorrowError::PrimaryUnreachable {
            tool_id: "ollama".to_string(),
            reason: format!("parse: {e}"),
            cause: PrimaryUnreachableCause::OllamaParseError { detail: e.to_string() },
        })?;

    Ok(LlmResponse {
        tokens_estimate: estimate_tokens(&parsed.response),
        text: parsed.response,
        channel_used: "ollama".to_string(),
        tool_id: "ollama".to_string(),
        latency_ms: start.elapsed().as_millis() as u64,
    })
}

/// Cheap token-count estimate (≈4 chars/token for English / mixed CJK).
/// Real tokenisation isn't worth pulling in tiktoken just to populate a
/// debug stat; this matches OpenAI's order-of-magnitude rule of thumb.
fn estimate_tokens(text: &str) -> u32 {
    ((text.chars().count() as f32) / 4.0).ceil() as u32
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU16, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener as TokioListener;
    use tokio::sync::Mutex as AsyncMutex;
    use once_cell::sync::Lazy;

    /// Tests in this module share the process-wide `sampling_bridge::global()`
    /// registry, so they must not run in parallel — one test's `register()` /
    /// `deregister()` would otherwise race against another's `request()`. We
    /// gate every test that touches the registry on this async mutex.
    static REGISTRY_TEST_LOCK: Lazy<AsyncMutex<()>> = Lazy::new(|| AsyncMutex::new(()));

    fn sample_req() -> LlmRequest {
        LlmRequest {
            system_prompt: "You are Tangerine.".into(),
            user_prompt: "上周决定了什么?".into(),
            max_tokens: Some(500),
            temperature: Some(0.2),
        }
    }

    /// Pick a free localhost port. We retry a few times to dodge races —
    /// the CI runner can be noisy.
    fn pick_free_port() -> u16 {
        for _ in 0..10 {
            if let Ok(l) = TcpListener::bind("127.0.0.1:0") {
                if let Ok(addr) = l.local_addr() {
                    let p = addr.port();
                    drop(l);
                    return p;
                }
            }
        }
        panic!("no free port");
    }

    /// Hand-rolled HTTP/1.1 mock that always returns a fixed JSON body. We
    /// avoid pulling in `wiremock` to keep the dep tree lean (Cargo.toml has
    /// no dev-dependencies block — adding one would force a rebuild for
    /// every contributor).
    async fn spawn_mock_ollama(port: u16, response_text: &'static str) {
        let listener = TokioListener::bind(("127.0.0.1", port))
            .await
            .expect("bind mock ollama");
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let response_text = response_text.to_string();
                tokio::spawn(async move {
                    // Read until end of headers (best-effort — we don't
                    // need to actually parse).
                    let mut buf = [0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let body =
                        format!("{{\"response\":\"{}\"}}", response_text.replace('"', "\\\""));
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        // Give the listener a tick to be ready.
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    /// `primary=cursor` with a live registered sampler answers via MCP.
    ///
    /// This is the post-Wave 4-A real-protocol test: we drive the global
    /// SamplerRegistry directly to simulate the MCP server child process
    /// having phoned home. Then we call dispatch and assert the answer came
    /// back over `mcp_sampling`.
    #[tokio::test]
    async fn test_dispatch_uses_primary_tool_first() {
        let _guard = REGISTRY_TEST_LOCK.lock().await;
        // Register a fake sampler for "cursor" on the global registry.
        let registry = sampling_bridge::global();
        registry.deregister("cursor"); // wipe state from any earlier test
        let mut rx = registry.register("cursor");
        let registry_clone = registry.clone();
        let bot = tokio::spawn(async move {
            // Read the outbound `sample` frame, reply with a synthesised
            // host response.
            if let Some(raw) = rx.recv().await {
                let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let request_id = v["request_id"].as_str().unwrap().to_string();
                registry_clone.deliver_response(sampling_bridge::SampleResponseFrame {
                    op: "sample_response".into(),
                    request_id,
                    ok: true,
                    text: Some("real cursor pro answer".into()),
                    error: None,
                });
            }
        });

        let port = pick_free_port();
        let base = format!("http://127.0.0.1:{}", port);
        let resp = dispatch_with_base_url(sample_req(), Some("cursor".into()), &base)
            .await
            .expect("primary cursor with registered sampler should succeed");
        assert_eq!(resp.tool_id, "cursor");
        assert_eq!(resp.channel_used, "mcp_sampling");
        assert!(resp.text.contains("real cursor pro answer"), "text was: {}", resp.text);
        assert!(resp.tokens_estimate > 0);
        let _ = bot.await;
        registry.deregister("cursor");
    }

    /// With no MCP sampler registered, the dispatcher must walk past every
    /// MCP tool and the (always-NotImplemented) browser_ext tools, finally
    /// reaching the mocked Ollama.
    #[tokio::test]
    async fn test_dispatch_falls_through_priority_on_unreachable() {
        let _guard = REGISTRY_TEST_LOCK.lock().await;
        // Make sure no live samplers are registered for any MCP tool — they
        // could leak in from sibling tests (we share the global).
        let registry = sampling_bridge::global();
        for id in ["cursor", "claude-code", "codex", "windsurf"] {
            registry.deregister(id);
        }
        let port = pick_free_port();
        let base = format!("http://127.0.0.1:{}", port);
        spawn_mock_ollama(port, "ollama caught the fall-through").await;
        let resp = dispatch_with_base_url(sample_req(), Some("copilot".into()), &base)
            .await
            .expect("fall-through should land on Ollama");
        assert_eq!(resp.tool_id, "ollama");
        assert_eq!(resp.channel_used, "ollama");
    }

    /// True end-to-end fall-through that *does* land on Ollama: the
    /// `dispatch_with_base_url` indirection lets us inject a mock HTTP
    /// server, but to skip MCP we'd need to hide all 4 MCP tools from
    /// the priority list. We can't from outside, so instead this test
    /// directly invokes `dispatch_ollama` against the mock and asserts
    /// the wire format — the priority walk is tested above.
    #[tokio::test]
    async fn test_dispatch_ollama_real_http_call() {
        let port = pick_free_port();
        let base = format!("http://127.0.0.1:{}", port);
        spawn_mock_ollama(port, "上周决定了 v1 scope, 周一 dogfood, Whisper 1.2s OK.").await;
        let resp = dispatch_ollama(&sample_req(), &base).await.expect("ollama mock");
        assert_eq!(resp.tool_id, "ollama");
        assert_eq!(resp.channel_used, "ollama");
        assert!(resp.text.contains("v1 scope"), "text was: {}", resp.text);
        assert!(resp.tokens_estimate > 0);
    }

    /// Browser-ext channel never returns Ok in Phase 3.
    #[tokio::test]
    async fn test_dispatch_browser_ext_returns_not_implemented() {
        for id in ["claude-ai", "chatgpt", "gemini", "v0", "copilot"] {
            let r = dispatch_browser_ext_stub(id, &sample_req()).await;
            match r {
                Err(BorrowError::NotImplemented(msg)) => {
                    assert!(msg.contains(id), "expected tool id in error: {msg}");
                }
                _ => panic!("expected NotImplemented for {id}, got {:?}", r),
            }
        }
    }

    /// When 11434 isn't listening, dispatch_ollama must return
    /// PrimaryUnreachable in well under 5.5s (connect timeout is 5s).
    #[tokio::test]
    async fn test_dispatch_ollama_timeout_under_5s() {
        // Pick a port we *know* is free and never spawn anything on it.
        // Connecting to localhost:<closed-port> on Linux/macOS returns
        // ECONNREFUSED almost instantly; on Windows it's similarly fast.
        // The 5s connect timeout is a worst-case backstop.
        let port = pick_free_port();
        let base = format!("http://127.0.0.1:{}", port);
        let start = Instant::now();
        let res = dispatch_ollama(&sample_req(), &base).await;
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_millis(5500),
            "dispatch_ollama took {:?}, expected < 5.5s",
            elapsed
        );
        match res {
            Err(BorrowError::PrimaryUnreachable { tool_id, .. }) => {
                assert_eq!(tool_id, "ollama");
            }
            other => panic!("expected PrimaryUnreachable, got {:?}", other),
        }
    }

    /// Unknown primary tool id: dispatcher ignores it and walks the priority
    /// list. With no MCP samplers registered, it must land on Ollama (the
    /// only channel that can answer without a host). Pre-arrange a mock
    /// Ollama on the chosen port so the assertion is deterministic.
    #[tokio::test]
    async fn test_dispatch_unknown_primary_falls_through() {
        let _guard = REGISTRY_TEST_LOCK.lock().await;
        let registry = sampling_bridge::global();
        for id in ["cursor", "claude-code", "codex", "windsurf"] {
            registry.deregister(id);
        }
        let port = pick_free_port();
        let base = format!("http://127.0.0.1:{}", port);
        spawn_mock_ollama(port, "ollama via unknown-primary fall-through").await;
        let resp = dispatch_with_base_url(sample_req(), Some("not-a-real-tool".into()), &base)
            .await
            .expect("unknown primary should fall through to first tool that works");
        assert_eq!(resp.tool_id, "ollama");
        assert_eq!(resp.channel_used, "ollama");
    }

    /// With no MCP sampler registered, dispatch_mcp_sampling must report
    /// PrimaryUnreachable (the dispatcher then falls through). This is the
    /// silent-failure mode we hit in production until the user's editor
    /// actually opens the MCP server.
    #[tokio::test]
    async fn test_dispatch_mcp_sampling_unreachable_when_no_sampler() {
        let _guard = REGISTRY_TEST_LOCK.lock().await;
        let registry = sampling_bridge::global();
        registry.deregister("cursor");
        let res = dispatch_mcp_sampling("cursor", &sample_req()).await;
        match res {
            Err(BorrowError::PrimaryUnreachable { tool_id, reason, cause }) => {
                assert_eq!(tool_id, "cursor");
                assert!(
                    reason.to_lowercase().contains("not registered")
                        || reason.to_lowercase().contains("not_registered"),
                    "expected 'not registered' in reason; got: {reason}"
                );
                // === wave 11.1 ===
                assert!(
                    matches!(cause, PrimaryUnreachableCause::McpSamplerNotRegistered),
                    "expected McpSamplerNotRegistered, got {:?}",
                    cause
                );
            }
            other => panic!("expected PrimaryUnreachable, got {:?}", other),
        }
    }

    /// Sanity: token estimate is non-zero for non-empty input.
    #[test]
    fn test_estimate_tokens() {
        assert_eq!(estimate_tokens(""), 0);
        assert!(estimate_tokens("hello") >= 1);
        assert!(estimate_tokens("hello world") > estimate_tokens("hi"));
    }

    // Suppress unused-warning when the AtomicU16 helper isn't referenced —
    // we keep it scaffolded for future tests that might run multiple mock
    // servers in parallel.
    #[allow(dead_code)]
    fn _unused_compile_check(_a: Arc<AtomicU16>) {
        let _ = Ordering::SeqCst;
    }
}
