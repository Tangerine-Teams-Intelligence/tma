//! `start_bot` / `stop_bot` / `bot_status` — drive the frozen Node Discord bot.
//!
//! Per APP-INTERFACES.md §4.3, the bot's lifecycle is independent of any
//! particular `tmi` run: `start_bot` spawns it, the bot writes its own PID
//! to `status.yaml.bot.pid`, and `stop_bot` sends a graceful Ctrl+Break (on
//! Windows) before falling back to SIGKILL after 10s.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
use tauri::{AppHandle, Runtime, State};

use super::runner::{self, KillSignal};
use super::{AppError, AppState};

/// Map `meeting_id` → in-flight bot run.
pub type BotTable = HashMap<String, BotEntry>;

#[derive(Debug, Clone)]
pub struct BotEntry {
    pub run_id: String,
    pub pid: Option<u32>,
    pub meeting_dir: PathBuf,
}

#[derive(Debug, Deserialize)]
pub struct StartBotArgs {
    pub meeting_id: String,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Serialize)]
pub struct StartBotResult {
    pub run_id: String,
    pub pid: Option<u32>,
}

#[tauri::command]
pub async fn start_bot<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    args: StartBotArgs,
) -> Result<StartBotResult, AppError> {
    if !state.paths.bot_present() {
        return Err(AppError::config(
            "bot_not_bundled",
            format!(
                "frozen bot missing at {:?} — run scripts/build_bot.ps1 then rebuild the app",
                state.paths.bot_exe
            ),
        ));
    }

    let meeting_dir = state
        .paths
        .meetings_repo
        .join("meetings")
        .join(&args.meeting_id);
    if !meeting_dir.is_dir() {
        return Err(AppError::user(
            "meeting_not_found",
            format!("{:?}", meeting_dir),
        ));
    }

    let mut cli_args: Vec<String> = vec![
        "--meeting-id".into(),
        args.meeting_id.clone(),
        "--meeting-dir".into(),
        meeting_dir.to_string_lossy().into_owned(),
        "--config".into(),
        state.paths.config_path.to_string_lossy().into_owned(),
    ];
    if args.dry_run {
        cli_args.push("--dry-run".into());
    }

    let env_overrides = super::env::load_env_file(&state.paths.env_file).unwrap_or_default();

    let run_id = runner::spawn_streamed(
        app,
        &state.paths.bot_exe,
        &cli_args,
        Some(&meeting_dir),
        &env_overrides,
        "bot",
        state.runs.clone(),
    )
    .await?;

    let entry = BotEntry {
        run_id: run_id.clone(),
        pid: state
            .runs
            .get(&run_id)
            .and_then(|_| Some(0)) // pid is captured inside runner; we just record presence
            .or(None),
        meeting_dir: meeting_dir.clone(),
    };
    state.bots.write().insert(args.meeting_id.clone(), entry);

    Ok(StartBotResult { run_id, pid: None })
}

#[derive(Debug, Deserialize)]
pub struct StopBotArgs {
    pub meeting_id: String,
}

#[tauri::command]
pub async fn stop_bot(
    state: State<'_, AppState>,
    args: StopBotArgs,
) -> Result<(), AppError> {
    let entry = state.bots.write().remove(&args.meeting_id).ok_or_else(|| {
        AppError::user("bot_not_running", args.meeting_id.clone())
    })?;
    let h = state
        .runs
        .get(&entry.run_id)
        .ok_or_else(|| AppError::user("run_not_found", entry.run_id.clone()))?;
    let _ = h.kill_tx.send(KillSignal::Term).await;
    // 10s grace, then SIGKILL fallback.
    let kill_tx = h.kill_tx.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        let _ = kill_tx.send(KillSignal::Kill).await;
    });
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct BotStatusArgs {
    pub meeting_id: String,
}

#[derive(Debug, Serialize)]
pub struct BotStatus {
    pub pid: Option<u32>,
    pub voice_channel_id: Option<String>,
}

#[tauri::command]
pub async fn bot_status(
    state: State<'_, AppState>,
    args: BotStatusArgs,
) -> Result<BotStatus, AppError> {
    // Trust status.yaml on disk per INTERFACES.md §5.4 — bot writes its own PID.
    let status_path = state
        .paths
        .meetings_repo
        .join("meetings")
        .join(&args.meeting_id)
        .join("status.yaml");
    if !status_path.is_file() {
        return Ok(BotStatus { pid: None, voice_channel_id: None });
    }
    let raw = std::fs::read_to_string(&status_path)?;
    let v: serde_yaml::Value = serde_yaml::from_str(&raw)?;
    let pid = v
        .get("bot")
        .and_then(|b| b.get("pid"))
        .and_then(|p| p.as_u64())
        .map(|p| p as u32);
    let voice_channel_id = v
        .get("bot")
        .and_then(|b| b.get("voice_channel_id"))
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    // Reconcile with sysinfo: if PID set but process is dead, return None.
    let pid = pid.and_then(|p| {
        let mut sys = System::new_with_specifics(
            RefreshKind::new().with_processes(ProcessRefreshKind::new()),
        );
        sys.refresh_processes();
        sys.process(Pid::from_u32(p)).map(|_| p)
    });
    Ok(BotStatus { pid, voice_channel_id })
}
