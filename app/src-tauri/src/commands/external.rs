//! `open_external`, `show_in_folder`, `open_in_editor`, `system_notify`,
//! `export_debug_bundle`, `detect_claude_cli`, `validate_target_repo`.
//!
//! These wrap shell-out calls and OS-default-handler invocations.

use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

use super::runner::run_oneshot;
use super::{AppError, AppState};

#[derive(Debug, Deserialize)]
pub struct OpenExternalArgs {
    pub url: String,
}

#[tauri::command]
pub async fn open_external(args: OpenExternalArgs) -> Result<(), AppError> {
    open_with_default_handler(&args.url)
}

#[derive(Debug, Deserialize)]
pub struct OpenInEditorArgs {
    pub path: PathBuf,
    #[serde(default)]
    pub line: Option<u32>,
}
#[tauri::command]
pub async fn open_in_editor(args: OpenInEditorArgs) -> Result<(), AppError> {
    // Prefer VS Code if present.
    let path_str = args
        .path
        .to_str()
        .ok_or_else(|| AppError::internal("non_utf8_path", format!("{:?}", args.path)))?;
    let code_arg = match args.line {
        Some(line) => format!("{}:{}", path_str, line),
        None => path_str.to_string(),
    };
    if which_first(&["code", "cursor"]).is_some() {
        let _ = StdCommand::new(which_first(&["code", "cursor"]).unwrap())
            .arg("--goto")
            .arg(&code_arg)
            .spawn();
        return Ok(());
    }
    open_with_default_handler(path_str)
}

#[derive(Debug, Deserialize)]
pub struct ShowInFolderArgs {
    pub path: PathBuf,
}
#[tauri::command]
pub async fn show_in_folder(args: ShowInFolderArgs) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        let p = args
            .path
            .to_str()
            .ok_or_else(|| AppError::internal("non_utf8_path", format!("{:?}", args.path)))?;
        // /select, opens the parent and highlights the file. The trailing comma
        // is required by explorer.exe — don't "fix" it.
        StdCommand::new("explorer.exe")
            .arg(format!("/select,{}", p))
            .spawn()
            .map_err(|e| AppError::external("explorer", e.to_string()))?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        open_with_default_handler(
            args.path
                .to_str()
                .ok_or_else(|| AppError::internal("non_utf8_path", format!("{:?}", args.path)))?,
        )?;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
pub struct NotifyArgs {
    pub title: String,
    pub body: String,
}

#[tauri::command]
pub async fn system_notify<R: Runtime>(
    app: AppHandle<R>,
    args: NotifyArgs,
) -> Result<(), AppError> {
    // Use Tauri 2's notification plugin if T1 wires it up; fall back to no-op.
    let _ = app;
    tracing::info!(title=%args.title, body=%args.body, "system_notify");
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct DebugBundleArgs {
    pub dest_path: PathBuf,
}
#[derive(Debug, Serialize)]
pub struct DebugBundleResult {
    pub zip_path: PathBuf,
    pub file_count: u32,
}

#[tauri::command]
pub async fn export_debug_bundle(
    state: State<'_, AppState>,
    args: DebugBundleArgs,
) -> Result<DebugBundleResult, AppError> {
    // v1.5.0-beta: stub — write a single text manifest. T6 will implement
    // proper zip + sanitization. We return a deterministic shape so the UI
    // can be developed in parallel.
    let manifest = format!(
        "TangerineMeeting Debug Bundle\nlogs_dir: {:?}\nuser_data: {:?}\n",
        state.paths.logs_dir, state.paths.user_data
    );
    if let Some(parent) = args.dest_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&args.dest_path, manifest)?;
    Ok(DebugBundleResult {
        zip_path: args.dest_path,
        file_count: 1,
    })
}

#[derive(Debug, Serialize)]
pub struct ClaudeCliResult {
    pub found: bool,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
}

#[tauri::command]
pub async fn detect_claude_cli() -> Result<ClaudeCliResult, AppError> {
    let path = which_first(&["claude"]);
    let path = match path {
        Some(p) => p,
        None => {
            return Ok(ClaudeCliResult {
                found: false,
                path: None,
                version: None,
            })
        }
    };
    let (status, stdout, _) = run_oneshot(&path, &["--version"], None).await?;
    if !status.success() {
        return Ok(ClaudeCliResult {
            found: true,
            path: Some(path),
            version: None,
        });
    }
    let version = stdout.lines().next().map(|s| s.trim().to_string());
    Ok(ClaudeCliResult {
        found: true,
        path: Some(path),
        version,
    })
}

#[derive(Debug, Deserialize)]
pub struct ValidateRepoArgs {
    pub path: PathBuf,
}

#[derive(Debug, Serialize)]
pub struct ValidateRepoResult {
    pub ok: bool,
    pub has_claude_md: bool,
    pub has_knowledge: bool,
    pub has_cursorrules: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn validate_target_repo(
    args: ValidateRepoArgs,
) -> Result<ValidateRepoResult, AppError> {
    if !args.path.is_dir() {
        return Ok(ValidateRepoResult {
            ok: false,
            has_claude_md: false,
            has_knowledge: false,
            has_cursorrules: false,
            error: Some("path is not a directory".into()),
        });
    }
    let git_path = which_first(&["git"]).ok_or_else(|| {
        AppError::external("git_missing", "git executable not found on PATH")
    })?;
    let (status, _stdout, stderr) = run_oneshot(
        &git_path,
        &["rev-parse", "--is-inside-work-tree"],
        Some(&args.path),
    )
    .await?;
    if !status.success() {
        return Ok(ValidateRepoResult {
            ok: false,
            has_claude_md: false,
            has_knowledge: false,
            has_cursorrules: false,
            error: Some(stderr.trim().to_string()),
        });
    }
    Ok(ValidateRepoResult {
        ok: true,
        has_claude_md: args.path.join("CLAUDE.md").is_file(),
        has_knowledge: args.path.join("knowledge").is_dir(),
        has_cursorrules: args.path.join(".cursorrules").is_file(),
        error: None,
    })
}

// --- helpers ----------------------------------------------------------------

fn open_with_default_handler(target: &str) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        // `cmd /c start "" "<url>"` is the safest invocation for paths/URLs
        // that contain spaces; the empty quoted title is required.
        StdCommand::new("cmd")
            .args(["/c", "start", "", target])
            .spawn()
            .map_err(|e| AppError::external("start", e.to_string()))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        StdCommand::new("open")
            .arg(target)
            .spawn()
            .map_err(|e| AppError::external("open", e.to_string()))?;
        Ok(())
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        StdCommand::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| AppError::external("xdg-open", e.to_string()))?;
        Ok(())
    }
}

fn which_first(candidates: &[&str]) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let exts: Vec<&str> = if cfg!(windows) {
        vec!["", ".exe", ".cmd", ".bat"]
    } else {
        vec![""]
    };
    for dir in std::env::split_paths(&path_var) {
        for cand in candidates {
            for ext in &exts {
                let p = dir.join(format!("{}{}", cand, ext));
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    None
}

#[allow(dead_code)]
fn _ensure_path_referenced(_p: &Path) {}
