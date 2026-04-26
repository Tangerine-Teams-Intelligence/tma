//! Memory layer commands.
//!
//! `resolve_memory_root` returns the absolute path to the user's memory dir
//! (`<home>/.tangerine-memory/`). The frontend uses this instead of guessing
//! `$HOME` via brittle string handling.
//!
//! `init_memory_with_samples` is called on first-run when the memory dir is
//! empty. It copies the bundled sample files (under `<resource>/sample-memory/`)
//! into the user's memory dir so the Memory browser shows a populated tree
//! immediately. Returns the resolved root path so the caller can refresh.
//!
//! Both commands are idempotent and never crash on missing dirs / permission
//! errors — they degrade to a no-op + return the path so the UI stays usable.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use super::AppError;

/// Default memory root: `<home>/.tangerine-memory/`. Created on demand.
fn memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

#[derive(Debug, Serialize)]
pub struct MemoryRootInfo {
    pub path: String,
    pub exists: bool,
    pub is_empty: bool,
}

#[tauri::command]
pub async fn resolve_memory_root() -> Result<MemoryRootInfo, AppError> {
    let root = memory_root()?;
    let exists = root.is_dir();
    let is_empty = if exists {
        match std::fs::read_dir(&root) {
            Ok(mut it) => it.next().is_none(),
            Err(_) => true,
        }
    } else {
        true
    };
    Ok(MemoryRootInfo {
        path: root.to_string_lossy().to_string(),
        exists,
        is_empty,
    })
}

#[derive(Debug, Serialize)]
pub struct InitMemoryResult {
    /// Resolved memory root.
    pub path: String,
    /// True when sample files were just copied. False when the dir was already
    /// populated (or copy failed silently — see `error`).
    pub seeded: bool,
    /// Number of files copied. 0 when `seeded` is false.
    pub copied: u32,
    /// Optional error when copy failed but we still resolved a path.
    pub error: Option<String>,
}

#[tauri::command]
pub async fn init_memory_with_samples<R: Runtime>(
    app: AppHandle<R>,
) -> Result<InitMemoryResult, AppError> {
    let root = memory_root()?;
    let path_str = root.to_string_lossy().to_string();

    // mkdir -p the memory root (no-op if it exists).
    if let Err(e) = std::fs::create_dir_all(&root) {
        return Ok(InitMemoryResult {
            path: path_str,
            seeded: false,
            copied: 0,
            error: Some(format!("mkdir failed: {}", e)),
        });
    }

    // Only seed if dir is empty — never overwrite the user's own files.
    let already_populated = match std::fs::read_dir(&root) {
        Ok(mut it) => it.next().is_some(),
        Err(_) => false,
    };
    if already_populated {
        return Ok(InitMemoryResult {
            path: path_str,
            seeded: false,
            copied: 0,
            error: None,
        });
    }

    // Resolve the bundled sample dir from the Tauri resource dir. In `tauri
    // dev` this is the source `resources/`; in installed builds it's the
    // app-relative resource dir set by the bundle config.
    let resource_dir = match app.path().resource_dir() {
        Ok(r) => r,
        Err(e) => {
            return Ok(InitMemoryResult {
                path: path_str,
                seeded: false,
                copied: 0,
                error: Some(format!("resource_dir failed: {}", e)),
            });
        }
    };
    let sample_root = resource_dir.join("resources").join("sample-memory");
    let sample_root = if sample_root.is_dir() {
        sample_root
    } else {
        // Fallback for `cargo tauri dev` where resources/ may live one level up
        // from the resource_dir. Try the dev path before giving up.
        resource_dir.join("sample-memory")
    };

    if !sample_root.is_dir() {
        return Ok(InitMemoryResult {
            path: path_str,
            seeded: false,
            copied: 0,
            error: Some(format!(
                "sample-memory dir not found at {}",
                sample_root.display()
            )),
        });
    }

    let mut copied: u32 = 0;
    if let Err(e) = copy_dir_recursive(&sample_root, &root, &mut copied) {
        return Ok(InitMemoryResult {
            path: path_str,
            seeded: false,
            copied,
            error: Some(format!("copy failed: {}", e)),
        });
    }

    Ok(InitMemoryResult {
        path: path_str,
        seeded: true,
        copied,
        error: None,
    })
}

fn copy_dir_recursive(src: &Path, dst: &Path, count: &mut u32) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&from, &to, count)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)?;
            *count += 1;
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ResetSamplesArgs {
    pub confirm: bool,
}
