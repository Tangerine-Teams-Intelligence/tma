//! `tail_file` + `watch_meeting` — file-system push channels.
//!
//! `tail_file` polls a file's length every 250ms (the `notify` crate fires
//! events for *changes* but doesn't tell you what was appended; we still need
//! to do the seek-to-end-of-known-length-then-read dance ourselves). For the
//! transcript live tail this is the right approach.
//!
//! `watch_meeting` uses `notify-debouncer-mini` to fire `fs:meeting-changed`
//! events (200ms debounce) so the React store can react to file mutations
//! emitted by `tmi`/`bot` running outside the app.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use notify::{EventKind, RecursiveMode};
use notify_debouncer_mini::new_debouncer;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::oneshot;
use uuid::Uuid;

use super::{AppError, AppState};

#[derive(Default)]
pub struct WatcherTable {
    pub watchers: HashMap<String, oneshot::Sender<()>>,
}

#[derive(Debug, Deserialize)]
pub struct TailFileArgs {
    pub path: PathBuf,
}
#[derive(Debug, Serialize)]
pub struct TailFileResult {
    pub tail_id: String,
}

#[tauri::command]
pub async fn tail_file<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    args: TailFileArgs,
) -> Result<TailFileResult, AppError> {
    let tail_id = Uuid::new_v4().to_string();
    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    state.watchers.write().watchers.insert(tail_id.clone(), stop_tx);

    let path = args.path.clone();
    let id = tail_id.clone();
    tokio::spawn(async move {
        let mut last_len: u64 = 0;
        if let Ok(meta) = tokio::fs::metadata(&path).await {
            last_len = meta.len();
        }
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                _ = tokio::time::sleep(Duration::from_millis(250)) => {
                    let cur_len = match tokio::fs::metadata(&path).await {
                        Ok(m) => m.len(),
                        Err(_) => continue,
                    };
                    if cur_len <= last_len { continue; }
                    let mut f = match tokio::fs::File::open(&path).await {
                        Ok(f) => f,
                        Err(_) => continue,
                    };
                    if f.seek(std::io::SeekFrom::Start(last_len)).await.is_err() { continue; }
                    let mut buf = Vec::with_capacity((cur_len - last_len) as usize);
                    if f.read_to_end(&mut buf).await.is_err() { continue; }
                    last_len = cur_len;
                    let text = String::from_utf8_lossy(&buf);
                    for line in text.lines() {
                        let _ = app.emit(&format!("fs:tail:{}", id), serde_json::json!({"line": line}));
                    }
                }
            }
        }
    });

    Ok(TailFileResult { tail_id })
}

#[derive(Debug, Deserialize)]
pub struct UntailArgs {
    pub tail_id: String,
}

#[tauri::command]
pub async fn untail_file(
    state: State<'_, AppState>,
    args: UntailArgs,
) -> Result<(), AppError> {
    if let Some(tx) = state.watchers.write().watchers.remove(&args.tail_id) {
        let _ = tx.send(());
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct WatchMeetingArgs {
    pub meeting_id: String,
}
#[derive(Debug, Serialize)]
pub struct WatchMeetingResult {
    pub watch_id: String,
}

#[tauri::command]
pub async fn watch_meeting<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    args: WatchMeetingArgs,
) -> Result<WatchMeetingResult, AppError> {
    let watch_id = Uuid::new_v4().to_string();
    let dir = state
        .paths
        .meetings_repo
        .join("meetings")
        .join(&args.meeting_id);
    if !dir.is_dir() {
        return Err(AppError::user("meeting_not_found", format!("{:?}", dir)));
    }

    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    state.watchers.write().watchers.insert(watch_id.clone(), stop_tx);

    let app_for_thread = app.clone();
    let id = watch_id.clone();
    let dir_for_thread = dir.clone();
    // notify-debouncer-mini uses a std thread; we keep the Tauri app handle
    // alive for it via clone.
    let alive = Arc::new(Mutex::new(true));
    let alive_for_stop = alive.clone();
    tokio::spawn(async move {
        let _ = stop_rx.await;
        *alive_for_stop.lock() = false;
    });
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut deb = match new_debouncer(Duration::from_millis(200), tx) {
            Ok(d) => d,
            Err(e) => {
                tracing::error!(error = %e, "failed to create debouncer");
                return;
            }
        };
        if let Err(e) = deb.watcher().watch(&dir_for_thread, RecursiveMode::Recursive) {
            tracing::error!(error = %e, "failed to start watcher");
            return;
        }
        for res in rx {
            if !*alive.lock() {
                break;
            }
            if let Ok(events) = res {
                for ev in events {
                    let kind = match ev.kind {
                        notify_debouncer_mini::DebouncedEventKind::Any => "modify",
                        notify_debouncer_mini::DebouncedEventKind::AnyContinuous => "modify",
                        _ => "modify",
                    };
                    let _ = app_for_thread.emit(
                        &format!("fs:meeting-changed:{}", id),
                        serde_json::json!({
                            "file": ev.path.to_string_lossy(),
                            "kind": kind,
                        }),
                    );
                }
            }
        }
    });

    let _ = EventKind::Any; // silence unused import on platforms without notify

    Ok(WatchMeetingResult { watch_id })
}

#[derive(Debug, Deserialize)]
pub struct UnwatchArgs {
    pub watch_id: String,
}
#[tauri::command]
pub async fn unwatch_meeting(
    state: State<'_, AppState>,
    args: UnwatchArgs,
) -> Result<(), AppError> {
    if let Some(tx) = state.watchers.write().watchers.remove(&args.watch_id) {
        let _ = tx.send(());
    }
    Ok(())
}
