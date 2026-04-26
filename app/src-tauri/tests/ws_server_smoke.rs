//! End-to-end smoke test: start the ws_server on an ephemeral port,
//! connect with a tungstenite client over a real TCP socket, send a
//! `search` op, and assert the reply has the right shape.
//!
//! This proves the wire-protocol contract from `browser-ext/README.md`
//! works against the Rust server end without needing the Tauri app to be
//! running. Runs as a normal `cargo test --test ws_server_smoke`.
//!
//! Notes:
//!   * We don't go through `ws_server::start` because that hard-codes the
//!     7780..=7790 range; for the test we want an ephemeral port the
//!     OS picks so two parallel test runs don't collide. We bind the
//!     listener ourselves and call into the same accept loop logic via a
//!     thin wrapper in this file.
//!   * Origin gate is exercised — we send `Origin: chrome-extension://test`
//!     so the handshake is accepted.
//!   * Memory root is a tempdir we seed with one .md file; we assert
//!     the search hit comes back with the right title and snippet.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use tangerine_meeting_lib::ws_server;

/// Bind 127.0.0.1:0 (ephemeral) and start the same accept loop ws_server::start
/// uses. Returns (bound port, stop notify).
async fn start_on_ephemeral(
    ctx: ws_server::WsServerCtx,
) -> (u16, Arc<Notify>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind 0");
    let port = listener.local_addr().expect("local_addr").port();
    let stop = Arc::new(Notify::new());
    let stop_clone = stop.clone();
    tokio::spawn(async move {
        ws_server::run_accept_loop_for_test(listener, ctx, stop_clone).await;
    });
    (port, stop)
}

/// Open a ws connection from the client side with a chrome-extension Origin.
async fn connect(port: u16) -> tokio_tungstenite::WebSocketStream<tokio::net::TcpStream> {
    let url = format!("ws://127.0.0.1:{}/memory", port);
    let mut req = url.into_client_request().expect("client req");
    req.headers_mut().insert(
        "origin",
        tokio_tungstenite::tungstenite::http::HeaderValue::from_static(
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
    );
    // Connect on a raw TCP socket then drive the upgrade by hand so we can
    // attach the Origin header.
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("tcp connect");
    let (ws, _resp) = tokio_tungstenite::client_async(req, stream)
        .await
        .expect("ws upgrade");
    ws
}

fn tmpdir(prefix: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "{}_{}",
        prefix,
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}

#[tokio::test]
async fn search_op_round_trip() {
    let mem_root = tmpdir("ws_smoke_search");
    // Seed one md file with the needle in the body and a frontmatter title.
    std::fs::write(
        mem_root.join("postgres-decision.md"),
        "---\ntitle: Postgres on Monday\n---\nWe shipped POSTGRES on Monday.",
    )
    .unwrap();

    let ctx = ws_server::WsServerCtx {
        solo_root: mem_root.clone(),
        app_data_dir: tmpdir("ws_smoke_appdata"),
        team_repo_path: Arc::new(parking_lot::Mutex::new(None)),
    };
    let (port, stop) = start_on_ephemeral(ctx).await;

    let mut ws = connect(port).await;
    ws.send(Message::Text(
        r#"{"op":"search","query":"postgres","limit":5}"#.into(),
    ))
    .await
    .expect("send");

    let reply = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("recv timeout")
        .expect("recv None")
        .expect("recv err");

    let text = match reply {
        Message::Text(t) => t,
        other => panic!("expected text frame, got {:?}", other),
    };
    let parsed: serde_json::Value = serde_json::from_str(&text).expect("json");
    assert_eq!(parsed["op"], "search.result");
    let results = parsed["results"].as_array().expect("results array");
    assert!(!results.is_empty(), "expected ≥1 result, got {}", text);
    let first = &results[0];
    assert_eq!(first["title"], "Postgres on Monday");
    let snippet = first["snippet"].as_str().expect("snippet str");
    assert!(snippet.to_lowercase().contains("postgres"), "snippet: {}", snippet);
    let file = first["file"].as_str().expect("file str");
    assert!(file.contains("postgres-decision.md"), "file: {}", file);
    let preview = first["preview"].as_str().expect("preview str");
    assert!(preview.contains("POSTGRES"), "preview: {}", preview);
    let _score = first["score"].as_f64().expect("score f64");

    stop.notify_waiters();
    let _ = std::fs::remove_dir_all(&mem_root);
}

#[tokio::test]
async fn ping_op_returns_ok_true() {
    let ctx = ws_server::WsServerCtx {
        solo_root: tmpdir("ws_smoke_ping"),
        app_data_dir: tmpdir("ws_smoke_ping_appdata"),
        team_repo_path: Arc::new(parking_lot::Mutex::new(None)),
    };
    let (port, stop) = start_on_ephemeral(ctx).await;
    let mut ws = connect(port).await;
    ws.send(Message::Text(r#"{"op":"ping"}"#.into()))
        .await
        .expect("send");
    let reply = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("recv timeout")
        .expect("recv None")
        .expect("recv err");
    let text = match reply {
        Message::Text(t) => t,
        other => panic!("expected text frame, got {:?}", other),
    };
    assert!(text.contains(r#""ok":true"#), "got: {}", text);
    stop.notify_waiters();
}

#[tokio::test]
async fn empty_memory_dir_returns_zero_results_no_error() {
    let mem_root = tmpdir("ws_smoke_empty");
    let ctx = ws_server::WsServerCtx {
        solo_root: mem_root.clone(),
        app_data_dir: tmpdir("ws_smoke_empty_appdata"),
        team_repo_path: Arc::new(parking_lot::Mutex::new(None)),
    };
    let (port, stop) = start_on_ephemeral(ctx).await;
    let mut ws = connect(port).await;
    ws.send(Message::Text(
        r#"{"op":"search","query":"anything","limit":5}"#.into(),
    ))
    .await
    .expect("send");
    let reply = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("recv timeout")
        .expect("recv None")
        .expect("recv err");
    let text = match reply {
        Message::Text(t) => t,
        other => panic!("expected text frame, got {:?}", other),
    };
    let parsed: serde_json::Value = serde_json::from_str(&text).expect("json");
    assert_eq!(parsed["op"], "search.result");
    let results = parsed["results"].as_array().expect("results array");
    assert!(results.is_empty(), "expected 0 results, got: {}", text);
    stop.notify_waiters();
    let _ = std::fs::remove_dir_all(&mem_root);
}

#[tokio::test]
async fn invalid_json_returns_error_envelope() {
    let ctx = ws_server::WsServerCtx {
        solo_root: tmpdir("ws_smoke_badjson"),
        app_data_dir: tmpdir("ws_smoke_badjson_appdata"),
        team_repo_path: Arc::new(parking_lot::Mutex::new(None)),
    };
    let (port, stop) = start_on_ephemeral(ctx).await;
    let mut ws = connect(port).await;
    ws.send(Message::Text("this is not json".into()))
        .await
        .expect("send");
    let reply = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("recv timeout")
        .expect("recv None")
        .expect("recv err");
    let text = match reply {
        Message::Text(t) => t,
        other => panic!("expected text frame, got {:?}", other),
    };
    let parsed: serde_json::Value = serde_json::from_str(&text).expect("json");
    assert_eq!(parsed["op"], "error");
    assert_eq!(parsed["code"], "invalid_request");
    stop.notify_waiters();
}

#[tokio::test]
async fn non_extension_origin_is_rejected_during_upgrade() {
    let ctx = ws_server::WsServerCtx {
        solo_root: tmpdir("ws_smoke_origin"),
        app_data_dir: tmpdir("ws_smoke_origin_appdata"),
        team_repo_path: Arc::new(parking_lot::Mutex::new(None)),
    };
    let (port, stop) = start_on_ephemeral(ctx).await;
    let url = format!("ws://127.0.0.1:{}/memory", port);
    let mut req = url.into_client_request().expect("req");
    req.headers_mut().insert(
        "origin",
        tokio_tungstenite::tungstenite::http::HeaderValue::from_static("https://attacker.com"),
    );
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("tcp connect");
    // The handshake should fail because the origin gate returns 403.
    let result = tokio_tungstenite::client_async(req, stream).await;
    assert!(result.is_err(), "expected handshake error, got Ok");
    stop.notify_waiters();
}

#[tokio::test]
async fn wrong_path_is_rejected_during_upgrade() {
    let ctx = ws_server::WsServerCtx {
        solo_root: tmpdir("ws_smoke_path"),
        app_data_dir: tmpdir("ws_smoke_path_appdata"),
        team_repo_path: Arc::new(parking_lot::Mutex::new(None)),
    };
    let (port, stop) = start_on_ephemeral(ctx).await;
    let url = format!("ws://127.0.0.1:{}/wrong-path", port);
    let mut req = url.into_client_request().expect("req");
    req.headers_mut().insert(
        "origin",
        tokio_tungstenite::tungstenite::http::HeaderValue::from_static("chrome-extension://aaaa"),
    );
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("tcp connect");
    let result = tokio_tungstenite::client_async(req, stream).await;
    assert!(result.is_err(), "expected handshake error, got Ok");
    stop.notify_waiters();
}

#[tokio::test]
async fn team_mode_swap_at_runtime_picked_up_on_next_request() {
    let solo_root = tmpdir("ws_smoke_swap_solo");
    let team_repo = tmpdir("ws_smoke_swap_team_repo");
    let team_memory = team_repo.join("memory");
    std::fs::create_dir_all(&team_memory).unwrap();
    std::fs::write(solo_root.join("solo.md"), "needle in solo memory").unwrap();
    std::fs::write(team_memory.join("team.md"), "needle in team memory").unwrap();

    let team_hint = Arc::new(parking_lot::Mutex::new(None));
    let ctx = ws_server::WsServerCtx {
        solo_root: solo_root.clone(),
        app_data_dir: tmpdir("ws_smoke_swap_appdata"),
        team_repo_path: team_hint.clone(),
    };
    let (port, stop) = start_on_ephemeral(ctx).await;

    // Request 1 — solo mode, should hit solo.md.
    let mut ws = connect(port).await;
    ws.send(Message::Text(
        r#"{"op":"search","query":"needle","limit":3}"#.into(),
    ))
    .await
    .unwrap();
    let r1 = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let v1: serde_json::Value =
        serde_json::from_str(r1.to_text().unwrap()).unwrap();
    let f1 = v1["results"][0]["file"].as_str().unwrap();
    assert!(f1.contains("solo.md"), "expected solo.md, got {}", f1);

    // Flip to team mode and open a NEW connection (the existing one is
    // single-shot in the smoke test).
    *team_hint.lock() = Some(team_repo.clone());
    let mut ws2 = connect(port).await;
    ws2.send(Message::Text(
        r#"{"op":"search","query":"needle","limit":3}"#.into(),
    ))
    .await
    .unwrap();
    let r2 = tokio::time::timeout(Duration::from_secs(5), ws2.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let v2: serde_json::Value =
        serde_json::from_str(r2.to_text().unwrap()).unwrap();
    let f2 = v2["results"][0]["file"].as_str().unwrap();
    assert!(f2.contains("team.md"), "expected team.md, got {}", f2);

    stop.notify_waiters();
    let _ = std::fs::remove_dir_all(&solo_root);
    let _ = std::fs::remove_dir_all(&team_repo);
}

#[tokio::test]
async fn search_op_carries_agi_envelope_on_wire() {
    // Stage 1 Hook 4: every successful search.result reply carries the
    // envelope so the browser ext + future MCP-over-ws clients can render
    // confidence/freshness/source attribution from day one.
    let mem_root = tmpdir("ws_smoke_envelope");
    std::fs::write(mem_root.join("note.md"), "envelope wire test note").unwrap();
    let ctx = ws_server::WsServerCtx {
        solo_root: mem_root.clone(),
        app_data_dir: tmpdir("ws_smoke_envelope_appdata"),
        team_repo_path: Arc::new(parking_lot::Mutex::new(None)),
    };
    let (port, stop) = start_on_ephemeral(ctx).await;
    let mut ws = connect(port).await;
    ws.send(Message::Text(
        r#"{"op":"search","query":"envelope","limit":3}"#.into(),
    ))
    .await
    .expect("send");
    let reply = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("recv timeout")
        .expect("recv None")
        .expect("recv err");
    let text = match reply {
        Message::Text(t) => t,
        other => panic!("expected text frame, got {:?}", other),
    };
    let parsed: serde_json::Value = serde_json::from_str(&text).expect("json");
    assert_eq!(parsed["op"], "search.result");
    let env = parsed
        .get("envelope")
        .expect("envelope field missing on search.result");
    assert_eq!(env["confidence"], 1.0);
    assert_eq!(env["freshness_seconds"], 0);
    assert!(env["source_atoms"].is_array());
    assert!(env["alternatives"].is_array());
    assert!(env["reasoning_notes"].is_null());
    stop.notify_waiters();
    let _ = std::fs::remove_dir_all(&mem_root);
}

#[tokio::test]
async fn file_op_carries_agi_envelope_on_wire() {
    let mem_root = tmpdir("ws_smoke_file_envelope");
    std::fs::write(mem_root.join("a.md"), "abc").unwrap();
    let ctx = ws_server::WsServerCtx {
        solo_root: mem_root.clone(),
        app_data_dir: tmpdir("ws_smoke_file_envelope_appdata"),
        team_repo_path: Arc::new(parking_lot::Mutex::new(None)),
    };
    let (port, stop) = start_on_ephemeral(ctx).await;
    let mut ws = connect(port).await;
    ws.send(Message::Text(r#"{"op":"file","path":"a.md"}"#.into()))
        .await
        .expect("send");
    let reply = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("recv timeout")
        .expect("recv None")
        .expect("recv err");
    let text = match reply {
        Message::Text(t) => t,
        other => panic!("expected text, got {:?}", other),
    };
    let parsed: serde_json::Value = serde_json::from_str(&text).expect("json");
    assert_eq!(parsed["op"], "file.result");
    let env = parsed
        .get("envelope")
        .expect("envelope field missing on file.result");
    assert_eq!(env["confidence"], 1.0);
    assert!(env["alternatives"].is_array());
    stop.notify_waiters();
    let _ = std::fs::remove_dir_all(&mem_root);
}

// Silence unused import warnings on builds where individual tests are
// disabled (e.g. `cargo test --test ws_server_smoke -- some_subset`).
#[allow(dead_code)]
fn _unused() -> SocketAddr {
    "127.0.0.1:0".parse().unwrap()
}
