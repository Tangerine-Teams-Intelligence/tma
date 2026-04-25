// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! T1 — Window glue + minimal SHELL-level commands.
//!
//! Architecture (per APP-INTERFACES.md §1 + commands/mod.rs):
//!   • T1 (this file) owns: window config, plugin order, the entry point.
//!   • T3 owns: every Tauri-invokable command, in src/commands/*.rs.
//!
//! Once T3 lands its full module set (commands::meetings, ::fs, ::discord,
//! ::env, ::external, ::update) and unblocks the `tmi_invoke_handler!()` macro
//! defined in commands/mod.rs, T1 should switch the `.invoke_handler(...)`
//! line below to `tangerine_meeting_lib::tmi_invoke_handler!()`.
//!
//! Until then, this file ships a SHELL-only invoke handler that registers just
//! enough commands for the setup wizard to do mocked end-to-end runs:
//!   • shell_open_external — used by SW-1.1 to open the Discord portal,
//!     SW-2 to link to OpenAI dashboard, SW-3 to claude.ai/code.
//!   • shell_ping — health probe; lets `lib/tauri.ts::inTauri()` smoke-test
//!     that the command surface is reachable.
//!
//! Every other command name listed in APP-INTERFACES.md §4 will fail with
//! "command not registered" until T3 ships, which the React side handles
//! transparently via lib/tauri.ts::safeInvoke()'s mock fallback.

use serde::Serialize;
use tauri::{Manager, WindowEvent};

#[derive(Serialize)]
struct Pong {
    ok: bool,
    version: &'static str,
}

#[tauri::command]
fn shell_ping() -> Pong {
    Pong { ok: true, version: env!("CARGO_PKG_VERSION") }
}

/// Minimal `open_external` so the wizard's "Open Discord Developer Portal" /
/// "Get Whisper key" / "claude.ai/code" buttons work even before T3 lands its
/// `commands::external::open_external`. T3 will replace this with the real
/// implementation that handles editor detection, etc.
#[tauri::command]
async fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    app.shell()
        .open(&url, None)
        .map_err(|e| format!("open_external failed: {e}"))
}

fn main() {
    // Single-instance + window-state plugins are NOT enabled in v1.5.0-beta.0
    // (they require feature flags on the tauri crate that T3 owns dependency
    // management for). T3 will add them as part of the §8 startup work.
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![shell_ping, open_external])
        .setup(|app| {
            let win = app.get_webview_window("main").expect("main window missing");
            // Min size enforced via tauri.conf.json; we just persist the close
            // hint here.
            let _ = win;
            Ok(())
        })
        .on_window_event(|_window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                // T3 will wire the §8.2 confirmation flow (live meeting check).
                // Default close behavior is fine for the shell.
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Tangerine AI Teams");
}
