//! Subprocess runner: spawns frozen Python / Node binaries, streams their
//! stdout/stderr line-by-line over Tauri events, and exposes stdin write +
//! kill operations to the IPC layer.
//!
//! Design notes:
//! - Stdout is **not** buffered to end-of-process. We use a tokio
//!   `BufReader::lines()` loop so each line is emitted as it arrives.
//! - Run IDs are UUIDv4; they double as the Tauri event channel suffix
//!   (`tmi:stdout:<run_id>`).
//! - On Windows we set `CREATE_NO_WINDOW` to suppress the flashing console
//!   that PyInstaller --onedir would otherwise spawn.
//! - We never quote-escape arguments ourselves. `Command::arg()` handles that
//!   correctly for paths containing spaces — a common pitfall on the
//!   `C:\Users\daizhe zo\...` test machine.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;
use uuid::Uuid;

use super::AppError;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize, Clone)]
pub struct LineEvent {
    pub line: String,
    pub ts: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ExitEvent {
    pub code: Option<i32>,
    pub signal: Option<String>,
}

/// Live process registry. One entry per active subprocess; cleaned up on exit.
pub struct ProcessRegistry {
    inner: Mutex<HashMap<String, RunHandle>>,
}

impl Default for ProcessRegistry {
    fn default() -> Self {
        Self { inner: Mutex::new(HashMap::new()) }
    }
}

pub struct RunHandle {
    pub run_id: String,
    pub stdin_tx: mpsc::Sender<StdinMsg>,
    pub kill_tx: mpsc::Sender<KillSignal>,
    pub pid: Option<u32>,
}

pub enum StdinMsg {
    Line(String),
    Close,
}

pub enum KillSignal {
    Term,
    Kill,
}

impl ProcessRegistry {
    pub fn insert(&self, h: RunHandle) {
        self.inner.lock().insert(h.run_id.clone(), h);
    }

    pub fn get(&self, run_id: &str) -> Option<RunHandleRef> {
        self.inner.lock().get(run_id).map(|h| RunHandleRef {
            stdin_tx: h.stdin_tx.clone(),
            kill_tx: h.kill_tx.clone(),
        })
    }

    pub fn remove(&self, run_id: &str) {
        self.inner.lock().remove(run_id);
    }
}

pub struct RunHandleRef {
    pub stdin_tx: mpsc::Sender<StdinMsg>,
    pub kill_tx: mpsc::Sender<KillSignal>,
}

/// Spawn a subprocess and wire stdout/stderr/stdin/exit through Tauri events.
/// Returns the run_id once the child is started.
pub async fn spawn_streamed<R: Runtime>(
    app: AppHandle<R>,
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    env_overrides: &[(String, String)],
    event_prefix: &str,
    registry: Arc<ProcessRegistry>,
) -> Result<String, AppError> {
    if !program.is_file() {
        return Err(AppError::config(
            "frozen_binary_missing",
            format!(
                "expected bundled binary at {:?} — run scripts/build_python.ps1 or scripts/build_bot.ps1 first",
                program
            ),
        ));
    }

    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    for (k, v) in env_overrides {
        cmd.env(k, v);
    }

    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Make sure long-running children don't keep the Tauri parent's console
    // attached if the user double-clicks the .exe.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child: Child = cmd.spawn().map_err(|e| {
        AppError::internal(
            "spawn_failed",
            format!("failed to spawn {:?}: {}", program, e),
        )
    })?;

    let pid = child.id();
    let run_id = Uuid::new_v4().to_string();
    let stdout = child.stdout.take().ok_or_else(|| {
        AppError::internal("no_stdout", "child stdout pipe missing")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        AppError::internal("no_stderr", "child stderr pipe missing")
    })?;
    let stdin = child.stdin.take().ok_or_else(|| {
        AppError::internal("no_stdin", "child stdin pipe missing")
    })?;

    let (stdin_tx, stdin_rx) = mpsc::channel::<StdinMsg>(32);
    let (kill_tx, mut kill_rx) = mpsc::channel::<KillSignal>(2);

    // Stdout pump
    {
        let app = app.clone();
        let prefix = event_prefix.to_string();
        let id = run_id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        let _ = app.emit(
                            &format!("{}:stdout:{}", prefix, id),
                            LineEvent {
                                line,
                                ts: chrono::Utc::now().to_rfc3339(),
                            },
                        );
                    }
                    Ok(None) => break,
                    Err(e) => {
                        tracing::warn!(error = %e, "stdout read error");
                        break;
                    }
                }
            }
        });
    }
    // Stderr pump
    {
        let app = app.clone();
        let prefix = event_prefix.to_string();
        let id = run_id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        let _ = app.emit(
                            &format!("{}:stderr:{}", prefix, id),
                            LineEvent {
                                line,
                                ts: chrono::Utc::now().to_rfc3339(),
                            },
                        );
                    }
                    Ok(None) => break,
                    Err(e) => {
                        tracing::warn!(error = %e, "stderr read error");
                        break;
                    }
                }
            }
        });
    }
    // Stdin pump
    tokio::spawn(stdin_pump(stdin, stdin_rx));

    // Wait + kill pump. We own the Child here so we can both await it and kill it.
    {
        let app = app.clone();
        let prefix = event_prefix.to_string();
        let id = run_id.clone();
        let registry_for_exit = registry.clone();
        tokio::spawn(async move {
            let exit_event = tokio::select! {
                status = child.wait() => match status {
                    Ok(s) => ExitEvent {
                        code: s.code(),
                        signal: None,
                    },
                    Err(e) => ExitEvent {
                        code: None,
                        signal: Some(format!("wait_error:{}", e)),
                    },
                },
                Some(sig) = kill_rx.recv() => {
                    let _ = match sig {
                        KillSignal::Term => child.start_kill(),
                        KillSignal::Kill => child.kill().await,
                    };
                    let status = child.wait().await.ok();
                    ExitEvent {
                        code: status.and_then(|s| s.code()),
                        signal: Some("killed".into()),
                    }
                }
            };
            let _ = app.emit(&format!("{}:exit:{}", prefix, id), exit_event);
            registry_for_exit.remove(&id);
        });
    }

    registry.insert(RunHandle {
        run_id: run_id.clone(),
        stdin_tx,
        kill_tx,
        pid,
    });

    Ok(run_id)
}

async fn stdin_pump(mut stdin: ChildStdin, mut rx: mpsc::Receiver<StdinMsg>) {
    while let Some(msg) = rx.recv().await {
        match msg {
            StdinMsg::Line(text) => {
                let mut buf = text.into_bytes();
                buf.push(b'\n');
                if let Err(e) = stdin.write_all(&buf).await {
                    tracing::warn!(error = %e, "stdin write failed");
                    break;
                }
                if let Err(e) = stdin.flush().await {
                    tracing::warn!(error = %e, "stdin flush failed");
                    break;
                }
            }
            StdinMsg::Close => break,
        }
    }
    let _ = stdin.shutdown().await;
}

/// Helper for callers that just want stdout collected and the exit status.
/// Used by short-lived helpers (`detect_claude_cli`, `validate_target_repo`).
pub async fn run_oneshot(
    program: &Path,
    args: &[&str],
    cwd: Option<&Path>,
) -> Result<(std::process::ExitStatus, String, String), AppError> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().await.map_err(|e| {
        AppError::internal("run_oneshot", format!("failed to run {:?}: {}", program, e))
    })?;
    Ok((
        out.status,
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// Build a PATH-independent Python invocation: `<frozen_python> -m tmi.cli ...`.
pub fn tmi_args(subcommand: &str, extra: &[String]) -> Vec<String> {
    let mut v = vec!["-m".into(), "tmi.cli".into(), subcommand.into()];
    v.extend(extra.iter().cloned());
    v
}

/// Convenience for callers that want a `Vec<String>` of OS path strings.
pub fn paths_as_strings(paths: &[PathBuf]) -> Result<Vec<String>, AppError> {
    paths
        .iter()
        .map(|p| {
            p.to_str()
                .map(|s| s.to_string())
                .ok_or_else(|| AppError::internal("non_utf8_path", format!("{:?}", p)))
        })
        .collect()
}
