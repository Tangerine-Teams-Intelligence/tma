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

use std::sync::Arc;

use tauri::{Manager, RunEvent, WindowEvent};
use tokio::sync::Notify;

use tangerine_meeting_lib::commands;
use tangerine_meeting_lib::daemon;
use tangerine_meeting_lib::tmi_invoke_handler;
use tangerine_meeting_lib::uri_handler;
use tangerine_meeting_lib::ws_server;

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
            // v1.6.0: start the localhost ws server for the browser extension.
            // Solo-mode root: <home>/.tangerine-memory (mirrors
            // commands::memory::resolve_memory_root).
            // Team-mode override: state.ws_team_repo, mutated by
            // sync_start/sync_stop.
            // App-data dir: holds the .tangerine-port discovery dropfile.
            let state = app.state::<commands::AppState>();
            let solo_root = dirs::home_dir()
                .map(|h| h.join(".tangerine-memory"))
                .unwrap_or_else(|| std::path::PathBuf::from(".tangerine-memory"));
            let app_data_dir = state.paths.user_data.clone();
            let team_hint = state.ws_team_repo.clone();
            let port_slot = state.ws_port.clone();
            let ctx = ws_server::WsServerCtx {
                solo_root,
                app_data_dir,
                team_repo_path: team_hint,
            };
            // Stash a Notify in app state so the RunEvent::Exit hook can flip it.
            let stop_holder: Arc<parking_lot::Mutex<Option<Arc<Notify>>>> =
                Arc::new(parking_lot::Mutex::new(None));
            app.manage(WsStopHandle(stop_holder.clone()));
            tauri::async_runtime::spawn(async move {
                match ws_server::start(ctx).await {
                    Ok(handle) => {
                        *port_slot.lock() = Some(handle.bound_port);
                        *stop_holder.lock() = Some(handle.stop);
                    }
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            "ws_server failed to bind any port in 7780..=7790; \
                             browser extension will not be reachable"
                        );
                    }
                }
            });
            // v1.7.0: spawn the RMS daemon. Solo-mode default — the React
            // side calls `daemon_status` / `daemon_kick` to read/poke it.
            // Switching to team mode flips `git_pull_enabled` via a future
            // command; the heartbeat still runs in solo mode so the index
            // stays fresh.
            let daemon_root = dirs::home_dir()
                .map(|h| h.join(".tangerine-memory"))
                .unwrap_or_else(|| std::path::PathBuf::from(".tangerine-memory"));
            std::fs::create_dir_all(&daemon_root).ok();
            let mut daemon_cfg = daemon::DaemonConfig::solo(daemon_root);
            // v1.8 Phase 2-C — pass the resolved user_data so source ticks
            // (Notion / Loom / Zoom) read their per-user config + .env from
            // the same place the Tauri commands write to.
            daemon_cfg.user_data = Some(state.paths.user_data.clone());
            let daemon_control = daemon::start(daemon_cfg);
            state.daemon.install(daemon_control);
            Ok(())
        })
        .invoke_handler(tmi_invoke_handler!())
        .on_window_event(|_window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                // T3 will wire the §8.2 confirmation flow (live meeting check).
                // Default close behavior is fine for the shell.
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Tangerine AI Teams")
        .run(|app, event| {
            if let RunEvent::Exit | RunEvent::ExitRequested { .. } = event {
                // v1.6.0: tell the ws_server accept loop to stop. Best-effort —
                // if start() never resolved (port bind failed) the holder is
                // None and there's nothing to do.
                if let Some(stop) = app.try_state::<WsStopHandle>() {
                    if let Some(notify) = stop.0.lock().take() {
                        notify.notify_waiters();
                    }
                }
                // v1.7.0: graceful daemon shutdown. The DaemonSlot is part
                // of AppState so it lives until the app handle drops; we
                // proactively stop it here so the loop sees the signal
                // before the process exits.
                if let Some(s) = app.try_state::<commands::AppState>() {
                    s.daemon.stop();
                }
            }
        });
}

/// Owner of the ws_server shutdown notify. Stashed in Tauri's state container
/// so the RunEvent::Exit hook (which only sees `&AppHandle`) can fish it out
/// and flip it.
struct WsStopHandle(Arc<parking_lot::Mutex<Option<Arc<Notify>>>>);
