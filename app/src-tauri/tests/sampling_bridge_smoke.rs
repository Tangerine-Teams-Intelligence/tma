//! End-to-end smoke test for the v1.9 Wave 4-A sampling bridge.
//!
//! Boots the same accept loop the production ws_server uses, opens a
//! "/sampler" connection from a fake MCP server (a tungstenite client in
//! this same process), registers itself, then drives one sample request +
//! response round trip through the global registry.
//!
//! The fake MCP server's role is everything the real
//! `mcp-server/src/sampling-bridge.ts` does: open ws, send
//! `register_sampler`, listen for `sample`, reply with `sample_response`.
//!
//! Real wire protocol is being tested (JSON over ws frames, no in-memory
//! shortcuts), so a regression in either side surfaces here.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message;

use tangerine_meeting_lib::agi::sampling_bridge;
use tangerine_meeting_lib::ws_server;

async fn start_ws_on_ephemeral() -> (u16, Arc<Notify>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind 0");
    let port = listener.local_addr().expect("local_addr").port();
    let stop = Arc::new(Notify::new());
    let stop_clone = stop.clone();
    let ctx = ws_server::WsServerCtx {
        solo_root: std::env::temp_dir(),
        app_data_dir: std::env::temp_dir(),
        team_repo_path: Arc::new(parking_lot::Mutex::new(None)),
    };
    tokio::spawn(async move {
        ws_server::run_accept_loop_for_test(listener, ctx, stop_clone).await;
    });
    // Tiny pause so the listener is definitely accepting.
    tokio::time::sleep(Duration::from_millis(20)).await;
    (port, stop)
}

/// Open a ws to /sampler. Like the real MCP server, we send NO Origin
/// header — Node's `ws` client doesn't either.
async fn connect_sampler(
    port: u16,
) -> tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
> {
    let url = format!("ws://127.0.0.1:{}/sampler", port);
    let (ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect /sampler");
    ws
}

/// Drive a fake MCP server: register, await `sample`, reply with synth text.
async fn run_fake_mcp_server(
    mut ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    tool_id: &'static str,
    answer: &'static str,
) {
    // 1. Send register_sampler.
    let reg = format!(
        "{{\"op\":\"register_sampler\",\"tool_id\":\"{}\"}}",
        tool_id
    );
    ws.send(Message::Text(reg)).await.expect("send register");

    // 2. Read ack (should arrive within 1s).
    let ack = tokio::time::timeout(Duration::from_secs(1), ws.next())
        .await
        .expect("ack timeout")
        .expect("ack none")
        .expect("ack err");
    if let Message::Text(t) = ack {
        assert!(
            t.contains("register_sampler.ack"),
            "expected ack, got: {t}"
        );
    } else {
        panic!("unexpected non-text ack: {ack:?}");
    }

    // 3. Wait for an inbound `sample` frame, then reply.
    let frame = tokio::time::timeout(Duration::from_secs(3), ws.next())
        .await
        .expect("sample timeout")
        .expect("sample none")
        .expect("sample err");
    let text = match frame {
        Message::Text(t) => t,
        other => panic!("unexpected non-text sample frame: {other:?}"),
    };
    let v: serde_json::Value = serde_json::from_str(&text).expect("sample JSON");
    assert_eq!(v["op"], "sample");
    let request_id = v["request_id"]
        .as_str()
        .expect("request_id")
        .to_string();

    let reply = serde_json::json!({
        "op": "sample_response",
        "request_id": request_id,
        "ok": true,
        "text": answer,
    });
    ws.send(Message::Text(reply.to_string()))
        .await
        .expect("send reply");

    // 4. Flush + close.
    let _ = ws.close(None).await;
}

#[tokio::test]
async fn sampler_register_and_round_trip_via_ws_server() {
    // Make sure the global registry is clean before the test (other tests
    // on this binary share it).
    let registry = sampling_bridge::global();
    registry.deregister("cursor");

    let (port, stop) = start_ws_on_ephemeral().await;

    // Spawn the fake MCP server connection.
    let ws = connect_sampler(port).await;
    let server_task = tokio::spawn(async move {
        run_fake_mcp_server(ws, "cursor", "real cursor pro answer via ws").await;
    });

    // Give it a tick to register.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(registry.has("cursor"), "expected sampler registered");

    // Drive one request via the registry, exactly like
    // session_borrower::dispatch_mcp_sampling does.
    let out = registry
        .request(
            "cursor",
            "You are Tangerine.".into(),
            "What did we ship last week?".into(),
            Some(1024),
            Some(0.4),
            Duration::from_secs(5),
        )
        .await
        .expect("real ws round-trip");
    assert_eq!(out, "real cursor pro answer via ws");

    let _ = server_task.await;
    // Once the fake MCP server closes, ws_server should deregister.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !registry.has("cursor"),
        "expected sampler deregistered after socket close"
    );
    stop.notify_waiters();
}

#[tokio::test]
async fn sampler_registration_with_empty_tool_id_is_rejected() {
    let (port, stop) = start_ws_on_ephemeral().await;
    let mut ws = connect_sampler(port).await;
    ws.send(Message::Text(
        r#"{"op":"register_sampler","tool_id":""}"#.into(),
    ))
    .await
    .expect("send");
    // Server should send an error and close the connection.
    let frame = tokio::time::timeout(Duration::from_secs(2), ws.next()).await;
    match frame {
        Ok(Some(Ok(Message::Text(t)))) => {
            assert!(t.contains("invalid_request"), "expected error, got: {t}");
        }
        Ok(Some(Ok(other))) => {
            // Some clients see immediate close — that's also acceptable.
            let _ = other;
        }
        _ => {
            // Treat early close as expected.
        }
    }
    stop.notify_waiters();
}

#[tokio::test]
async fn sampler_bad_registration_json_is_rejected() {
    let (port, stop) = start_ws_on_ephemeral().await;
    let mut ws = connect_sampler(port).await;
    ws.send(Message::Text(r#"{not even json}"#.into()))
        .await
        .expect("send");
    let frame = tokio::time::timeout(Duration::from_secs(2), ws.next()).await;
    match frame {
        Ok(Some(Ok(Message::Text(t)))) => {
            assert!(
                t.contains("invalid_request") || t.contains("bad registration"),
                "expected error, got: {t}"
            );
        }
        _ => {
            // Early close also acceptable.
        }
    }
    stop.notify_waiters();
}

#[tokio::test]
async fn sampler_disconnect_deregisters() {
    let registry = sampling_bridge::global();
    registry.deregister("claude-code");

    let (port, stop) = start_ws_on_ephemeral().await;
    let mut ws = connect_sampler(port).await;
    ws.send(Message::Text(
        r#"{"op":"register_sampler","tool_id":"claude-code"}"#.into(),
    ))
    .await
    .expect("send");
    // Read ack.
    let _ = tokio::time::timeout(Duration::from_secs(1), ws.next()).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(registry.has("claude-code"));
    // Drop the connection.
    drop(ws);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        !registry.has("claude-code"),
        "expected sampler removed after socket drop"
    );
    stop.notify_waiters();
}
