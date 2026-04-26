//! Localhost ws server for the browser extension.
//!
//! The Tangerine Chrome / Firefox extension talks to the desktop app over
//! `ws://127.0.0.1:7780/memory` (see `browser-ext/README.md`). This module
//! owns the server end of that wire:
//!
//!   * Bind 127.0.0.1 only (never the all-zeros interface — we don't want
//!     LAN peers reachable). Try ports 7780..=7790; first one that binds
//!     wins. If all are taken we log + skip rather than crash the app.
//!   * Persist the chosen port to `<app_data_dir>/.tangerine-port` so the
//!     extension (or a debug script) can discover it without scraping.
//!   * Accept ws upgrade requests on path `/memory`. Reject anything else.
//!   * Origin gate — only `chrome-extension://*` and `moz-extension://*`
//!     pass. Anyone with localhost reach can still connect, but at least
//!     a random web page on `attacker.com` can't drive the socket.
//!   * Per-connection token-bucket rate limit (60 req/min). Excess closes
//!     the connection.
//!   * Graceful shutdown via a `Notify` handle held by `main.rs` (we hook
//!     `RunEvent::ExitRequested`).
//!
//! The wire protocol mirrors `browser-ext/src/shared/types.ts`:
//!   client → server: `{ "op": "search", "query": "...", "limit": N }`
//!                    `{ "op": "file",   "path":  "..." }`
//!                    `{ "op": "ping" }`                  (alias for cheap probe)
//!   server → client: `{ "op": "search.result", "results": [...], "tookMs": N,
//!                       "envelope": { ... AGI envelope ... } }`
//!                    `{ "op": "file.result", "path": "...", "content": "...",
//!                       "envelope": { ... } }`
//!                    `{ "op": "error", "code": "...", "message": "..." }`
//!                    `{ "ok": true }`                    (ping reply)
//!
//! Stage 1 AGI Hook 4: every successful response carries an `envelope`
//! field with the same shape as `mcp-server/src/envelope.ts`:
//!
//! ```json
//! { "data": null,
//!   "confidence": 1.0,
//!   "freshness_seconds": 0,
//!   "source_atoms": [],
//!   "alternatives": [],
//!   "reasoning_notes": null }
//! ```
//!
//! Stage 1 always pins `confidence = 1.0`. Stage 2 will compute real
//! confidence when the reasoning loop lands. The envelope is appended
//! (rather than wrapping) so older clients that ignore the field continue
//! to work — same forward-compat strategy as the MCP server.

#![allow(dead_code)]

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::handshake::server::{
    ErrorResponse, Request, Response,
};
use tokio_tungstenite::tungstenite::http::{HeaderValue, Response as HttpResponse, StatusCode};
use tokio_tungstenite::tungstenite::Message;

use crate::memory_search;

/// First port we try. The extension defaults to this exact value
/// (see `DEFAULT_SETTINGS.endpoint` in browser-ext/types.ts).
pub const DEFAULT_PORT: u16 = 7780;
/// Last port in the fallback sweep. 7780..=7790 = 11 attempts.
pub const MAX_PORT: u16 = 7790;

/// Filename for the discovery dropfile. Lives under `app_data_dir`.
pub const PORT_FILE: &str = ".tangerine-port";

/// Per-connection request budget (60 req per 60 sec rolling window).
const RATE_LIMIT_BURST: u32 = 60;
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);

/// Client → server request envelopes.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum ClientRequest {
    Search {
        query: String,
        #[serde(default = "default_limit")]
        limit: u32,
    },
    File {
        path: String,
    },
    Ping,
    // The browser ext also sends `op: "search"` with `query: "__ping__"` as
    // its reachability probe — that case is handled by the Search arm.
}

fn default_limit() -> u32 {
    5
}

/// Server → client error envelope. Field shape matches the TypeScript
/// `ErrorResponse` in browser-ext/types.ts.
#[derive(Debug, Serialize)]
struct WireError<'a> {
    op: &'static str,
    code: &'a str,
    message: String,
}

/// Stage 1 AGI envelope (Hook 4). Mirrors `mcp-server/src/envelope.ts` and
/// `browser-ext/src/shared/types.ts::AgiEnvelope`. Carried on every
/// successful response so MCP/ws clients can render confidence, freshness,
/// and source attribution from day one. Stage 2 will populate `alternatives`
/// + `reasoning_notes` and start emitting `confidence < 1.0`.
#[derive(Debug, Serialize, Default, Clone)]
pub struct AgiEnvelope {
    pub confidence: f64,
    pub freshness_seconds: u64,
    pub source_atoms: Vec<String>,
    pub alternatives: Vec<serde_json::Value>,
    pub reasoning_notes: Option<String>,
}

impl AgiEnvelope {
    /// Stage 1 default: confident, fresh-now, no source atoms (substring
    /// search returns files, not atoms). Stage 2 fills these.
    pub fn stage1_default() -> Self {
        Self {
            confidence: 1.0,
            freshness_seconds: 0,
            source_atoms: Vec::new(),
            alternatives: Vec::new(),
            reasoning_notes: None,
        }
    }
}

/// Server → client search result envelope.
#[derive(Debug, Serialize)]
struct WireSearchResult {
    op: &'static str,
    results: Vec<memory_search::SearchHit>,
    #[serde(rename = "tookMs", skip_serializing_if = "Option::is_none")]
    took_ms: Option<u128>,
    envelope: AgiEnvelope,
}

/// Server → client file result envelope.
#[derive(Debug, Serialize)]
struct WireFileResult {
    op: &'static str,
    path: String,
    content: String,
    envelope: AgiEnvelope,
}

/// Hands the ws server everything it needs to know about the running app.
/// Cheap to clone (all interior `Arc`s).
#[derive(Clone)]
pub struct WsServerCtx {
    /// Solo-mode root: `<home>/.tangerine-memory`. Always present.
    pub solo_root: PathBuf,
    /// Where to write `.tangerine-port` so the extension can discover the
    /// real port if 7780 was busy.
    pub app_data_dir: PathBuf,
    /// In team mode the sync ticker has stashed the repo root here. We
    /// re-read this on every request so the server picks up changes
    /// without restart.
    pub team_repo_path: Arc<parking_lot::Mutex<Option<PathBuf>>>,
}

impl WsServerCtx {
    /// Resolve the live memory root. Team mode wins if the sync ticker
    /// has registered a repo path; otherwise we fall back to solo.
    fn current_memory_root(&self) -> PathBuf {
        if let Some(repo) = self.team_repo_path.lock().clone() {
            // Team layout: <repo_root>/memory/. Mirrors bot/src/config.ts
            // resolveMemoryRoot + the wrap-time writers.
            return repo.join("memory");
        }
        self.solo_root.clone()
    }
}

/// Returned from `start` so the caller can stop the server cleanly.
pub struct WsServerHandle {
    pub bound_port: u16,
    /// Notify any time you want to shut the server down. The accept loop
    /// breaks on next iteration.
    pub stop: Arc<Notify>,
}

/// Spawn the accept loop on the current tokio runtime. Returns the bound
/// port + a shutdown notify. Logs and returns Err only when no port in
/// 7780..=7790 was available — caller (main.rs) treats that as "skip,
/// the extension just won't be able to connect" rather than a fatal.
pub async fn start(ctx: WsServerCtx) -> Result<WsServerHandle, std::io::Error> {
    let (listener, port) = bind_with_fallback().await?;
    persist_port(&ctx.app_data_dir, port);
    tracing::info!(port = port, "ws_server listening on 127.0.0.1");

    let stop = Arc::new(Notify::new());
    let stop_clone = stop.clone();
    let ctx_clone = ctx.clone();

    tokio::spawn(async move {
        run_accept_loop(listener, ctx_clone, stop_clone).await;
        tracing::info!("ws_server accept loop exited");
    });

    Ok(WsServerHandle {
        bound_port: port,
        stop,
    })
}

/// Walk DEFAULT_PORT..=MAX_PORT and return the first listener that binds.
async fn bind_with_fallback() -> Result<(TcpListener, u16), std::io::Error> {
    let mut last_err: Option<std::io::Error> = None;
    for port in DEFAULT_PORT..=MAX_PORT {
        let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
        match TcpListener::bind(addr).await {
            Ok(l) => return Ok((l, port)),
            Err(e) => {
                tracing::debug!(port = port, error = %e, "port busy, trying next");
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            "no port in 7780..=7790 was available",
        )
    }))
}

/// Best-effort write of the discovered port. We never fail the server start
/// just because we couldn't drop the file — the extension's default endpoint
/// already targets 7780, so the dropfile is only useful for the rare case
/// where 7780 was taken.
fn persist_port(app_data_dir: &Path, port: u16) {
    if let Err(e) = std::fs::create_dir_all(app_data_dir) {
        tracing::warn!(
            dir = %app_data_dir.display(),
            error = %e,
            "ws_server: could not mkdir app_data_dir for port file"
        );
        return;
    }
    let path = app_data_dir.join(PORT_FILE);
    if let Err(e) = std::fs::write(&path, port.to_string()) {
        tracing::warn!(
            path = %path.display(),
            error = %e,
            "ws_server: could not write port file"
        );
    }
}

/// Test-visible alias for the accept loop. Lets the integration smoke test
/// bind an ephemeral port and drive the same loop without going through the
/// 7780..=7790 fallback range. Not intended for production callers.
pub async fn run_accept_loop_for_test(
    listener: TcpListener,
    ctx: WsServerCtx,
    stop: Arc<Notify>,
) {
    run_accept_loop(listener, ctx, stop).await
}

async fn run_accept_loop(listener: TcpListener, ctx: WsServerCtx, stop: Arc<Notify>) {
    loop {
        tokio::select! {
            _ = stop.notified() => {
                tracing::info!("ws_server stop signalled");
                break;
            }
            accept = listener.accept() => {
                match accept {
                    Ok((stream, peer)) => {
                        let ctx_per = ctx.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_connection(stream, peer, ctx_per).await {
                                tracing::debug!(peer = %peer, error = %e, "ws_server: connection ended");
                            }
                        });
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "ws_server: accept failed");
                        // Brief backoff so a torrent of EMFILE doesn't pin a CPU.
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
        }
    }
}

/// Per-connection state for the ws upgrade callback. We need to surface
/// the requested path + Origin to the post-handshake code, so we capture
/// both into a `Mutex<Option<...>>` that the upgrade callback writes and
/// the message loop reads.
#[derive(Default, Clone)]
struct UpgradeBag {
    inner: Arc<parking_lot::Mutex<UpgradeInfo>>,
}

#[derive(Debug, Default, Clone)]
struct UpgradeInfo {
    path: String,
    origin: Option<String>,
}

async fn handle_connection(
    stream: TcpStream,
    peer: SocketAddr,
    ctx: WsServerCtx,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let bag = UpgradeBag::default();
    let bag_for_cb = bag.clone();

    // The tungstenite handshake callback sees the Request before we send
    // a Response. We use it to (a) reject any non-/memory path with 404,
    // (b) reject non-extension Origins with 403. Returning Err from the
    // callback aborts the upgrade with whatever HTTP response we provide.
    let mut ws = match tokio_tungstenite::accept_hdr_async(
        stream,
        |req: &Request, response: Response| -> Result<Response, ErrorResponse> {
            let path = req.uri().path().to_string();
            let origin = req
                .headers()
                .get("origin")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            {
                let mut info = bag_for_cb.inner.lock();
                info.path = path.clone();
                info.origin = origin.clone();
            }
            if path != "/memory" {
                let body = format!("not found: {}", path);
                let resp: ErrorResponse = HttpResponse::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Some(body))
                    .unwrap_or_else(|_| HttpResponse::new(Some("not found".into())));
                return Err(resp);
            }
            if !origin_allowed(origin.as_deref()) {
                let body = "origin not allowed".to_string();
                let resp: ErrorResponse = HttpResponse::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(Some(body))
                    .unwrap_or_else(|_| HttpResponse::new(Some("forbidden".into())));
                return Err(resp);
            }
            // Echo a permissive CORS-ish header so future fetch-based polyfills
            // (Path B prep) don't trip on a missing ACAO. Doesn't affect ws.
            let mut response = response;
            if let Some(o) = origin.as_deref() {
                if let Ok(v) = HeaderValue::from_str(o) {
                    response
                        .headers_mut()
                        .insert("access-control-allow-origin", v);
                }
            }
            Ok(response)
        },
    )
    .await
    {
        Ok(ws) => ws,
        Err(e) => {
            tracing::debug!(peer = %peer, error = %e, "ws upgrade failed");
            return Ok(()); // not fatal
        }
    };

    let info = bag.inner.lock().clone();
    tracing::debug!(
        peer = %peer,
        path = %info.path,
        origin = ?info.origin,
        "ws connection accepted"
    );

    let mut bucket = TokenBucket::new(RATE_LIMIT_BURST, RATE_LIMIT_WINDOW);

    while let Some(msg) = ws.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                tracing::debug!(peer = %peer, error = %e, "ws read error");
                break;
            }
        };
        match msg {
            Message::Text(text) => {
                if !bucket.allow() {
                    tracing::warn!(peer = %peer, "ws_server: rate limit exceeded — closing");
                    let _ = ws
                        .send(Message::Text(serialize_error(
                            "internal",
                            "rate limit exceeded",
                        )))
                        .await;
                    let _ = ws.close(None).await;
                    break;
                }
                let reply = dispatch(&ctx, &text);
                if let Err(e) = ws.send(Message::Text(reply)).await {
                    tracing::debug!(peer = %peer, error = %e, "ws send failed");
                    break;
                }
            }
            Message::Binary(_) => {
                let _ = ws
                    .send(Message::Text(serialize_error(
                        "invalid_request",
                        "binary frames not supported",
                    )))
                    .await;
            }
            Message::Ping(p) => {
                if let Err(e) = ws.send(Message::Pong(p)).await {
                    tracing::debug!(peer = %peer, error = %e, "ws pong failed");
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {} // Pong / Frame – ignore
        }
    }
    Ok(())
}

/// Returns true if the connection's Origin header passes our gate.
///
/// Accepted: `chrome-extension://<id>` and `moz-extension://<id>`.
/// Rejected: everything else, including missing Origin.
///
/// Note this is defence-in-depth, not a real authorization layer — anyone
/// with localhost reach can craft any Origin they like. The gate exists
/// to keep random web pages from driving the socket via fetch() (browsers
/// enforce SOP for fetch; the Origin we receive there is the page's
/// origin, not something the page can spoof).
fn origin_allowed(origin: Option<&str>) -> bool {
    match origin {
        None => false,
        Some(o) => {
            let lower = o.to_ascii_lowercase();
            lower.starts_with("chrome-extension://") || lower.starts_with("moz-extension://")
        }
    }
}

/// Parse the inbound JSON, run the requested op, return a JSON reply.
fn dispatch(ctx: &WsServerCtx, raw: &str) -> String {
    let req: ClientRequest = match serde_json::from_str(raw) {
        Ok(r) => r,
        Err(e) => {
            return serialize_error("invalid_request", format!("bad JSON: {}", e));
        }
    };
    let started = Instant::now();
    let memory_root = ctx.current_memory_root();
    match req {
        ClientRequest::Ping => {
            // Ping is intentionally cheap — no filesystem walk.
            // Shape `{ "ok": true }` matches what the browser ext expects
            // from its `MemoryClient.ping` (which actually sends a search
            // probe, but a literal `ping` op is the documented contract).
            "{\"ok\":true}".to_string()
        }
        ClientRequest::Search { query, limit } => {
            let files = memory_search::walk_memory_root(&memory_root);
            let hits = memory_search::search_memory(&files, &query, limit as usize);
            let payload = WireSearchResult {
                op: "search.result",
                results: hits,
                took_ms: Some(started.elapsed().as_millis()),
                envelope: AgiEnvelope::stage1_default(),
            };
            serde_json::to_string(&payload).unwrap_or_else(|e| {
                serialize_error("internal", format!("serialize: {}", e))
            })
        }
        ClientRequest::File { path } => {
            // Two ways the client can refer to a memory file:
            //   * Absolute path (what our `search.result` shape returns
            //     in the `file` field) — accept iff it lives under root.
            //   * Relative path — handed to `read_memory_file` which
            //     canonicalizes + prefix-checks.
            let abs_or_rel = Path::new(&path);
            let result = if abs_or_rel.is_absolute() {
                let canon_root = std::fs::canonicalize(&memory_root).ok();
                let canon_p = std::fs::canonicalize(abs_or_rel).ok();
                match (canon_root, canon_p) {
                    (Some(r), Some(p)) if p.starts_with(&r) => std::fs::read_to_string(&p)
                        .ok()
                        .map(|c| (p, c)),
                    _ => None,
                }
            } else {
                memory_search::read_memory_file(&memory_root, &path)
            };
            match result {
                Some((abs, content)) => {
                    let payload = WireFileResult {
                        op: "file.result",
                        path: abs.to_string_lossy().to_string(),
                        content,
                        envelope: AgiEnvelope::stage1_default(),
                    };
                    serde_json::to_string(&payload).unwrap_or_else(|e| {
                        serialize_error("internal", format!("serialize: {}", e))
                    })
                }
                None => serialize_error("not_found", format!("no such file: {}", path)),
            }
        }
    }
}

fn serialize_error(code: &str, message: impl Into<String>) -> String {
    let payload = WireError {
        op: "error",
        code,
        message: message.into(),
    };
    serde_json::to_string(&payload).unwrap_or_else(|_| {
        format!("{{\"op\":\"error\",\"code\":\"internal\",\"message\":\"{}\"}}", code)
    })
}

/// Simple token bucket — refills every full window. Deliberately unsynchronised:
/// each connection gets its own bucket (no shared state across peers).
struct TokenBucket {
    burst: u32,
    window: Duration,
    remaining: u32,
    window_start: Instant,
}

impl TokenBucket {
    fn new(burst: u32, window: Duration) -> Self {
        Self {
            burst,
            window,
            remaining: burst,
            window_start: Instant::now(),
        }
    }

    fn allow(&mut self) -> bool {
        let now = Instant::now();
        if now.saturating_duration_since(self.window_start) >= self.window {
            self.remaining = self.burst;
            self.window_start = now;
        }
        if self.remaining == 0 {
            return false;
        }
        self.remaining -= 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_gate_accepts_extension_schemes() {
        assert!(origin_allowed(Some("chrome-extension://abc123")));
        assert!(origin_allowed(Some("moz-extension://def456")));
        assert!(origin_allowed(Some("CHROME-EXTENSION://CASE")));
    }

    #[test]
    fn origin_gate_rejects_others() {
        assert!(!origin_allowed(None));
        assert!(!origin_allowed(Some("https://attacker.com")));
        assert!(!origin_allowed(Some("http://localhost:3000")));
        assert!(!origin_allowed(Some("file://")));
        assert!(!origin_allowed(Some("")));
    }

    #[test]
    fn token_bucket_drops_after_burst() {
        let mut b = TokenBucket::new(3, Duration::from_secs(60));
        assert!(b.allow());
        assert!(b.allow());
        assert!(b.allow());
        assert!(!b.allow());
        assert!(!b.allow());
    }

    #[test]
    fn token_bucket_refills_after_window() {
        let mut b = TokenBucket::new(2, Duration::from_millis(50));
        assert!(b.allow());
        assert!(b.allow());
        assert!(!b.allow());
        std::thread::sleep(Duration::from_millis(75));
        assert!(b.allow());
    }

    #[test]
    fn dispatch_ping_returns_ok() {
        let ctx = WsServerCtx {
            solo_root: std::env::temp_dir().join("tangerine_ws_dispatch_ping"),
            app_data_dir: std::env::temp_dir(),
            team_repo_path: Arc::new(parking_lot::Mutex::new(None)),
        };
        let reply = dispatch(&ctx, "{\"op\":\"ping\"}");
        assert!(reply.contains("\"ok\":true"));
    }

    #[test]
    fn dispatch_search_returns_results_shape() {
        // Use a temp dir we control; write one md file with the needle.
        let root = std::env::temp_dir().join(format!(
            "tangerine_ws_dispatch_search_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.md"), "we shipped postgres on monday").unwrap();

        let ctx = WsServerCtx {
            solo_root: root.clone(),
            app_data_dir: std::env::temp_dir(),
            team_repo_path: Arc::new(parking_lot::Mutex::new(None)),
        };
        let reply = dispatch(&ctx, "{\"op\":\"search\",\"query\":\"postgres\",\"limit\":5}");
        assert!(reply.contains("\"op\":\"search.result\""));
        assert!(reply.contains("\"results\""));
        assert!(reply.contains("postgres"));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dispatch_search_includes_agi_envelope() {
        let root = std::env::temp_dir().join(format!(
            "tangerine_ws_envelope_search_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.md"), "envelope test note").unwrap();
        let ctx = WsServerCtx {
            solo_root: root.clone(),
            app_data_dir: std::env::temp_dir(),
            team_repo_path: Arc::new(parking_lot::Mutex::new(None)),
        };
        let reply = dispatch(&ctx, "{\"op\":\"search\",\"query\":\"envelope\",\"limit\":5}");
        let v: serde_json::Value = serde_json::from_str(&reply).unwrap();
        let env = v.get("envelope").expect("envelope missing");
        assert_eq!(env["confidence"], 1.0);
        assert_eq!(env["freshness_seconds"], 0);
        assert_eq!(env["source_atoms"], serde_json::json!([]));
        assert_eq!(env["alternatives"], serde_json::json!([]));
        assert!(env["reasoning_notes"].is_null());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dispatch_file_includes_agi_envelope() {
        let root = std::env::temp_dir().join(format!(
            "tangerine_ws_envelope_file_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let p = root.join("note.md");
        std::fs::write(&p, "hello envelope").unwrap();
        let ctx = WsServerCtx {
            solo_root: root.clone(),
            app_data_dir: std::env::temp_dir(),
            team_repo_path: Arc::new(parking_lot::Mutex::new(None)),
        };
        let reply = dispatch(&ctx, "{\"op\":\"file\",\"path\":\"note.md\"}");
        let v: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(v["op"], "file.result");
        let env = v.get("envelope").expect("envelope missing on file.result");
        assert_eq!(env["confidence"], 1.0);
        assert!(env["alternatives"].is_array());
        assert!(env["reasoning_notes"].is_null());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn agi_envelope_stage1_default_shape() {
        let env = AgiEnvelope::stage1_default();
        assert_eq!(env.confidence, 1.0);
        assert_eq!(env.freshness_seconds, 0);
        assert!(env.source_atoms.is_empty());
        assert!(env.alternatives.is_empty());
        assert!(env.reasoning_notes.is_none());
        // Serializes with all 5 fields (no skip_serializing_if on this type —
        // forward-compat with Stage 2 clients that read these fields directly).
        let s = serde_json::to_string(&env).unwrap();
        for k in [
            "confidence",
            "freshness_seconds",
            "source_atoms",
            "alternatives",
            "reasoning_notes",
        ] {
            assert!(s.contains(k), "envelope JSON missing field {k}: {s}");
        }
    }

    #[test]
    fn dispatch_invalid_json_returns_error() {
        let ctx = WsServerCtx {
            solo_root: std::env::temp_dir(),
            app_data_dir: std::env::temp_dir(),
            team_repo_path: Arc::new(parking_lot::Mutex::new(None)),
        };
        let reply = dispatch(&ctx, "not json at all");
        assert!(reply.contains("\"op\":\"error\""));
        assert!(reply.contains("\"code\":\"invalid_request\""));
    }

    #[test]
    fn team_mode_overrides_solo_root() {
        let team = std::env::temp_dir().join("tangerine_ws_team_root_test");
        let ctx = WsServerCtx {
            solo_root: PathBuf::from("/tmp/solo"),
            app_data_dir: std::env::temp_dir(),
            team_repo_path: Arc::new(parking_lot::Mutex::new(Some(team.clone()))),
        };
        assert_eq!(ctx.current_memory_root(), team.join("memory"));
        // Clearing falls back to solo.
        *ctx.team_repo_path.lock() = None;
        assert_eq!(ctx.current_memory_root(), PathBuf::from("/tmp/solo"));
    }
}
