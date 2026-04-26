// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! T1 — Window glue + full T3 command surface.
//!
//! Architecture (per APP-INTERFACES.md §1 + commands/mod.rs):
//!   • T1 (this file) owns: window config, plugin order, the entry point.
//!   • T3 owns: every Tauri-invokable command, in src/commands/*.rs.
//!
//! T3's `commands` module set is now wired in via the `tmi_invoke_handler!()`
//! macro from `tangerine_meeting_lib::commands` plus `setup_state` to
//! initialise `AppState` (paths, registries, http client) at boot. The wizard
//! `shell_ping` and `open_external` shims that previously lived here are now
//! redundant: `commands::external::open_external` covers the same surface,
//! and the React side calls it directly.
//!
//! v1.5.0-beta.0 adds the local-Whisper bring-up commands:
//!   • get_whisper_model_status     (commands::whisper_model)
//!   • download_whisper_model       (commands::whisper_model)
//!   • cancel_whisper_download      (commands::whisper_model)
//! All three are part of the full handler set returned by tmi_invoke_handler.

use tauri::{Manager, WindowEvent};

use tangerine_meeting_lib::commands;
use tangerine_meeting_lib::tmi_invoke_handler;
use tangerine_meeting_lib::uri_handler;

fn main() {
    // Single-instance plugin: when a second `tangerine-meeting.exe` is launched
    // the callback fires in the already-running process; we focus the existing
    // window instead of letting Tauri spawn a duplicate. v1.6.0: the callback
    // also extracts any `tangerine://` URL out of argv and forwards it to the
    // frontend's join-team route via the `deeplink://join` event.
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
            if let Some(uri) = uri_handler::extract_uri(&argv) {
                uri_handler::emit_deeplink(app, uri);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // Initialise AppState (paths, runs, watchers, bots, downloads,
            // http, sync) so every command in the macro can read it from
            // `state::<AppState>()`.
            commands::setup_state(app)?;
            let win = app.get_webview_window("main").expect("main window missing");
            // Min size enforced via tauri.conf.json; we just persist the close
            // hint here.
            let _ = win;
            // Cold-launch deep-link: when the OS spawns us with a
            // tangerine://join URL on first launch, argv carries it. Forward
            // to the frontend the same way the single-instance callback does.
            let argv: Vec<String> = std::env::args().collect();
            if let Some(uri) = uri_handler::extract_uri(&argv) {
                let handle = app.handle().clone();
                // Defer one tick so the webview is ready to receive the event.
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                    uri_handler::emit_deeplink(&handle, uri);
                });
            }
            Ok(())
        })
        .invoke_handler(tmi_invoke_handler!())
        .on_window_event(|_window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                // T3 will wire the §8.2 confirmation flow (live meeting check).
                // Default close behavior is fine for the shell.
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Tangerine AI Teams");
}
