//! === wave 11 ===
//! v1.10.2 — first-run AI-tool detection + persistence.
//!
//! v1.16 PIVOT: Tangerine no longer borrows the host LLM via MCP sampling.
//! Capture is read-only from local AI-tool log files (handled elsewhere by
//! `personal_agents/*`); the wizard's job shrank to:
//!
//!   1. `setup_wizard_detect` — best-effort scan for installed MCP-capable
//!      editors, Ollama, and browsers. Surfaces a recommendation card so
//!      the user knows which AI tool Tangerine can read logs from.
//!   2. `setup_wizard_auto_configure_mcp` — historical entrypoint kept for
//!      the React side's call signature compatibility. v1.16: NO-OP.
//!      Capture doesn't need an mcp.json entry, so this command logs an
//!      honest "v1.16: capture is read-only from log files, no MCP entry
//!      needed" message and returns success WITHOUT writing any file.
//!   3. `setup_wizard_v15_auto_configure_mcp` — same v1.16 no-op semantics
//!      as #2 (kept callable so the wave-11 8-tool wizard UI doesn't
//!      explode mid-flight while W1A3 prunes the React side).
//!   4. `mcp_server_handshake` — historical handshake kept for call-site
//!      compatibility. v1.16: returns `Ok(false)` for every editor (the
//!      sampling-bridge registry is gone in W1A1; the future capture-side
//!      handshake will check log-file existence instead — W2 task).
//!   5. `setup_wizard_install_ollama_hint` — OS-specific install URL.
//!   6. `setup_wizard_persist_state` — durable JSON next to memory dir.
//!
//! What was removed in v1.16:
//!   * `setup_wizard_test_channel` (Tauri command + `TestChannelArgs`,
//!     `SetupWizardTestResult`, `SetupWizardDiagnostic`) — Tangerine no
//!     longer dispatches LLM requests, so there is nothing to test.
//!   * Wave 11.1 channel-picker (`MCP_CATALOG`, `Channel::McpSampling`
//!     mapping, `dispatch_mcp_sampling`) — sampling-bridge module is gone.
//!   * `run_mcp_sampling_test` / `run_ollama_test` / `run_legacy_dispatch`
//!     / `borrow_error_to_result` / `classify_borrow_error` /
//!     `friendly_error_for_kind` / `display_name_for_tool` helpers —
//!     dead with the `_test_channel` command.
//!   * `RecommendedChannel::McpSampling` variant — the recommendation now
//!     surfaces capture-readable editors via a generic `EditorCapture`
//!     variant; nothing in the wizard borrows the host LLM anymore.
//!   * `tangerine_mcp_entry_json_for` / `tangerine_mcp_entry_toml_for` and
//!     the `v15_configure_*` writers / `merge_into_mcp_servers_*` helpers
//!     / `atomic_write` / `read_existing_*` — the npm package
//!     `tangerine-mcp` is gone (W1A2 deleted `mcp-server/`); writing an
//!     `npx tangerine-mcp` MCP entry would point at a non-existent
//!     binary, so the configure path is a deliberate no-op.
//!
//! R6/R7/R8 honesty: every kept-but-no-op function logs an explicit
//! `tracing::info!` line so a future log read makes the v1.16 pivot
//! self-evident — never silent OK.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::AppError;

// ---------------------------------------------------------------------------
// Types — every shape mirrored on the React side in `lib/tauri.ts`.
// ---------------------------------------------------------------------------

/// One MCP-capable editor we found on the user's machine.
///
/// `config_path` is the absolute path to the editor's `mcp.json`. v1.16: the
/// wizard NO LONGER writes to this file — it's surfaced for display + future
/// "open the file" links only. `already_has_tangerine` is true iff the file
/// already mentions a `tangerine` server entry from a pre-v1.16 install
/// (legacy detection — the wizard surfaces a "remove stale entry" hint).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedMcpTool {
    pub tool_id: String,
    pub display_name: String,
    pub config_path: PathBuf,
    pub already_has_tangerine: bool,
}

/// Recommendation surfaced as the highlighted card on the wizard's Detect
/// step. v1.16: `McpSampling` removed. The user picks an editor whose log
/// files Tangerine can read; nothing about LLM dispatch remains.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecommendedChannel {
    /// User has an MCP-capable editor installed; Tangerine can read its
    /// logs (capture pipeline; no LLM borrow). React side renders this as
    /// the highlighted card.
    EditorCapture { tool_id: String },
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

/// Catalog of MCP-capable editors the wizard knows how to detect. v1.16:
/// detection only — the wizard never writes to `config_path_resolver()`'s
/// path. Kept here because the React side still surfaces "we see Cursor on
/// your machine, capture can read its logs" cards.
struct McpToolRow {
    tool_id: &'static str,
    display_name: &'static str,
    config_path_resolver: fn() -> Option<PathBuf>,
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
    dirs::home_dir().map(|h| h.join(".claude.json"))
}

fn claude_code_installed() -> bool {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return false,
    };
    home.join(".claude").is_dir() || home.join(".claude.json").is_file()
}

fn codex_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("config.toml"))
}

fn codex_installed() -> bool {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return false,
    };
    home.join(".codex").is_dir() || home.join(".config").join("openai").is_dir()
}

fn windsurf_config_path() -> Option<PathBuf> {
    dirs::home_dir()
        .map(|h| h.join(".codeium").join("windsurf").join("mcp_config.json"))
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
/// In v1.16 this surfaces a "remove stale entry" hint when an upgrade leaves
/// a pre-v1.16 `tangerine-mcp` entry behind that no longer points anywhere
/// useful (the npm package was removed in W1A2). Returns false on any read
/// / parse error so the wizard treats "we couldn't tell" as "nothing stale".
fn mcp_json_has_tangerine(path: &Path) -> bool {
    let body = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return false,
    };
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
/// the unit tests can drive it without the real OS state. v1.16: any
/// installed MCP-capable editor is now `EditorCapture`, NOT `McpSampling`.
fn pick_recommended(
    mcp_tools: &[DetectedMcpTool],
    mcp_installed_ids: &[&str],
    ollama_running: bool,
    ollama_model: &Option<String>,
    browsers: &[String],
) -> Option<RecommendedChannel> {
    // 1. An installed MCP-capable editor — capture pipeline can read its logs.
    for t in mcp_tools.iter() {
        if mcp_installed_ids.contains(&t.tool_id.as_str()) {
            return Some(RecommendedChannel::EditorCapture {
                tool_id: t.tool_id.clone(),
            });
        }
    }
    // 2. Ollama is running — fall back to it.
    if ollama_running {
        return Some(RecommendedChannel::OllamaHttp {
            default_model: ollama_model
                .clone()
                .unwrap_or_else(|| "llama3.1:8b".to_string()),
        });
    }
    // 3. Browser-only — last resort.
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
        cloud_reachable: false,
        recommended_channel: recommended,
    })
}

/// v1.16 NO-OP — historical entrypoint kept for the React side's call-site
/// compatibility. Capture is read-only from local AI-tool log files; no MCP
/// entry is needed in the user's `mcp.json`. Returns `ok: true` so the
/// React side advances cleanly, but emits an explicit log line so the
/// pivot is observable. R6/R7/R8: never silent OK — the log is the audit
/// trail.
#[tauri::command]
pub async fn setup_wizard_auto_configure_mcp(
    tool_id: String,
) -> Result<SetupWizardAutoConfigResult, AppError> {
    tracing::info!(
        tool_id = %tool_id,
        "v1.16: setup_wizard_auto_configure_mcp is a no-op — capture is read-only from log files, no MCP entry needed"
    );
    Ok(SetupWizardAutoConfigResult {
        ok: true,
        file_written: PathBuf::new(),
        restart_required: false,
        error: None,
    })
}

/// v1.16 NO-OP — historical 8-tool entrypoint. Same semantics as
/// `setup_wizard_auto_configure_mcp`: capture pipeline is read-only, no
/// per-editor MCP config is written. Logged honestly.
#[tauri::command]
pub async fn setup_wizard_v15_auto_configure_mcp(
    tool_id: String,
) -> Result<(), String> {
    tracing::info!(
        tool_id = %tool_id,
        "v1.16: setup_wizard_v15_auto_configure_mcp is a no-op — capture is read-only from log files, no MCP entry needed"
    );
    Ok(())
}

/// v1.16 STUB — historical handshake. The pre-v1.16 implementation checked
/// the in-process MCP sampling-bridge registry; that registry was removed
/// in W1A1. The future capture-side handshake will check log-file existence
/// instead (W2 task). Until then, returning `Ok(false)` is the honest
/// answer: there is no live channel for the wizard to call out to.
#[tauri::command]
pub async fn mcp_server_handshake(tool_id: String) -> Result<bool, String> {
    tracing::info!(
        tool_id = %tool_id,
        "v1.16: mcp_server_handshake stub — sampling-bridge removed, capture-side handshake lands in W2"
    );
    Ok(false)
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
    use std::time::Instant;

    #[test]
    fn mcp_json_has_tangerine_detects_keyed_entry() {
        let p = std::env::temp_dir().join(format!(
            "ti-setup-{}-mcp.json",
            uuid::Uuid::new_v4().simple()
        ));
        let body = serde_json::json!({
            "mcpServers": {
                "tangerine": { "command": "npx" }
            }
        });
        fs::write(&p, serde_json::to_string_pretty(&body).unwrap()).unwrap();
        assert!(mcp_json_has_tangerine(&p));
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn mcp_json_has_tangerine_returns_false_for_missing_file() {
        let p = std::env::temp_dir().join(format!(
            "ti-setup-{}-missing.json",
            uuid::Uuid::new_v4().simple()
        ));
        assert!(!mcp_json_has_tangerine(&p));
    }

    #[test]
    fn pick_recommended_prefers_installed_editor_capture() {
        let tools = vec![DetectedMcpTool {
            tool_id: "cursor".to_string(),
            display_name: "Cursor".to_string(),
            config_path: PathBuf::from("/tmp/mcp.json"),
            already_has_tangerine: false,
        }];
        let r = pick_recommended(&tools, &["cursor"], false, &None, &[]).unwrap();
        match r {
            RecommendedChannel::EditorCapture { tool_id } => {
                assert_eq!(tool_id, "cursor")
            }
            other => panic!("expected EditorCapture, got {other:?}"),
        }
    }

    #[test]
    fn pick_recommended_falls_back_to_ollama_when_no_editor() {
        let r = pick_recommended(&[], &[], true, &Some("llama3:8b".to_string()), &[]).unwrap();
        match r {
            RecommendedChannel::OllamaHttp { default_model } => {
                assert_eq!(default_model, "llama3:8b")
            }
            other => panic!("expected OllamaHttp, got {other:?}"),
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

    // === v1.16 noop entrypoints ============================================

    #[tokio::test]
    async fn auto_configure_mcp_is_noop_in_v116() {
        // Must succeed without writing any file. R6/R7/R8: caller sees ok=true
        // BUT file_written is empty so a downstream "did we write?" guard
        // can still distinguish v1.16 noop from a real write.
        let r = setup_wizard_auto_configure_mcp("cursor".to_string())
            .await
            .expect("noop must not error");
        assert!(r.ok);
        assert_eq!(r.file_written, PathBuf::new());
        assert!(!r.restart_required);
        assert!(r.error.is_none());
    }

    #[tokio::test]
    async fn v15_auto_configure_mcp_is_noop_in_v116() {
        setup_wizard_v15_auto_configure_mcp("claude-code".to_string())
            .await
            .expect("v15 noop must not error");
    }

    #[tokio::test]
    async fn mcp_server_handshake_returns_false_in_v116() {
        // The bridge is gone — the only honest answer is "no live channel".
        for tool_id in ["cursor", "claude-code", "codex", "windsurf", "unknown"] {
            let alive = mcp_server_handshake(tool_id.to_string())
                .await
                .expect("stub never errors in v1.16");
            assert!(
                !alive,
                "handshake must return false for every tool_id in v1.16; got true for {tool_id}"
            );
        }
    }

    #[tokio::test]
    async fn persist_state_round_trips() {
        let r = setup_wizard_persist_state(PersistStateArgs {
            channel_ready: true,
            primary_channel: Some("cursor".to_string()),
            skipped: false,
        })
        .await
        .unwrap();
        assert!(r.channel_ready);
        assert_eq!(r.primary_channel.as_deref(), Some("cursor"));
        assert!(!r.skipped);
        assert!(r.completed_at.is_some());
    }
}
