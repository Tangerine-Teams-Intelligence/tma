//! Local Whisper model management. Two commands:
//!
//!   - `get_whisper_model_status` -> { state, path, bytes }
//!   - `download_whisper_model { size }` -> { download_id }, streams JSON-line
//!     events on channel `whisper:download:<download_id>`.
//!
//! The model is downloaded by the bundled Python (`<resource>/python/python.exe
//! -m tmi.model_download --model <size> --dest <user_data>/models/`). Each
//! stdout line of the downloader is a JSON event we forward verbatim to the
//! frontend so the UI can render a progress bar.
//!
//! Cache layout:
//!   <user_data>/models/faster-whisper-<size>-int8/
//!     ├── config.json
//!     ├── model.bin
//!     └── tokenizer.json (etc.)

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use super::{AppError, AppState};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize, Clone)]
pub struct WhisperModelStatus {
    /// "unknown" | "missing" | "ready"
    pub state: String,
    pub path: Option<PathBuf>,
    /// Bytes on disk (best-effort sum).
    pub bytes: u64,
}

fn model_dir(user_data: &std::path::Path, size: &str) -> PathBuf {
    user_data
        .join("models")
        .join(format!("faster-whisper-{}-int8", size))
}

fn dir_size(p: &std::path::Path) -> u64 {
    let mut total: u64 = 0;
    if let Ok(rd) = std::fs::read_dir(p) {
        for entry in rd.flatten() {
            let path = entry.path();
            if let Ok(meta) = entry.metadata() {
                if meta.is_dir() {
                    total = total.saturating_add(dir_size(&path));
                } else {
                    total = total.saturating_add(meta.len());
                }
            }
        }
    }
    total
}

#[tauri::command]
pub async fn get_whisper_model_status(
    state: State<'_, AppState>,
) -> Result<WhisperModelStatus, AppError> {
    // Default to "small". v1.5 ships a single bundled size; if a future build
    // supports multiple, pass `size` and switch.
    let dir = model_dir(&state.paths.user_data, "small");
    if !dir.is_dir() {
        return Ok(WhisperModelStatus {
            state: "missing".into(),
            path: None,
            bytes: 0,
        });
    }
    // Heuristic readiness: model.bin exists.
    let ready = dir.join("model.bin").is_file();
    Ok(WhisperModelStatus {
        state: if ready { "ready".into() } else { "missing".into() },
        path: Some(dir.clone()),
        bytes: dir_size(&dir),
    })
}

#[derive(Debug, Serialize)]
pub struct DownloadStarted {
    pub download_id: String,
}

/// Spawn `<bundled-python> -m tmi.model_download --model <size> --dest <root>`.
/// Returns immediately with a `download_id`; progress events fire on
/// `whisper:download:<download_id>`. Caller listens via `@tauri-apps/api/event`.
///
/// JS contract: `invoke("download_whisper_model", { size: "small" | "base" | "medium" })`.
/// The `size` parameter is optional; defaults to "small" when omitted/null.
#[tauri::command]
pub async fn download_whisper_model<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    size: Option<String>,
) -> Result<DownloadStarted, AppError> {
    let size = size.unwrap_or_else(|| "small".into());
    let python = state.paths.python_exe.clone();
    if !python.is_file() {
        return Err(AppError::config(
            "python_missing",
            format!(
                "bundled python not found at {:?} — run scripts/build_python.ps1",
                python
            ),
        ));
    }
    let dest_root = state.paths.user_data.join("models");
    std::fs::create_dir_all(&dest_root)?;

    let download_id = Uuid::new_v4().to_string();
    let channel = format!("whisper:download:{}", download_id);

    let app_clone = app.clone();
    let channel_clone = channel.clone();

    let mut cmd = Command::new(&python);
    cmd.arg("-m")
        .arg("tmi.model_download")
        .arg("--model")
        .arg(&size)
        .arg("--dest")
        .arg(&dest_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        AppError::internal(
            "spawn_failed",
            format!("python -m tmi.model_download: {}", e),
        )
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        AppError::internal("no_stdout", "model_download stdout pipe missing")
    })?;
    let stderr = child.stderr.take();

    // Track the running download so the frontend can cancel.
    let registry: Arc<AsyncMutex<Option<tokio::process::Child>>> =
        Arc::new(AsyncMutex::new(Some(child)));
    {
        let mut tbl = state.downloads.lock();
        tbl.insert(download_id.clone(), registry.clone());
    }

    // stdout pump: each line is a JSON event from tmi.model_download.
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            // Forward the parsed JSON object verbatim. If parsing fails, wrap
            // it so the UI still gets something.
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(v) => {
                    let _ = app_clone.emit(&channel_clone, v);
                }
                Err(_) => {
                    let _ = app_clone.emit(
                        &channel_clone,
                        serde_json::json!({"event": "log", "line": line}),
                    );
                }
            }
        }
        // Wait for child to exit so we can emit a terminal event if needed.
        let mut guard = registry.lock().await;
        if let Some(mut child) = guard.take() {
            let status = child.wait().await.ok();
            let code = status.and_then(|s| s.code()).unwrap_or(-1);
            if code != 0 {
                let _ = app_clone.emit(
                    &channel_clone,
                    serde_json::json!({
                        "event": "error",
                        "message": format!("downloader exited with code {}", code),
                    }),
                );
            }
        }
    });

    // stderr pump: surface as log events. Helpful for diagnosing missing deps.
    if let Some(stderr) = stderr {
        let app_clone = app.clone();
        let channel_clone = channel.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_clone.emit(
                    &channel_clone,
                    serde_json::json!({"event": "stderr", "line": line}),
                );
            }
        });
    }

    Ok(DownloadStarted { download_id })
}

/// JS contract: `invoke("cancel_whisper_download", { downloadId: "<uuid>" })`.
/// (Tauri 2 auto-camelCases parameter names — Rust `download_id` ↔ JS `downloadId`.)
#[tauri::command(rename_all = "snake_case")]
pub async fn cancel_whisper_download(
    state: State<'_, AppState>,
    download_id: String,
) -> Result<(), AppError> {
    let entry = {
        let mut tbl = state.downloads.lock();
        tbl.remove(&download_id)
    };
    if let Some(reg) = entry {
        let mut guard = reg.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.kill().await;
        }
    }
    Ok(())
}

// Helper used by AppState::build to give us a concurrent table for active
// downloads. Keeping it here so AppState changes are minimal.
pub type DownloadTable =
    std::collections::HashMap<String, Arc<AsyncMutex<Option<tokio::process::Child>>>>;
