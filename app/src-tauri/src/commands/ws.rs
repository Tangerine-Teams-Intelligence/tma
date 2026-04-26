//! Tauri commands for the localhost ws server.
//!
//! Right now there's just one — `get_ws_port` — which the React side can
//! call to find out which port the ws_server actually bound to. Useful for
//! the rare case where 7780 was busy and we fell back to 7781..=7790, and
//! also for surfacing a "Tangerine app reachable on …" debug line in the
//! UI.

use serde::Serialize;
use tauri::State;

use super::AppState;

#[derive(Debug, Serialize)]
pub struct WsPortInfo {
    /// Bound TCP port. `None` until ws_server::start has resolved a port,
    /// which happens during Tauri setup (so by the time the frontend
    /// can call this, the value is almost always populated).
    pub port: Option<u16>,
    /// Convenience field — the URL the browser extension should connect
    /// to, derived from `port`. Empty string when port is None.
    pub endpoint: String,
}

#[tauri::command]
pub async fn get_ws_port(state: State<'_, AppState>) -> Result<WsPortInfo, super::AppError> {
    let port = *state.ws_port.lock();
    let endpoint = match port {
        Some(p) => format!("ws://127.0.0.1:{}/memory", p),
        None => String::new(),
    };
    Ok(WsPortInfo { port, endpoint })
}
