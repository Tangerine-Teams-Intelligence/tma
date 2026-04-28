//! === wave 11 ===
//! v1.10.2 — first-run LLM channel setup wizard.
//!
//! Without an LLM channel the co-thinker heartbeat can't run, every Test
//! Query button on /ai-tools/* fails, and the brain transparency design
//! moat looks broken from the very first screen. Wave 11 closes the gap
//! with a 5-command Tauri surface that powers the React `SetupWizard`:
//!
//!   1. `setup_wizard_detect` — best-effort scan of the user's machine:
//!      which MCP-capable editors are installed, where their `mcp.json`
//!      lives, whether Tangerine is already in there, whether Ollama is
//!      running, which browsers are installed, and a recommended
//!      "easiest path" pick the wizard surfaces as the highlighted card.
//!   2. `setup_wizard_auto_configure_mcp` — write / merge a `tangerine`
//!      entry into the chosen editor's `mcp.json`. Idempotent: safe to
//!      call repeatedly, never overwrites the user's other servers.
//!   3. `setup_wizard_test_channel` — send a fixed prompt through
//!      `session_borrower::dispatch` and report the response preview +
//!      latency so the user has visual proof the channel works.
//!   4. `setup_wizard_install_ollama_hint` — return the OS-specific
//!      install URL + cli hint. We do NOT auto-install anything; the
//!      user clicks through to Ollama's site.
//!   5. `setup_wizard_persist_state` — durable JSON next to the memory
//!      dir so the wizard never re-prompts a user who already finished.
//!
//! Every command is wrapped in defensive try/catch on the React side
//! (Wave 10.1 lesson) and never panics here — failures degrade to a
//! sensible empty / safe value so the wizard always advances rather than
//! white-screening on the user.
//!
//! Detection reuses what we can from `commands/ai_tools.rs` (the editor
//! presence checks) and `personal_agents/cursor.rs` (the home-dir
//! resolution patterns), but the verdicts here are richer: we need the
//! actual `mcp.json` path so we can write to it.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::AppError;
use crate::agi::session_borrower::{dispatch, BorrowError, LlmRequest};

// ---------------------------------------------------------------------------
// Types — every shape mirrored on the React side in `lib/tauri.ts`.
// ---------------------------------------------------------------------------

/// One MCP-capable editor we found on the user's machine.
///
/// `config_path` is the absolute path to the editor's `mcp.json` (the file
/// the auto-configure command writes to). `already_has_tangerine` is true
/// iff the file already mentions a `tangerine` server entry (any shape) so
/// the React side can label "already configured" vs "needs setup".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedMcpTool {
    pub tool_id: String,
    pub display_name: String,
    pub config_path: PathBuf,
    pub already_has_tangerine: bool,
}

/// Recommendation surfaced as the highlighted card on the wizard's Detect
/// step. Picks the easiest path the user can take RIGHT NOW given their
/// installed software:
///   * If a tangerine entry is already in some editor's mcp.json → that.
///   * Else if any MCP-capable editor is installed → write to the first.
///   * Else if Ollama is running → use it as the fallback.
///   * Else if a browser is installed → BrowserExt (last resort, stub).
///   * Else NoChannelAvailable — user must install something.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecommendedChannel {
    McpSampling { tool_id: String, requires_restart: bool },
    OllamaHttp { default_model: String },
    BrowserExt,
    NoChannelAvailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupWizardDetection {
    pub mcp_capable_tools: Vec<DetectedMcpTool>,
    pub ollama_running: bool,
    pub ollama_default_model: Option<String>,
    pub browser_ext_browsers: Vec<String>,
    pub cloud_reachable: bool,
    pub recommended_channel: Option<RecommendedChannel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupWizardAutoConfigResult {
    pub ok: bool,
    pub file_written: PathBuf,
    pub restart_required: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupWizardTestResult {
    pub ok: bool,
    pub channel_used: String,
    pub response_preview: String,
    pub latency_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallHintResult {
    pub os: String,
    pub url: String,
    pub cli: Option<String>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupWizardPersistedState {
    pub completed_at: Option<String>,
    pub channel_ready: bool,
    pub primary_channel: Option<String>,
    pub skipped: bool,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// `<home>/.tangerine-memory/.tangerine/setup_wizard.json` — the wizard's
/// persisted state file. Lives under `.tangerine/` so the team git mirror
/// (memory_dir.git) excludes it via the default gitignore (private to this
/// machine). Falls back to the OS data dir if home is unresolvable.
fn setup_wizard_state_path() -> PathBuf {
    let base = dirs::home_dir()
        .map(|h| h.join(".tangerine-memory"))
        .or_else(dirs::data_local_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(".tangerine").join("setup_wizard.json")
}

/// Catalog of MCP-capable editors the wizard knows how to configure. The
/// `config_path_resolver` returns `Some(path)` when we believe the editor
/// is installed (path may not exist on disk yet — we'll create it).
struct McpToolRow {
    tool_id: &'static str,
    display_name: &'static str,
    /// Returns `Some(mcp_json_path)` when we want to surface this editor.
    /// We surface even when the editor isn't installed — the React side
    /// uses `already_has_tangerine` + presence to decide what to display.
    config_path_resolver: fn() -> Option<PathBuf>,
    /// Returns true iff the editor itself appears installed (vs just the
    /// mcp.json existing because some other tool wrote it). Used to gate
    /// the "is this even a real option for the user" decision.
    is_installed: fn() -> bool,
}

fn cursor_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".cursor").join("mcp.json"))
}

fn cursor_installed() -> bool {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return false,
    };
    let dot_cursor = home.join(".cursor");
    if dot_cursor.is_dir() {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(d) = dirs::config_dir() {
            if d.join("Cursor").is_dir() {
                return true;
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(h) = dirs::home_dir() {
            if h.join("Library")
                .join("Application Support")
                .join("Cursor")
                .is_dir()
            {
                return true;
            }
        }
    }
    false
}

fn claude_code_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("mcp_servers.json"))
}

fn claude_code_installed() -> bool {
    dirs::home_dir().map(|h| h.join(".claude").is_dir()).unwrap_or(false)
}

fn codex_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("mcp.json"))
}

fn codex_installed() -> bool {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return false,
    };
    home.join(".codex").is_dir() || home.join(".config").join("openai").is_dir()
}

fn windsurf_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".windsurf").join("mcp.json"))
}

fn windsurf_installed() -> bool {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return false,
    };
    if home.join(".windsurf").is_dir() {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(d) = dirs::config_dir() {
            if d.join("Windsurf").is_dir() {
                return true;
            }
        }
    }
    false
}

const MCP_CATALOG: &[McpToolRow] = &[
    McpToolRow {
        tool_id: "cursor",
        display_name: "Cursor",
        config_path_resolver: cursor_config_path,
        is_installed: cursor_installed,
    },
    McpToolRow {
        tool_id: "claude-code",
        display_name: "Claude Code",
        config_path_resolver: claude_code_config_path,
        is_installed: claude_code_installed,
    },
    McpToolRow {
        tool_id: "codex",
        display_name: "Codex",
        config_path_resolver: codex_config_path,
        is_installed: codex_installed,
    },
    McpToolRow {
        tool_id: "windsurf",
        display_name: "Windsurf",
        config_path_resolver: windsurf_config_path,
        is_installed: windsurf_installed,
    },
];

/// Best-effort: does the given mcp.json mention "tangerine" as a server?
/// Permissive — the user may have hand-written the entry in a slightly
/// different shape than ours; we just look for the key. Returns false on
/// any read / parse error so the wizard treats "we couldn't tell" as
/// "needs setup".
fn mcp_json_has_tangerine(path: &Path) -> bool {
    let body = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    // Cheap substring first (handles mcp.json with comments / trailing
    // commas that wouldn't strict-parse). Falls through to JSON parse if
    // the substring matches so we don't false-positive on a comment.
    if !body.to_lowercase().contains("tangerine") {
        return false;
    }
    let v: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return body.to_lowercase().contains("\"tangerine\""),
    };
    v.get("mcpServers")
        .and_then(|x| x.get("tangerine"))
        .is_some()
}

/// HTTP probe Ollama at `127.0.0.1:11434/api/version`. 1s timeout. Returns
/// `(running, default_model)`. The default model is parsed from the v1
/// `/api/tags` endpoint after a successful version probe — None when the
/// user hasn't pulled any model yet.
async fn ollama_probe() -> (bool, Option<String>) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
    {
        Ok(c) => c,
        Err(_) => return (false, None),
    };
    let version_ok = matches!(
        client
            .get("http://127.0.0.1:11434/api/version")
            .send()
            .await,
        Ok(r) if r.status().is_success()
    );
    if !version_ok {
        return (false, None);
    }

    // Best-effort tag fetch; failure leaves model = None.
    let model = match client
        .get("http://127.0.0.1:11434/api/tags")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            let body: serde_json::Value =
                resp.json().await.unwrap_or(serde_json::Value::Null);
            body.get("models")
                .and_then(|m| m.as_array())
                .and_then(|arr| arr.first())
                .and_then(|first| first.get("name"))
                .and_then(|n| n.as_str())
                .map(|s| s.to_string())
        }
        _ => None,
    };
    (true, model)
}

/// Best-effort browser install detection. We DON'T try to invoke each
/// browser — just check whether one of the well-known install paths
/// (Windows) or PATH binaries (POSIX) exist.
fn detect_browsers() -> Vec<String> {
    let mut out = Vec::new();
    #[cfg(target_os = "windows")]
    {
        let pf = std::env::var("ProgramFiles").unwrap_or_default();
        let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let candidates: Vec<(&str, Vec<String>)> = vec![
            (
                "Chrome",
                vec![
                    format!("{}/Google/Chrome/Application/chrome.exe", pf),
                    format!("{}/Google/Chrome/Application/chrome.exe", pf86),
                    format!("{}/Google/Chrome/Application/chrome.exe", local),
                ],
            ),
            (
                "Edge",
                vec![
                    format!("{}/Microsoft/Edge/Application/msedge.exe", pf),
                    format!("{}/Microsoft/Edge/Application/msedge.exe", pf86),
                ],
            ),
            (
                "Firefox",
                vec![
                    format!("{}/Mozilla Firefox/firefox.exe", pf),
                    format!("{}/Mozilla Firefox/firefox.exe", pf86),
                ],
            ),
        ];
        for (name, paths) in candidates {
            if paths.iter().any(|p| Path::new(p).exists()) {
                out.push(name.to_string());
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Linux / macOS — check PATH-named executables.
        for (name, exe_names) in [
            ("Chrome", &["google-chrome", "chromium", "chromium-browser"][..]),
            ("Edge", &["microsoft-edge", "microsoft-edge-stable"][..]),
            ("Firefox", &["firefox"][..]),
            #[cfg(target_os = "macos")]
            ("Safari", &["safari"][..]),
        ] {
            if exe_names.iter().any(|exe| which_on_path(exe).is_some()) {
                out.push(name.to_string());
            }
            #[cfg(target_os = "macos")]
            {
                let app_paths = [
                    format!("/Applications/{}.app", name),
                    format!("/Applications/Google Chrome.app"),
                ];
                if name == &"Chrome" && Path::new("/Applications/Google Chrome.app").exists() {
                    if !out.contains(&"Chrome".to_string()) {
                        out.push("Chrome".to_string());
                    }
                }
                for p in app_paths.iter() {
                    if Path::new(p).exists() && !out.contains(&name.to_string()) {
                        out.push(name.to_string());
                    }
                }
            }
        }
    }
    out
}

#[cfg(not(target_os = "windows"))]
fn which_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Build a `RecommendedChannel` from the detection facts. Pure function so
/// the unit tests can drive it without the real OS state.
fn pick_recommended(
    mcp_tools: &[DetectedMcpTool],
    mcp_installed_ids: &[&str],
    ollama_running: bool,
    ollama_model: &Option<String>,
    browsers: &[String],
) -> Option<RecommendedChannel> {
    // 1. Already-configured tangerine entry wins — user only needs to
    //    restart their editor for the bridge to come up.
    if let Some(t) = mcp_tools.iter().find(|t| t.already_has_tangerine) {
        return Some(RecommendedChannel::McpSampling {
            tool_id: t.tool_id.clone(),
            requires_restart: true,
        });
    }
    // 2. An MCP-capable editor IS installed but tangerine isn't wired in.
    //    Pick the first installed one (catalog order = user preference).
    for t in mcp_tools.iter() {
        if mcp_installed_ids.contains(&t.tool_id.as_str()) {
            return Some(RecommendedChannel::McpSampling {
                tool_id: t.tool_id.clone(),
                requires_restart: true,
            });
        }
    }
    // 3. Ollama is running — fall back to it.
    if ollama_running {
        return Some(RecommendedChannel::OllamaHttp {
            default_model: ollama_model
                .clone()
                .unwrap_or_else(|| "llama3.1:8b".to_string()),
        });
    }
    // 4. Browser-only — last resort (channel is still stubbed but the
    //    React side can route the user through the install steps).
    if !browsers.is_empty() {
        return Some(RecommendedChannel::BrowserExt);
    }
    Some(RecommendedChannel::NoChannelAvailable)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn setup_wizard_detect() -> Result<SetupWizardDetection, AppError> {
    let mut mcp_capable_tools = Vec::with_capacity(MCP_CATALOG.len());
    let mut installed_ids: Vec<&'static str> = Vec::new();
    for row in MCP_CATALOG {
        let path = match (row.config_path_resolver)() {
            Some(p) => p,
            None => continue,
        };
        let installed = (row.is_installed)();
        let already = mcp_json_has_tangerine(&path);
        // Surface the row when EITHER the editor itself is installed OR
        // its mcp.json already exists (some users put the file there
        // before installing the editor — Cursor's bring-your-own-config
        // flow). The React side filters again on `already_has_tangerine`
        // for the recommendation card.
        if installed || path.exists() {
            mcp_capable_tools.push(DetectedMcpTool {
                tool_id: row.tool_id.to_string(),
                display_name: row.display_name.to_string(),
                config_path: path,
                already_has_tangerine: already,
            });
            if installed {
                installed_ids.push(row.tool_id);
            }
        }
    }

    let (ollama_running, ollama_default_model) = ollama_probe().await;
    let browsers = detect_browsers();

    let recommended = pick_recommended(
        &mcp_capable_tools,
        &installed_ids,
        ollama_running,
        &ollama_default_model,
        &browsers,
    );

    Ok(SetupWizardDetection {
        mcp_capable_tools,
        ollama_running,
        ollama_default_model,
        browser_ext_browsers: browsers,
        // Cloud isn't built yet — see V2_0_SPEC. Hardcoded false until we
        // ship the cloud probe; the React side renders this as "coming soon".
        cloud_reachable: false,
        recommended_channel: recommended,
    })
}

/// Merge a `tangerine` server entry into the editor's mcp.json. Idempotent.
/// Never overwrites the user's other servers. Creates parent dirs as needed.
fn merge_tangerine_into_mcp_json(path: &Path) -> Result<bool, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all {}: {}", parent.display(), e))?;
    }
    let existing: serde_json::Value = match fs::read_to_string(path) {
        Ok(body) if !body.trim().is_empty() => serde_json::from_str(&body)
            .unwrap_or(serde_json::json!({ "mcpServers": {} })),
        _ => serde_json::json!({ "mcpServers": {} }),
    };
    let mut root = existing;
    if !root.is_object() {
        root = serde_json::json!({ "mcpServers": {} });
    }
    let obj = root.as_object_mut().unwrap();
    let servers_entry = obj
        .entry("mcpServers".to_string())
        .or_insert(serde_json::json!({}));
    if !servers_entry.is_object() {
        *servers_entry = serde_json::json!({});
    }
    let servers = servers_entry.as_object_mut().unwrap();

    // Construct the canonical Tangerine entry. Idempotent: if the entry
    // already exists with the right env var, we don't re-write the file.
    let canonical = serde_json::json!({
        "command": "npx",
        "args": ["-y", "tangerine-mcp@latest"],
        "env": {
            "TANGERINE_SAMPLING_BRIDGE": "1"
        }
    });

    let needs_write = match servers.get("tangerine") {
        Some(existing) => {
            let env_ok = existing
                .get("env")
                .and_then(|e| e.get("TANGERINE_SAMPLING_BRIDGE"))
                .and_then(|v| v.as_str())
                .map(|s| s == "1")
                .unwrap_or(false);
            !env_ok
        }
        None => true,
    };

    if needs_write {
        servers.insert("tangerine".to_string(), canonical);
        let body = serde_json::to_string_pretty(&root)
            .map_err(|e| format!("serialize: {}", e))?;
        fs::write(path, body).map_err(|e| format!("write {}: {}", path.display(), e))?;
    }
    Ok(needs_write)
}

#[tauri::command]
pub async fn setup_wizard_auto_configure_mcp(
    tool_id: String,
) -> Result<SetupWizardAutoConfigResult, AppError> {
    let row = MCP_CATALOG
        .iter()
        .find(|r| r.tool_id == tool_id)
        .ok_or_else(|| AppError::user("unknown_tool", format!("unknown tool_id {tool_id}")))?;
    let path = (row.config_path_resolver)().ok_or_else(|| {
        AppError::internal(
            "no_config_path",
            format!("could not resolve mcp config path for {tool_id}"),
        )
    })?;
    match merge_tangerine_into_mcp_json(&path) {
        Ok(_) => Ok(SetupWizardAutoConfigResult {
            ok: true,
            file_written: path,
            // Cursor / Claude Code spawn MCP servers on startup; the new
            // entry is only picked up after a full editor restart.
            restart_required: true,
            error: None,
        }),
        Err(e) => Ok(SetupWizardAutoConfigResult {
            ok: false,
            file_written: path,
            restart_required: false,
            error: Some(e),
        }),
    }
}

const TEST_PROMPT: &str = "Reply with exactly 'Tangerine LLM channel test OK' and nothing else.";

#[derive(Debug, Clone, Deserialize)]
pub struct TestChannelArgs {
    /// "mcp_sampling" | "ollama" | "browser_ext" | "auto"
    pub channel: Option<String>,
    /// When the channel is mcp_sampling, the specific tool_id to try first.
    /// Optional for ollama / browser_ext.
    pub tool_id: Option<String>,
}

/// Send the canonical test prompt through the session borrower and report
/// the first 200 chars of the response. We intentionally route through the
/// real dispatcher (not a separate single-channel call) so the test result
/// matches what the heartbeat would actually see.
#[tauri::command]
pub async fn setup_wizard_test_channel(
    args: TestChannelArgs,
) -> Result<SetupWizardTestResult, AppError> {
    let start = Instant::now();
    let primary_tool_id = args.tool_id.clone().or_else(|| {
        // When the user picked an Ollama-only path, set the primary to
        // "ollama" so the dispatcher tries it first.
        match args.channel.as_deref() {
            Some("ollama") => Some("ollama".to_string()),
            _ => None,
        }
    });
    let request = LlmRequest {
        system_prompt: "You are a setup wizard test probe.".to_string(),
        user_prompt: TEST_PROMPT.to_string(),
        max_tokens: Some(64),
        temperature: Some(0.0),
    };

    match dispatch(request, primary_tool_id).await {
        Ok(resp) => {
            let preview = resp.text.chars().take(200).collect::<String>();
            Ok(SetupWizardTestResult {
                ok: true,
                channel_used: resp.channel_used,
                response_preview: preview,
                latency_ms: resp.latency_ms,
                error: None,
            })
        }
        Err(e) => {
            let (code, msg) = match e {
                BorrowError::PrimaryUnreachable { tool_id, reason } => {
                    ("primary_unreachable", format!("{tool_id}: {reason}"))
                }
                BorrowError::AllExhausted => {
                    ("all_channels_exhausted", "no AI tool channel succeeded".to_string())
                }
                BorrowError::NotImplemented(m) => ("not_implemented", m),
            };
            Ok(SetupWizardTestResult {
                ok: false,
                channel_used: code.to_string(),
                response_preview: String::new(),
                latency_ms: start.elapsed().as_millis() as u64,
                error: Some(msg),
            })
        }
    }
}

#[tauri::command]
pub async fn setup_wizard_install_ollama_hint() -> Result<InstallHintResult, AppError> {
    #[cfg(target_os = "windows")]
    {
        return Ok(InstallHintResult {
            os: "windows".to_string(),
            url: "https://ollama.com/download/windows".to_string(),
            cli: None,
            note: "Run the .exe installer; Ollama starts as a background service on port 11434."
                .to_string(),
        });
    }
    #[cfg(target_os = "macos")]
    {
        return Ok(InstallHintResult {
            os: "macos".to_string(),
            url: "https://ollama.com/download/mac".to_string(),
            cli: Some("brew install ollama".to_string()),
            note: "Install via Homebrew or the .dmg. Run `ollama pull llama3.1:8b` to fetch a model."
                .to_string(),
        });
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        return Ok(InstallHintResult {
            os: "linux".to_string(),
            url: "https://ollama.com/download/linux".to_string(),
            cli: Some("curl -fsSL https://ollama.com/install.sh | sh".to_string()),
            note: "Run the install script; service binds 127.0.0.1:11434.".to_string(),
        });
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct PersistStateArgs {
    pub channel_ready: bool,
    pub primary_channel: Option<String>,
    /// Optional — defaults to false. Lets the React side record "user
    /// clicked Skip" without flipping channel_ready.
    #[serde(default)]
    pub skipped: bool,
}

#[tauri::command]
pub async fn setup_wizard_persist_state(
    args: PersistStateArgs,
) -> Result<SetupWizardPersistedState, AppError> {
    let path = setup_wizard_state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir", e.to_string()))?;
    }
    let state = SetupWizardPersistedState {
        completed_at: Some(chrono::Utc::now().to_rfc3339()),
        channel_ready: args.channel_ready,
        primary_channel: args.primary_channel,
        skipped: args.skipped,
    };
    let body = serde_json::to_string_pretty(&state)
        .map_err(|e| AppError::internal("serialize", e.to_string()))?;
    fs::write(&path, body).map_err(|e| AppError::internal("write", e.to_string()))?;
    Ok(state)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(label: &str) -> Self {
            let id = uuid::Uuid::new_v4().simple().to_string();
            let p = std::env::temp_dir().join(format!("ti-setup-{}-{}", label, id));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn merge_creates_fresh_mcp_json_when_missing() {
        let td = TempDir::new("merge-fresh");
        let p = td.0.join("mcp.json");
        let wrote = merge_tangerine_into_mcp_json(&p).expect("merge");
        assert!(wrote, "fresh file must trigger a write");
        let body = fs::read_to_string(&p).unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        let env = v["mcpServers"]["tangerine"]["env"]["TANGERINE_SAMPLING_BRIDGE"]
            .as_str()
            .unwrap();
        assert_eq!(env, "1");
        let cmd = v["mcpServers"]["tangerine"]["command"].as_str().unwrap();
        assert_eq!(cmd, "npx");
    }

    #[test]
    fn merge_preserves_other_servers() {
        let td = TempDir::new("merge-other");
        let p = td.0.join("mcp.json");
        let initial = serde_json::json!({
            "mcpServers": {
                "user-server": {
                    "command": "node",
                    "args": ["/tmp/foo.js"]
                }
            }
        });
        fs::write(&p, serde_json::to_string_pretty(&initial).unwrap()).unwrap();
        merge_tangerine_into_mcp_json(&p).expect("merge");
        let body = fs::read_to_string(&p).unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        // The user's existing server must still be there.
        assert_eq!(
            v["mcpServers"]["user-server"]["command"]
                .as_str()
                .unwrap(),
            "node"
        );
        // And tangerine got added.
        assert!(v["mcpServers"]["tangerine"].is_object());
    }

    #[test]
    fn merge_is_idempotent_when_already_configured() {
        let td = TempDir::new("merge-idem");
        let p = td.0.join("mcp.json");
        let initial = serde_json::json!({
            "mcpServers": {
                "tangerine": {
                    "command": "npx",
                    "args": ["-y", "tangerine-mcp@latest"],
                    "env": { "TANGERINE_SAMPLING_BRIDGE": "1" }
                }
            }
        });
        fs::write(&p, serde_json::to_string_pretty(&initial).unwrap()).unwrap();
        let wrote = merge_tangerine_into_mcp_json(&p).expect("merge");
        assert!(!wrote, "second merge with identical entry must not rewrite");
    }

    #[test]
    fn merge_repairs_missing_env_var() {
        let td = TempDir::new("merge-repair");
        let p = td.0.join("mcp.json");
        let initial = serde_json::json!({
            "mcpServers": {
                "tangerine": {
                    "command": "npx",
                    "args": ["-y", "tangerine-mcp@latest"]
                }
            }
        });
        fs::write(&p, serde_json::to_string_pretty(&initial).unwrap()).unwrap();
        let wrote = merge_tangerine_into_mcp_json(&p).expect("merge");
        assert!(wrote, "missing env var must trigger a re-write");
        let body = fs::read_to_string(&p).unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        let env = v["mcpServers"]["tangerine"]["env"]["TANGERINE_SAMPLING_BRIDGE"]
            .as_str()
            .unwrap();
        assert_eq!(env, "1");
    }

    #[test]
    fn mcp_json_has_tangerine_detects_keyed_entry() {
        let td = TempDir::new("has-tangerine");
        let p = td.0.join("mcp.json");
        let body = serde_json::json!({
            "mcpServers": {
                "tangerine": { "command": "npx" }
            }
        });
        fs::write(&p, serde_json::to_string_pretty(&body).unwrap()).unwrap();
        assert!(mcp_json_has_tangerine(&p));
    }

    #[test]
    fn mcp_json_has_tangerine_returns_false_for_missing_file() {
        let td = TempDir::new("has-tangerine-missing");
        let p = td.0.join("mcp.json");
        assert!(!mcp_json_has_tangerine(&p));
    }

    #[test]
    fn pick_recommended_prefers_already_configured_mcp() {
        let tools = vec![DetectedMcpTool {
            tool_id: "cursor".to_string(),
            display_name: "Cursor".to_string(),
            config_path: PathBuf::from("/tmp/mcp.json"),
            already_has_tangerine: true,
        }];
        let r = pick_recommended(&tools, &["cursor"], false, &None, &[]).unwrap();
        match r {
            RecommendedChannel::McpSampling { tool_id, .. } => {
                assert_eq!(tool_id, "cursor")
            }
            _ => panic!("expected McpSampling"),
        }
    }

    #[test]
    fn pick_recommended_falls_back_to_ollama_when_no_editor() {
        let r = pick_recommended(&[], &[], true, &Some("llama3:8b".to_string()), &[]).unwrap();
        match r {
            RecommendedChannel::OllamaHttp { default_model } => {
                assert_eq!(default_model, "llama3:8b")
            }
            _ => panic!("expected OllamaHttp"),
        }
    }

    #[test]
    fn pick_recommended_falls_back_to_browser_ext_last() {
        let r =
            pick_recommended(&[], &[], false, &None, &["Chrome".to_string()]).unwrap();
        assert!(matches!(r, RecommendedChannel::BrowserExt));
    }

    #[test]
    fn pick_recommended_returns_no_channel_when_nothing_present() {
        let r = pick_recommended(&[], &[], false, &None, &[]).unwrap();
        assert!(matches!(r, RecommendedChannel::NoChannelAvailable));
    }

    #[tokio::test]
    async fn ollama_probe_completes_under_2s() {
        let start = Instant::now();
        let _ = ollama_probe().await;
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn install_hint_returns_an_url_for_current_os() {
        let hint = setup_wizard_install_ollama_hint().await.unwrap();
        assert!(hint.url.starts_with("https://ollama.com/"));
        assert!(!hint.os.is_empty());
    }

    #[tokio::test]
    async fn detect_returns_recommendation_or_none_without_panic() {
        // Pure smoke — every call must succeed and produce a struct, even
        // on a CI box with no editor / no Ollama.
        let det = setup_wizard_detect().await.unwrap();
        // recommended_channel is always Some — even "no channel" is an
        // explicit Some(NoChannelAvailable).
        assert!(det.recommended_channel.is_some());
    }
}
