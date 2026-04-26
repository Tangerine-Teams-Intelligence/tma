//! `get_config` / `set_config` — read & write `~/.tmi/config.yaml`.
//!
//! `set_config` validates against a minimal schema (mirrors INTERFACES.md §3),
//! atomic-renames the new content into place, and emits `config-changed` so
//! the React store reloads.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};

use super::{AppError, AppState};

#[derive(Debug, Serialize, Deserialize)]
pub struct GetConfigResult {
    pub yaml: String,
    pub parsed: serde_json::Value,
    pub exists: bool,
}

#[tauri::command]
pub async fn get_config(state: State<'_, AppState>) -> Result<GetConfigResult, AppError> {
    let path = &state.paths.config_path;
    if !path.is_file() {
        return Ok(GetConfigResult {
            yaml: String::new(),
            parsed: serde_json::Value::Null,
            exists: false,
        });
    }
    let yaml = std::fs::read_to_string(path)?;
    let parsed: serde_yaml::Value = serde_yaml::from_str(&yaml)?;
    // Round-trip via JSON for the React side (Tauri's invoke serializes JSON).
    let parsed_json = serde_json::to_value(parsed)?;
    Ok(GetConfigResult {
        yaml,
        parsed: parsed_json,
        exists: true,
    })
}

#[derive(Debug, Deserialize)]
pub struct SetConfigArgs {
    pub yaml: String,
}

#[tauri::command]
pub async fn set_config<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    args: SetConfigArgs,
) -> Result<(), AppError> {
    // Parse to validate. On parse error AppError::Config bubbles up.
    let parsed: serde_yaml::Value = serde_yaml::from_str(&args.yaml)?;
    validate_config(&parsed)?;

    let path = &state.paths.config_path;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Atomic write: write to <path>.tmp then rename. On Windows, std::fs::rename
    // is atomic when source + dest are on the same volume.
    let tmp = path.with_extension("yaml.tmp");
    std::fs::write(&tmp, &args.yaml)?;
    std::fs::rename(&tmp, path)?;

    let _ = app.emit("config-changed", ());
    Ok(())
}

fn validate_config(v: &serde_yaml::Value) -> Result<(), AppError> {
    let m = v
        .as_mapping()
        .ok_or_else(|| AppError::config("not_mapping", "config root must be a YAML mapping"))?;
    let required = [
        "schema_version",
        "meetings_repo",
        "team",
        "discord",
        "whisper",
        "claude",
        "output_adapters",
    ];
    for key in required {
        if !m.contains_key(serde_yaml::Value::String(key.into())) {
            return Err(AppError::config(
                "missing_field",
                format!("config missing required field '{}'", key),
            ));
        }
    }
    // Light type-checks — full schema lives in the CLI.
    if let Some(team) = m.get(serde_yaml::Value::String("team".into())) {
        if !team.is_sequence() {
            return Err(AppError::config("team_not_seq", "team must be a list"));
        }
    }
    if let Some(adapters) = m.get(serde_yaml::Value::String("output_adapters".into())) {
        if !adapters.is_sequence() {
            return Err(AppError::config(
                "adapters_not_seq",
                "output_adapters must be a list",
            ));
        }
    }
    Ok(())
}
