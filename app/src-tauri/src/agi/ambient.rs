//! v1.8 Phase 4-A — ambient input analyser.
//!
//! Lightweight wrapper around `session_borrower::dispatch` for the
//! React-side ambient observer. The frontend calls this on every
//! debounced input event; we reuse the same channel-fan-out logic as
//! the rest of the AGI layer.
//!
//! The contract is intentionally tiny: text in, structured reaction out.
//! Confidence is heuristic — we don't have a real model-score to read
//! from the existing channels (MCP stub / Ollama / browser_ext stub),
//! so we approximate from response length + presence of the explicit
//! "(silent)" sentinel. Phase 5 swaps this for a real
//! sampling/createMessage logprob read once MCP sampling lands.
//!
//! Merge-watch: the daemon's proposal-monitor (the tray-icon piece)
//! reads `~/.tangerine-memory/agi/proposals/`. The session_borrower
//! itself is unchanged — we just call `dispatch` with a fixed system
//! prompt.

use serde::Serialize;

use crate::commands::AppError;

use super::session_borrower::{dispatch, BorrowError, LlmRequest};

/// Result returned to the frontend for one ambient analysis pass.
/// `confidence` is 0.0–1.0; the React side gates rendering on it.
/// `text == "(silent)"` is the explicit "nothing to surface" sentinel.
#[derive(Debug, Clone, Serialize)]
pub struct AmbientAnalyzeResult {
    pub text: String,
    pub confidence: f32,
    pub channel_used: String,
    pub tool_id: String,
    pub latency_ms: u64,
}

/// Estimate confidence from the response. The MCP stub today returns a
/// canned reply; Ollama returns whatever the local model gave. We use
/// two cheap signals:
///   * response begins with "(silent)" → confidence 0.0 (forces a skip).
///   * response is very short (< 8 chars trimmed) → 0.4 (low signal).
///   * MCP stub channel → 0.5 (the canned reply isn't grounded yet).
///   * Real Ollama / browser ext → 0.75 baseline.
///
/// This deliberately under-promises. The React side has its own threshold
/// slider on top — we don't want to manufacture confidence the underlying
/// model didn't actually produce.
fn estimate_confidence(text: &str, channel: &str) -> f32 {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("(silent)") {
        return 0.0;
    }
    if trimmed.len() < 8 {
        return 0.4;
    }
    match channel {
        "mcp_sampling" => 0.5,
        "ollama" => 0.75,
        "browser_ext" => 0.75,
        _ => 0.6,
    }
}

/// Analyse one piece of input text. The system prompt is fixed; the user
/// prompt is the rendered surface context + text.
///
/// Errors from the dispatcher are reshaped into the standard `AppError`
/// envelope so the React side gets a consistent shape across every
/// command.
pub async fn analyze_input(
    text: String,
    _surface_id: String,
    primary_tool_id: Option<String>,
) -> Result<AmbientAnalyzeResult, AppError> {
    // Empty / whitespace input → fast-path silent. Saves an IPC + LLM call
    // for the common case where the user just hit space + backspace.
    if text.trim().is_empty() {
        return Ok(AmbientAnalyzeResult {
            text: "(silent)".to_string(),
            confidence: 0.0,
            channel_used: "silent".to_string(),
            tool_id: primary_tool_id.unwrap_or_else(|| "none".to_string()),
            latency_ms: 0,
        });
    }

    let request = LlmRequest {
        system_prompt: AMBIENT_SYSTEM_PROMPT.to_string(),
        user_prompt: text,
        // Ambient reactions must stay short — keep token budget tight.
        max_tokens: Some(160),
        // Slightly cooler than the default so the model sticks to
        // grounded reactions instead of riffing.
        temperature: Some(0.3),
    };

    match dispatch(request, primary_tool_id).await {
        Ok(resp) => {
            let confidence = estimate_confidence(&resp.text, &resp.channel_used);
            Ok(AmbientAnalyzeResult {
                text: resp.text,
                confidence,
                channel_used: resp.channel_used,
                tool_id: resp.tool_id,
                latency_ms: resp.latency_ms,
            })
        }
        Err(e) => match e {
            // All-channels-exhausted is a soft failure for ambient
            // surfaces — we just say silent. The React side is built to
            // never render anything for confidence == 0.
            BorrowError::AllExhausted => Ok(AmbientAnalyzeResult {
                text: "(silent)".to_string(),
                confidence: 0.0,
                channel_used: "silent".to_string(),
                tool_id: "none".to_string(),
                latency_ms: 0,
            }),
            other => Err(other.into()),
        },
    }
}

/// The fixed system prompt sent with every ambient analyze call. Mirrors
/// `lib/ambient.ts::AMBIENT_SYSTEM_PROMPT` so the React + Rust sides use
/// identical wording (the React side prepends it to the user prompt for
/// the test path; production sends only the user prompt and lets the
/// session_borrower attach the system prompt server-side, but keeping
/// both copies in sync is cheap and helps debugging).
pub const AMBIENT_SYSTEM_PROMPT: &str =
    "You are Tangerine's ambient co-thinker. The user is typing in a regular \
     input field. If — and only if — you have a useful reaction worth \
     interrupting them with (a relevant memory, a missing follow-up, a \
     factual correction), reply with ONE short paragraph (≤2 sentences). \
     If you have nothing high-signal to say, reply with the literal token \
     '(silent)'. Never repeat the user's text back at them. Never reply \
     with filler like 'great point' or 'let me know if'. Default to silence.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_confidence_silent_sentinel() {
        assert_eq!(estimate_confidence("(silent)", "ollama"), 0.0);
        assert_eq!(estimate_confidence("  (SILENT)  ", "ollama"), 0.0);
        assert_eq!(estimate_confidence("", "ollama"), 0.0);
    }

    #[test]
    fn estimate_confidence_short_response_low() {
        assert_eq!(estimate_confidence("hi", "ollama"), 0.4);
    }

    #[test]
    fn estimate_confidence_per_channel() {
        let body = "I noticed you mentioned the Q3 ship date — \
                    /memory/decisions/q3-launch.md says it's pinned.";
        assert!((estimate_confidence(body, "ollama") - 0.75).abs() < 0.001);
        assert!((estimate_confidence(body, "mcp_sampling") - 0.5).abs() < 0.001);
        assert!((estimate_confidence(body, "unknown") - 0.6).abs() < 0.001);
    }

    #[tokio::test]
    async fn analyze_input_empty_short_circuits() {
        let r = analyze_input("   ".to_string(), "any".to_string(), None)
            .await
            .expect("empty input should resolve silently");
        assert_eq!(r.confidence, 0.0);
        assert_eq!(r.channel_used, "silent");
        assert_eq!(r.text, "(silent)");
    }
}
