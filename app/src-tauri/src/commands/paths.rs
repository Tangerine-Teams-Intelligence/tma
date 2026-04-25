//! Path resolution. Critical: these paths MUST tolerate non-ASCII parents and
//! spaces. The target machine path is `C:\Users\daizhe zo\Desktop\meeting-live\`
//! which has both. We always store paths as `PathBuf` (OS-native) and only
//! convert to a `&str` at the last possible moment.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use super::AppError;

/// Bundle of canonical paths used across the app. Resolved once at startup.
#[derive(Debug, Clone)]
pub struct AppPaths {
    /// `~/.tmi/config.yaml` — owned by T1's wizard but read by many commands.
    pub config_path: PathBuf,
    /// User data dir: `%LOCALAPPDATA%\TangerineMeeting\`.
    pub user_data: PathBuf,
    /// `%LOCALAPPDATA%\TangerineMeeting\.env` — see env.rs (de-scoped from
    /// Registry per CEO direction 2026-04-24).
    pub env_file: PathBuf,
    /// `%LOCALAPPDATA%\TangerineMeeting\logs\`.
    pub logs_dir: PathBuf,
    /// Where the wizard placed `meetings/` after `tmi init`.
    pub meetings_repo: PathBuf,
    /// Frozen Python interpreter inside the bundle:
    /// `<resource_dir>/resources/python/python.exe` on Windows.
    pub python_exe: PathBuf,
    /// Frozen Node bot binary:
    /// `<resource_dir>/resources/bot/tangerine-meeting-bot.exe` on Windows.
    pub bot_exe: PathBuf,
}

impl AppPaths {
    pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> Result<Self, AppError> {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| AppError::internal("resource_dir", e.to_string()))?;

        let user_data = resolve_user_data_dir()?;
        std::fs::create_dir_all(&user_data)
            .map_err(|e| AppError::internal("mkdir_user_data", e.to_string()))?;
        let logs_dir = user_data.join("logs");
        std::fs::create_dir_all(&logs_dir)
            .map_err(|e| AppError::internal("mkdir_logs", e.to_string()))?;
        let env_file = user_data.join(".env");

        let home = dirs::home_dir()
            .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
        let config_path = home.join(".tmi").join("config.yaml");

        // meetings_repo defaults to user_data/meetings; the wizard may have
        // overridden via tmi init — we re-read from config when available.
        let mut meetings_repo = user_data.join("meetings");
        if let Ok(yaml) = std::fs::read_to_string(&config_path) {
            if let Ok(v) = serde_yaml::from_str::<serde_yaml::Value>(&yaml) {
                if let Some(p) = v.get("meetings_repo").and_then(|x| x.as_str()) {
                    meetings_repo = PathBuf::from(p);
                }
            }
        }

        // Bundled runtime locations. PyInstaller --onedir output is copied
        // into resources/python at build time; pkg output into resources/bot.
        let (python_exe, bot_exe) = if cfg!(windows) {
            (
                resource_dir.join("resources/python/python.exe"),
                resource_dir.join("resources/bot/tangerine-meeting-bot.exe"),
            )
        } else {
            (
                resource_dir.join("resources/python/bin/python"),
                resource_dir.join("resources/bot/tangerine-meeting-bot"),
            )
        };

        Ok(Self {
            config_path,
            user_data,
            env_file,
            logs_dir,
            meetings_repo,
            python_exe,
            bot_exe,
        })
    }

    /// Returns true if the bundled python binary exists. Used by the wizard
    /// "frozen runtime" preflight check.
    pub fn python_present(&self) -> bool {
        self.python_exe.is_file()
    }
    pub fn bot_present(&self) -> bool {
        self.bot_exe.is_file()
    }

    /// Convert a path to a UTF-8 str for subprocess args. Returns an error
    /// rather than silently lossy-converting — paths with surrogate pairs on
    /// Windows would otherwise produce garbage on the Python side.
    pub fn as_subprocess_arg(p: &Path) -> Result<&str, AppError> {
        p.to_str().ok_or_else(|| {
            AppError::internal(
                "non_utf8_path",
                format!("path {:?} not representable as UTF-8", p),
            )
        })
    }
}

#[cfg(windows)]
fn resolve_user_data_dir() -> Result<PathBuf, AppError> {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        return Ok(PathBuf::from(local).join("TangerineMeeting"));
    }
    Ok(dirs::data_local_dir()
        .ok_or_else(|| AppError::internal("local_appdata", "LOCALAPPDATA unresolved"))?
        .join("TangerineMeeting"))
}

#[cfg(not(windows))]
fn resolve_user_data_dir() -> Result<PathBuf, AppError> {
    Ok(dirs::data_local_dir()
        .ok_or_else(|| AppError::internal("local_data", "data_local_dir() unresolved"))?
        .join("TangerineMeeting"))
}
