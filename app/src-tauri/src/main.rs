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

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, RunEvent, WindowEvent,
};
use tokio::sync::Notify;

use tangerine_meeting_lib::commands;
use tangerine_meeting_lib::daemon;
use tangerine_meeting_lib::migration;
// Wave 3 cross-cut — perf budget probe (OBSERVABILITY_SPEC §5).
use tangerine_meeting_lib::perf::{Budget, Probe};
use tangerine_meeting_lib::monitoring;
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
        // === wave 25 === Auto-updater plugin. Reads `plugins.updater.endpoints`
        // + `plugins.updater.pubkey` from tauri.conf.json. If the pubkey is the
        // placeholder string, signature verify fails on download → React's
        // UpdaterCheck swallows the error + logs (no UI). Once CEO generates
        // a real keypair (`npx tauri signer generate -w ~/.tauri/myapp.key`)
        // and sets the matching TAURI_SIGNING_PRIVATE_KEY secret in CI, the
        // signed `latest.json` artifacts publish OK and the in-app banner
        // surfaces real updates.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // === end wave 25 ===
        .setup(|app| {
            // Wave 3 — cold-start perf probe (OBSERVABILITY_SPEC §5 budget < 2s)
            let cold_start_probe = Probe::start(Budget::COLD_START);
            // Wave 3 — monitoring singleton (OBSERVABILITY_SPEC §9). Idempotent.
            monitoring::init();
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
            // v1.8 Phase 4-A — system tray. The CEO's vision is no chatbot
            // tab anywhere in the UI; instead the tray surfaces high-priority
            // co-thinker proposals as "AGI: N active proposal(s)". Clicking
            // "Show co-thinker" opens the main window on the /co-thinker
            // route. The poll loop scans
            // `~/.tangerine-memory/agi/proposals/` every 60s — light enough
            // not to compete with the daemon's heartbeat for IO.
            //
            // We register the tray with default-menu disabled because we
            // build a tiny menu by hand (a label item + a "show" item +
            // separator + quit). Menu item ids are the same strings the
            // event handler reads back.
            let proposal_label = MenuItem::with_id(
                app,
                "agi_proposals",
                "AGI: 0 active proposals",
                false,
                None::<&str>,
            )?;
            let show_item =
                MenuItem::with_id(app, "show_co_thinker", "Show co-thinker", true, None::<&str>)?;
            let separator =
                tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[&proposal_label, &show_item, &separator, &quit_item],
            )?;
            // The tray icon reuses the app's default window icon — that
            // way the iconography always matches the running build's
            // bundle config, and we don't carry a separate decoded copy
            // of the PNG. `default_window_icon()` is `Some` in production
            // because tauri.conf.json registers icons/icon.png +
            // icons/icon.ico under bundle.icon.
            let mut tray_builder = TrayIconBuilder::with_id("agi_tray")
                .tooltip("Tangerine AI Teams")
                .menu(&tray_menu)
                .show_menu_on_left_click(true);
            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
            let tray_handle = tray_builder
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show_co_thinker" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.unminimize();
                            let _ = win.show();
                            let _ = win.set_focus();
                            // Navigate the webview to the /co-thinker
                            // route. We send via JS rather than a Tauri
                            // event because the route hierarchy lives
                            // entirely in React Router.
                            let _ = win.eval(
                                "window.location.hash = '#/co-thinker';\
                                 if (typeof window.dispatchEvent==='function') {\
                                   window.dispatchEvent(new HashChangeEvent('hashchange'));\
                                 }",
                            );
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            // Spin up the proposal-monitor poll loop. We re-resolve the
            // memory root every tick (cheap) so a future team-mode switch
            // takes effect on the next poll.
            let proposals_root = dirs::home_dir()
                .map(|h| h.join(".tangerine-memory").join("agi").join("proposals"))
                .unwrap_or_else(|| {
                    std::path::PathBuf::from(".tangerine-memory")
                        .join("agi")
                        .join("proposals")
                });
            let label_clone = proposal_label.clone();
            let _ = tray_handle;
            tauri::async_runtime::spawn(async move {
                let mut last_count: usize = usize::MAX;
                loop {
                    let count = count_active_proposals(&proposals_root);
                    if count != last_count {
                        let new_text = if count == 0 {
                            "AGI: 0 active proposals".to_string()
                        } else if count == 1 {
                            "AGI: 1 active proposal".to_string()
                        } else {
                            format!("AGI: {count} active proposals")
                        };
                        let _ = label_clone.set_text(new_text);
                        last_count = count;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
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
            // v2.0-alpha.1 — run the layered-memory migration BEFORE the
            // daemon comes up. The shim is idempotent so re-runs cost a
            // single `is_dir` check; on a v1.x install it folds the flat
            // `meetings/`, `decisions/`, ... dirs into `team/` and seeds a
            // `personal/<current_user>/` skeleton. Failures are logged but
            // do NOT abort boot — worst case we keep serving the v1.x
            // layout and the user gets a banner asking them to retry.
            // Note: we don't have a Tauri-resolved `currentUser` yet at
            // boot (it lives in the React zustand store), so we seed under
            // "me" — the canonical default. A future hook can re-seed
            // under the real alias once the React side hydrates.
            match migration::migrate_to_layered(&daemon_root, "me") {
                Ok(outcome) => {
                    tracing::info!(
                        already_layered = outcome.already_layered,
                        migrated = ?outcome.migrated_kinds,
                        files = outcome.files_counted,
                        gitignore_written = outcome.gitignore_written,
                        "memory layout migration complete"
                    );
                }
                Err(e) => {
                    tracing::error!(
                        error = %e,
                        "memory layout migration failed; continuing with legacy layout"
                    );
                }
            }
            let mut daemon_cfg = daemon::DaemonConfig::solo(daemon_root);
            // v1.8 Phase 2-C — pass the resolved user_data so source ticks
            // (Notion / Loom / Zoom) read their per-user config + .env from
            // the same place the Tauri commands write to.
            daemon_cfg.user_data = Some(state.paths.user_data.clone());
            let daemon_control = daemon::start(daemon_cfg);
            // v1.9.0-beta.2 P2-A — wire the rule-based template-match
            // event sink onto the daemon's long-lived co-thinker engine.
            // Without this, daemon-driven heartbeats would still evaluate
            // templates but emit them through `NoopSink` (silent). The
            // manual-trigger Tauri command (`co_thinker_trigger_heartbeat`)
            // installs its own sink per-call, so this only affects the
            // background heartbeat path.
            {
                use tangerine_meeting_lib::agi::templates::common::TauriEventSink;
                let sink = std::sync::Arc::new(TauriEventSink::new(app.handle().clone()));
                daemon_control.install_event_sink(sink);
            }
            state.daemon.install(daemon_control);
            // Close the cold-start probe (warns if > 2s budget)
            let _ = cold_start_probe.finish();
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

/// Count the .md files under the proposals dir. Used by the tray label
/// poll loop. Missing dir → 0 (the co-thinker hasn't created its first
/// proposal yet); read errors → keep last count by returning 0 (the
/// label's `last_count` guard means we don't spam updates).
fn count_active_proposals(root: &std::path::Path) -> usize {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut n = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_md = path
            .extension()
            .map(|e| e.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if is_md {
            n += 1;
        }
    }
    n
}
