//! `run_tmi` and friends — spawn the frozen Python CLI, stream stdout
//! line-by-line, accept stdin for interactive `tmi prep`, expose kill.
//!
//! Event prefix: `tmi`
//!   tmi:stdout:<run_id> {line, ts}
//!   tmi:stderr:<run_id> {line, ts}
//!   tmi:exit:<run_id>   {code, signal}

use std::path::PathBuf;

use serde::Deserialize;
use tauri::{AppHandle, Runtime, State};

use super::env;
use super::runner::{self, KillSignal, StdinMsg};
use super::{AppError, AppState};

#[derive(Debug, Deserialize)]
pub struct RunTmiArgs {
    pub subcommand: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub meeting_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
}

#[derive(Debug, serde::Serialize)]
pub struct RunTmiResult {
    pub run_id: String,
}

#[tauri::command]
pub async fn run_tmi<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    args: RunTmiArgs,
) -> Result<RunTmiResult, AppError> {
    let allowed = [
        "prep", "new", "start", "wrap", "review", "apply", "list", "status", "init",
    ];
    if !allowed.contains(&args.subcommand.as_str()) {
        return Err(AppError::user(
            "unknown_subcommand",
            format!("subcommand '{}' not allowed", args.subcommand),
        ));
    }

    let python = state.paths.python_exe.clone();
    if !state.paths.python_present() {
        return Err(AppError::config(
            "python_not_bundled",
            format!(
                "frozen Python missing at {:?} — run scripts/build_python.ps1 then rebuild the app",
                python
            ),
        ));
    }

    let cwd = args
        .cwd
        .clone()
        .or_else(|| {
            if state.paths.meetings_repo.exists() {
                Some(state.paths.meetings_repo.clone())
            } else {
                None
            }
        });

    let mut full_args = runner::tmi_args(&args.subcommand, &args.args);

    // For commands that target a meeting, append --meeting-id if not already present.
    if let Some(mid) = &args.meeting_id {
        if !args.args.iter().any(|a| a == "--meeting-id" || a == "--id") {
            // The CLI uses positional id for most commands per INTERFACES.md §4 —
            // but if caller passed an explicit subcommand like `status` we still
            // forward it. Append after subcommand only if subcommand is one that
            // takes an id positionally.
            let positional = ["prep", "start", "wrap", "review", "apply", "status"];
            if positional.contains(&args.subcommand.as_str()) {
                full_args.insert(3, mid.clone());
            }
        }
    }

    // Inject the user-scoped .env so the Python CLI inherits secrets without
    // requiring shell restart. (Replaces the Registry write that the original
    // T0 spec called for; see env.rs for the de-scoping note.)
    let env_overrides = env::load_env_file(&state.paths.env_file).unwrap_or_default();

    tracing::info!(
        subcommand = %args.subcommand,
        n_args = full_args.len(),
        cwd = ?cwd,
        "spawning tmi"
    );

    let run_id = runner::spawn_streamed(
        app,
        &python,
        &full_args,
        cwd.as_deref(),
        &env_overrides,
        "tmi",
        state.runs.clone(),
    )
    .await?;

    Ok(RunTmiResult { run_id })
}

#[derive(Debug, Deserialize)]
pub struct StdinArgs {
    pub run_id: String,
    pub text: String,
}

#[tauri::command]
pub async fn run_tmi_send_stdin(
    state: State<'_, AppState>,
    args: StdinArgs,
) -> Result<(), AppError> {
    let h = state
        .runs
        .get(&args.run_id)
        .ok_or_else(|| AppError::user("run_not_found", args.run_id.clone()))?;
    h.stdin_tx
        .send(StdinMsg::Line(args.text))
        .await
        .map_err(|e| AppError::internal("stdin_send", e.to_string()))?;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct KillArgs {
    pub run_id: String,
    #[serde(default = "default_term")]
    pub signal: String,
}
fn default_term() -> String { "TERM".into() }

#[tauri::command]
pub async fn run_tmi_kill(
    state: State<'_, AppState>,
    args: KillArgs,
) -> Result<(), AppError> {
    let h = state
        .runs
        .get(&args.run_id)
        .ok_or_else(|| AppError::user("run_not_found", args.run_id.clone()))?;
    let sig = match args.signal.as_str() {
        "KILL" => KillSignal::Kill,
        _ => KillSignal::Term,
    };
    h.kill_tx
        .send(sig)
        .await
        .map_err(|e| AppError::internal("kill_send", e.to_string()))?;
    Ok(())
}
