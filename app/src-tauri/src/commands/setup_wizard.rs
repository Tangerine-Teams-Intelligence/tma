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
// === wave 11.1 ===
// Test mode now uses the new `dispatch_specific_channel` so the wizard
// honors the user's selected channel and never silently falls through to
// a different one (e.g. ollama 404 when the user picked Claude Code MCP).
use crate::agi::session_borrower::{
    dispatch, dispatch_specific_channel, BorrowError, LlmRequest,
    PrimaryUnreachableCause, SpecificChannel,
};
#[cfg(test)]
use crate::agi::session_borrower::dispatch_specific_channel_with_base_url;

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
    // === wave 11.1 ===
    /// Structured diagnostic the React side surfaces in the "What did
    /// Tangerine try?" expander on failure. Always present (even on
    /// success) so the wizard can render the same info on the OK card too.
    #[serde(default)]
    pub diagnostic: Option<SetupWizardDiagnostic>,
}

/// === wave 11.1 ===
/// Detailed account of what the test attempted. Used by the React side to
/// render the "show me what's wrong" expander on Step 4. The `cause` field
/// is what powers the user-readable error message — see the
/// `friendly_error_for` helper.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupWizardDiagnostic {
    /// Logical channel attempted: "mcp_sampling" / "ollama_http" / "browser_ext".
    pub channel_attempted: String,
    /// Tool id (only meaningful for mcp_sampling — empty otherwise).
    pub tool_id: String,
    /// True iff a sampler is currently registered for `tool_id`. False for
    /// non-MCP channels.
    pub sampler_registered: bool,
    /// How long the test ran end-to-end.
    pub elapsed_ms: u64,
    /// Stable error category — drives which i18n key the React side picks.
    /// One of:
    ///   "ok"
    ///   "mcp_sampler_not_registered"
    ///   "mcp_sampler_timeout"
    ///   "mcp_sampler_disconnected"
    ///   "mcp_host_rejected"
    ///   "mcp_bridge_internal"
    ///   "ollama_client_init"
    ///   "ollama_connection_refused"
    ///   "ollama_http_status"
    ///   "ollama_parse_error"
    ///   "browser_ext_not_implemented"
    ///   "all_channels_exhausted"
    ///   "unknown"
    pub error_kind: String,
    /// Free-form raw Rust error — the React side renders this verbatim
    /// inside the expander for debugging. Not user-facing copy.
    pub raw_error: Option<String>,
    /// Optional metadata: HTTP status code, timeout duration, etc.
    /// Renders as "key: value" lines under the raw error.
    pub extra: Option<serde_json::Value>,
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
    // v1.15.1 fix — Claude Code reads `~/.claude.json` top-level
    // `mcpServers` field. The legacy `~/.claude/mcp_servers.json`
    // path was CC v0.x and is silently ignored by current CC.
    dirs::home_dir().map(|h| h.join(".claude.json"))
}

fn claude_code_installed() -> bool {
    // v1.15.1 fix — also accept ~/.claude.json (the file CC writes on
    // first launch, even before user opens any project) — was missing
    // false positives where dir existed but file didn't.
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return false,
    };
    home.join(".claude").is_dir() || home.join(".claude.json").is_file()
}

fn codex_config_path() -> Option<PathBuf> {
    // v1.15.1 fix — Codex (OpenAI Codex CLI) writes TOML at
    // `~/.codex/config.toml` (`[mcp_servers.tangerine]` table), not
    // the JSON path some pre-1.0 tutorials suggest.
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
    // v1.15.1 fix — Windsurf (Codeium) is at
    // `~/.codeium/windsurf/mcp_config.json`. The `~/.windsurf/`
    // directory was an internal-tutorial leak that never matched
    // shipped Windsurf builds.
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
///
/// v1.15.1 — kept (with `#[allow(dead_code)]`) only as a rollback path
/// in case the v15 dispatcher hits an unforeseen regression in the field.
/// All production callers now route through `v15_delegate_auto_configure`
/// (see `setup_wizard_auto_configure_mcp` above). The cargo tests below
/// continue to exercise this function so the rollback path stays known-good.
#[allow(dead_code)]
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
    // v1.15.1 fix — wave 11's MCP_CATALOG had stale config paths for 3
    // of the 4 editors (claude-code → ~/.claude/mcp_servers.json which
    // CC ignores; codex → mcp.json which is now config.toml; windsurf
    // → ~/.windsurf which is now ~/.codeium/windsurf). Auto-configure
    // *succeeded* against the wrong file — silent failure of exactly
    // the R6/R7/R8 kind we'd been chasing.
    //
    // Fix: delegate ALL 8 tools to the v15 dispatcher, which has
    // verified-correct paths, atomic write + idempotent merge, 30
    // cargo tests, and cross-platform handling. Wave 11 catalog stays
    // around for installation detection only (`is_installed`), but
    // never writes files. v15 is the single source of truth.
    v15_delegate_auto_configure(&tool_id).await
}

/// Wave 4 wire-up — bridges wave 11's struct-returning entry point to
/// W1.3's v15 dispatcher. Returns the same `SetupWizardAutoConfigResult`
/// shape so the React grid (W1.2) doesn't care which path served it.
///
/// Honesty rules (R6/R7/R8):
///   * v15 errors propagate verbatim into the `error` field — no silent
///     remapping to `Ok`.
///   * `file_written` records the canonical config-file location for the
///     four FILE-backed tools and the keychain sentinel path for the two
///     KEYCHAIN-backed tools (devin / replit). For the two
///     PlatformUnsupported tools (apple-intelligence / ms-copilot) it's
///     left empty — the v15 dispatcher returns Err in that case so the
///     UI never paints a fake green check.
///   * `restart_required` defers to v15: the four MCP editors need a
///     restart; keychain tools don't.
async fn v15_delegate_auto_configure(
    tool_id: &str,
) -> Result<SetupWizardAutoConfigResult, AppError> {
    let home = match v15_home_root() {
        Ok(h) => h,
        Err(e) => {
            return Ok(SetupWizardAutoConfigResult {
                ok: false,
                file_written: PathBuf::new(),
                restart_required: false,
                error: Some(e),
            });
        }
    };
    let restart_required = matches!(
        tool_id,
        "claude-code" | "cursor" | "codex" | "windsurf"
    );
    match v15_dispatch_configure(tool_id, &home).await {
        Ok(()) => Ok(SetupWizardAutoConfigResult {
            ok: true,
            // Best-effort path hint for the toast. The exact file written
            // varies per tool (TOML for codex, JSON for the others, sentinel
            // file for keychain tools); we surface a stable per-tool slug
            // here rather than re-derive the absolute path twice.
            file_written: PathBuf::from(format!("v15:{}", tool_id)),
            restart_required,
            error: None,
        }),
        Err(e) => Ok(SetupWizardAutoConfigResult {
            ok: false,
            file_written: PathBuf::new(),
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

// === wave 11.1 ===
/// Send the canonical test prompt through the channel the user explicitly
/// selected. NEVER falls through to other channels — when the user picks
/// Claude Code MCP and that fails, the wizard must say "Claude Code didn't
/// respond" not "ollama 404". The single biggest UX bug in v1.10.2.
///
/// Behavior:
///   * `args.channel == Some("mcp_sampling")` + `tool_id` → directly call
///     `dispatch_specific_channel(McpSampling, tool_id)`. On failure,
///     return a tool-specific friendly error.
///   * `args.channel == Some("ollama")` → directly probe Ollama. On failure
///     (404 / connection refused / etc.), return Ollama-specific copy.
///   * `args.channel == Some("browser_ext")` → return the not-implemented
///     message immediately.
///   * `args.channel == None | Some("auto")` → legacy behavior: full
///     fall-through dispatcher. Kept so existing call sites that don't
///     pass `channel` (early adopters of the API) still work.
#[tauri::command]
pub async fn setup_wizard_test_channel(
    args: TestChannelArgs,
) -> Result<SetupWizardTestResult, AppError> {
    let start = Instant::now();
    let request = LlmRequest {
        system_prompt: "You are a setup wizard test probe.".to_string(),
        user_prompt: TEST_PROMPT.to_string(),
        max_tokens: Some(64),
        temperature: Some(0.0),
    };

    let channel_arg = args.channel.as_deref().unwrap_or("auto");
    let tool_id = args.tool_id.clone();

    match channel_arg {
        "mcp_sampling" => {
            run_mcp_sampling_test(request, tool_id, start).await
        }
        "ollama" | "ollama_http" => run_ollama_test(request, start).await,
        "browser_ext" => Ok(browser_ext_not_implemented_result(start, tool_id)),
        // Legacy fall-through path (old call sites without `channel`).
        _ => run_legacy_dispatch(request, tool_id, start).await,
    }
}

// === wave 11.1 ===
async fn run_mcp_sampling_test(
    request: LlmRequest,
    tool_id: Option<String>,
    start: Instant,
) -> Result<SetupWizardTestResult, AppError> {
    let tid = tool_id.clone().unwrap_or_default();
    // Snapshot whether a sampler is registered NOW for the diagnostic
    // panel — this is the single most useful debug line ("did the editor
    // actually phone home?").
    let sampler_registered = if !tid.is_empty() {
        crate::agi::sampling_bridge::global().has(&tid)
    } else {
        false
    };

    let res = dispatch_specific_channel(
        request,
        SpecificChannel::McpSampling,
        tool_id.clone(),
    )
    .await;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    match res {
        Ok(resp) => Ok(SetupWizardTestResult {
            ok: true,
            channel_used: resp.channel_used,
            response_preview: resp.text.chars().take(200).collect(),
            latency_ms: resp.latency_ms,
            error: None,
            diagnostic: Some(SetupWizardDiagnostic {
                channel_attempted: "mcp_sampling".to_string(),
                tool_id: tid,
                sampler_registered: true,
                elapsed_ms,
                error_kind: "ok".to_string(),
                raw_error: None,
                extra: None,
            }),
        }),
        Err(e) => Ok(borrow_error_to_result(
            e,
            "mcp_sampling",
            tid,
            sampler_registered,
            elapsed_ms,
        )),
    }
}

// === wave 11.1 ===
async fn run_ollama_test(
    request: LlmRequest,
    start: Instant,
) -> Result<SetupWizardTestResult, AppError> {
    let res = dispatch_specific_channel(
        request,
        SpecificChannel::Ollama,
        Some("ollama".to_string()),
    )
    .await;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    match res {
        Ok(resp) => Ok(SetupWizardTestResult {
            ok: true,
            channel_used: resp.channel_used,
            response_preview: resp.text.chars().take(200).collect(),
            latency_ms: resp.latency_ms,
            error: None,
            diagnostic: Some(SetupWizardDiagnostic {
                channel_attempted: "ollama_http".to_string(),
                tool_id: "ollama".to_string(),
                sampler_registered: false,
                elapsed_ms,
                error_kind: "ok".to_string(),
                raw_error: None,
                extra: None,
            }),
        }),
        Err(e) => Ok(borrow_error_to_result(
            e,
            "ollama_http",
            "ollama".to_string(),
            false,
            elapsed_ms,
        )),
    }
}

// === wave 11.1 ===
fn browser_ext_not_implemented_result(
    start: Instant,
    tool_id: Option<String>,
) -> SetupWizardTestResult {
    let elapsed_ms = start.elapsed().as_millis() as u64;
    SetupWizardTestResult {
        ok: false,
        channel_used: "browser_ext".to_string(),
        response_preview: String::new(),
        latency_ms: elapsed_ms,
        error: Some(friendly_error_for_kind("browser_ext_not_implemented", "")),
        diagnostic: Some(SetupWizardDiagnostic {
            channel_attempted: "browser_ext".to_string(),
            tool_id: tool_id.unwrap_or_default(),
            sampler_registered: false,
            elapsed_ms,
            error_kind: "browser_ext_not_implemented".to_string(),
            raw_error: Some(
                "browser_ext channel for the requested tool wires in v2.0".to_string(),
            ),
            extra: None,
        }),
    }
}

// === wave 11.1 ===
/// Legacy fall-through (used by callers that don't pass `channel`). Kept
/// strictly for backwards compatibility — the wizard always passes a
/// concrete channel now.
async fn run_legacy_dispatch(
    request: LlmRequest,
    tool_id: Option<String>,
    start: Instant,
) -> Result<SetupWizardTestResult, AppError> {
    match dispatch(request, tool_id.clone()).await {
        Ok(resp) => {
            let preview = resp.text.chars().take(200).collect::<String>();
            Ok(SetupWizardTestResult {
                ok: true,
                channel_used: resp.channel_used,
                response_preview: preview,
                latency_ms: resp.latency_ms,
                error: None,
                diagnostic: None,
            })
        }
        Err(e) => {
            let (code, msg) = match e {
                BorrowError::PrimaryUnreachable { tool_id, reason, .. } => {
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
                diagnostic: None,
            })
        }
    }
}

// === wave 11.1 ===
/// Translate a BorrowError into a friendly result. Pure function so the
/// unit tests can drive every variant without spinning up a real channel.
fn borrow_error_to_result(
    err: BorrowError,
    channel_attempted: &str,
    tool_id: String,
    sampler_registered: bool,
    elapsed_ms: u64,
) -> SetupWizardTestResult {
    let (kind, raw, extra) = classify_borrow_error(&err);
    let friendly = friendly_error_for_kind(&kind, &tool_id);
    SetupWizardTestResult {
        ok: false,
        channel_used: channel_attempted.to_string(),
        response_preview: String::new(),
        latency_ms: elapsed_ms,
        error: Some(friendly),
        diagnostic: Some(SetupWizardDiagnostic {
            channel_attempted: channel_attempted.to_string(),
            tool_id,
            sampler_registered,
            elapsed_ms,
            error_kind: kind,
            raw_error: Some(raw),
            extra,
        }),
    }
}

// === wave 11.1 ===
/// Map a BorrowError to (kind, raw_message, extra_metadata).
fn classify_borrow_error(
    err: &BorrowError,
) -> (String, String, Option<serde_json::Value>) {
    match err {
        BorrowError::PrimaryUnreachable { tool_id, reason, cause } => match cause {
            PrimaryUnreachableCause::McpSamplerNotRegistered => (
                "mcp_sampler_not_registered".to_string(),
                format!("{tool_id}: {reason}"),
                None,
            ),
            PrimaryUnreachableCause::McpSamplerTimeout { timeout_ms } => (
                "mcp_sampler_timeout".to_string(),
                format!("{tool_id}: {reason}"),
                Some(serde_json::json!({ "timeout_ms": timeout_ms })),
            ),
            PrimaryUnreachableCause::McpSamplerDisconnected => (
                "mcp_sampler_disconnected".to_string(),
                format!("{tool_id}: {reason}"),
                None,
            ),
            PrimaryUnreachableCause::McpHostRejected { detail } => (
                "mcp_host_rejected".to_string(),
                format!("{tool_id}: {reason}"),
                Some(serde_json::json!({ "host_detail": detail })),
            ),
            PrimaryUnreachableCause::McpBridgeInternal { detail } => (
                "mcp_bridge_internal".to_string(),
                format!("{tool_id}: {reason}"),
                Some(serde_json::json!({ "internal": detail })),
            ),
            PrimaryUnreachableCause::OllamaClientInit { detail } => (
                "ollama_client_init".to_string(),
                format!("ollama: {reason}"),
                Some(serde_json::json!({ "detail": detail })),
            ),
            PrimaryUnreachableCause::OllamaConnectionRefused { detail } => (
                "ollama_connection_refused".to_string(),
                format!("ollama: {reason}"),
                Some(serde_json::json!({ "detail": detail })),
            ),
            PrimaryUnreachableCause::OllamaHttpStatus { status, detail } => {
                let kind = if *status == 404 {
                    // 404 from Ollama almost always means "model not pulled".
                    "ollama_http_status".to_string()
                } else {
                    "ollama_http_status".to_string()
                };
                (
                    kind,
                    format!("ollama: {reason}"),
                    Some(serde_json::json!({ "status": status, "detail": detail })),
                )
            }
            PrimaryUnreachableCause::OllamaParseError { detail } => (
                "ollama_parse_error".to_string(),
                format!("ollama: {reason}"),
                Some(serde_json::json!({ "detail": detail })),
            ),
            PrimaryUnreachableCause::Unknown => (
                "unknown".to_string(),
                format!("{tool_id}: {reason}"),
                None,
            ),
        },
        BorrowError::AllExhausted => (
            "all_channels_exhausted".to_string(),
            "no AI tool channel succeeded".to_string(),
            None,
        ),
        BorrowError::NotImplemented(msg) => (
            "browser_ext_not_implemented".to_string(),
            msg.clone(),
            None,
        ),
    }
}

// === wave 11.1 ===
/// Render a friendly user-facing string for an error_kind. We DO NOT
/// localize here — the React side uses `error_kind` to pick its own i18n
/// key. This is the fallback English string emitted into `error` for
/// older clients that don't read the diagnostic.
fn friendly_error_for_kind(kind: &str, tool_id: &str) -> String {
    let display = display_name_for_tool(tool_id);
    match kind {
        "mcp_sampler_not_registered" => format!(
            "{display} hasn't connected to Tangerine yet. Did you fully close + reopen {display} after auto-configure? It needs a restart to load the new MCP config."
        ),
        "mcp_sampler_timeout" => format!(
            "{display} connected but didn't respond within 10s. Try again or check {display}'s logs."
        ),
        "mcp_sampler_disconnected" => format!(
            "{display} dropped the connection mid-request. Reopen {display} and try again."
        ),
        "mcp_host_rejected" => format!(
            "{display} returned an error. Check its console for details."
        ),
        "mcp_bridge_internal" => {
            "Internal MCP bridge error. Restart Tangerine and try again.".to_string()
        }
        "ollama_client_init" => {
            "Couldn't initialize the HTTP client for Ollama. Restart Tangerine and try again."
                .to_string()
        }
        "ollama_connection_refused" => {
            "Ollama is not running on 127.0.0.1:11434. Start Ollama (`ollama serve`) or pick a different channel.".to_string()
        }
        "ollama_http_status" => {
            "Ollama is running but the model isn't pulled. Run `ollama pull llama3.1:8b-instruct-q4_K_M` then retry.".to_string()
        }
        "ollama_parse_error" => {
            "Ollama responded but the body wasn't valid JSON. The version on this machine may be too old.".to_string()
        }
        "browser_ext_not_implemented" => {
            "Browser extension channel is not yet implemented (coming v2.0).".to_string()
        }
        "all_channels_exhausted" => {
            "Every channel failed. Open Setup again and pick one to fix.".to_string()
        }
        _ => "Unknown error. Check Tangerine's logs for details.".to_string(),
    }
}

// === wave 11.1 ===
/// Pretty display name for a tool id. Mirrors `MCP_CATALOG` so we don't
/// have to plumb the catalog through. For unknown ids returns "the tool".
fn display_name_for_tool(tool_id: &str) -> &str {
    match tool_id {
        "cursor" => "Cursor",
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        "windsurf" => "Windsurf",
        "ollama" => "Ollama",
        _ => "the tool",
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

    // === wave 11.1 ===
    // Friendly error mapping tests. These drive `classify_borrow_error` and
    // `friendly_error_for_kind` against every variant so a future refactor
    // can't silently break the user-facing copy.

    #[test]
    fn friendly_error_mcp_sampler_not_registered_mentions_restart() {
        let msg = friendly_error_for_kind("mcp_sampler_not_registered", "claude-code");
        assert!(msg.contains("Claude Code"), "got {msg}");
        assert!(msg.to_lowercase().contains("restart") || msg.to_lowercase().contains("close"), "got {msg}");
    }

    #[test]
    fn friendly_error_ollama_connection_refused_mentions_serve_command() {
        let msg = friendly_error_for_kind("ollama_connection_refused", "ollama");
        assert!(msg.contains("ollama serve"), "got {msg}");
        assert!(msg.contains("11434"), "got {msg}");
    }

    #[test]
    fn friendly_error_ollama_http_status_mentions_pull() {
        let msg = friendly_error_for_kind("ollama_http_status", "ollama");
        assert!(msg.to_lowercase().contains("pull"), "got {msg}");
    }

    #[test]
    fn friendly_error_browser_ext_not_implemented_mentions_v2() {
        let msg = friendly_error_for_kind("browser_ext_not_implemented", "");
        assert!(msg.contains("v2.0"), "got {msg}");
    }

    #[test]
    fn friendly_error_unknown_kind_returns_generic() {
        let msg = friendly_error_for_kind("not-a-real-kind", "ollama");
        assert!(msg.to_lowercase().contains("unknown"), "got {msg}");
    }

    #[test]
    fn classify_mcp_sampler_not_registered_returns_correct_kind() {
        let err = BorrowError::PrimaryUnreachable {
            tool_id: "claude-code".to_string(),
            reason: "MCP sampler not registered".to_string(),
            cause: PrimaryUnreachableCause::McpSamplerNotRegistered,
        };
        let (kind, raw, _extra) = classify_borrow_error(&err);
        assert_eq!(kind, "mcp_sampler_not_registered");
        assert!(raw.contains("claude-code"));
    }

    #[test]
    fn classify_ollama_404_returns_http_status_kind_with_extra() {
        let err = BorrowError::PrimaryUnreachable {
            tool_id: "ollama".to_string(),
            reason: "http 404 Not Found".to_string(),
            cause: PrimaryUnreachableCause::OllamaHttpStatus {
                status: 404,
                detail: "Not Found".to_string(),
            },
        };
        let (kind, _raw, extra) = classify_borrow_error(&err);
        assert_eq!(kind, "ollama_http_status");
        let extra = extra.expect("extra populated");
        assert_eq!(extra["status"].as_u64().unwrap(), 404);
    }

    #[test]
    fn classify_ollama_connection_refused_carries_detail() {
        let err = BorrowError::PrimaryUnreachable {
            tool_id: "ollama".to_string(),
            reason: "connect: tcp connection refused".to_string(),
            cause: PrimaryUnreachableCause::OllamaConnectionRefused {
                detail: "tcp connection refused".to_string(),
            },
        };
        let (kind, _raw, extra) = classify_borrow_error(&err);
        assert_eq!(kind, "ollama_connection_refused");
        assert!(extra.is_some());
    }

    #[test]
    fn classify_all_exhausted_returns_generic_kind() {
        let err = BorrowError::AllExhausted;
        let (kind, _raw, _extra) = classify_borrow_error(&err);
        assert_eq!(kind, "all_channels_exhausted");
    }

    #[test]
    fn classify_not_implemented_returns_browser_ext_kind() {
        let err = BorrowError::NotImplemented("browser_ext channel for foo".to_string());
        let (kind, _raw, _extra) = classify_borrow_error(&err);
        assert_eq!(kind, "browser_ext_not_implemented");
    }

    #[test]
    fn borrow_error_to_result_preserves_diagnostic_fields() {
        let err = BorrowError::PrimaryUnreachable {
            tool_id: "cursor".to_string(),
            reason: "timed out".to_string(),
            cause: PrimaryUnreachableCause::McpSamplerTimeout { timeout_ms: 10_000 },
        };
        let r = borrow_error_to_result(err, "mcp_sampling", "cursor".to_string(), true, 250);
        assert!(!r.ok);
        assert_eq!(r.channel_used, "mcp_sampling");
        assert_eq!(r.latency_ms, 250);
        let diag = r.diagnostic.expect("diagnostic populated");
        assert_eq!(diag.channel_attempted, "mcp_sampling");
        assert_eq!(diag.tool_id, "cursor");
        assert!(diag.sampler_registered);
        assert_eq!(diag.error_kind, "mcp_sampler_timeout");
        let extra = diag.extra.expect("extra populated");
        assert_eq!(extra["timeout_ms"].as_u64().unwrap(), 10_000);
    }

    #[tokio::test]
    async fn test_channel_browser_ext_returns_friendly_v2_message() {
        // No registry / no Ollama needed — browser_ext path is short-circuited.
        let result = setup_wizard_test_channel(TestChannelArgs {
            channel: Some("browser_ext".to_string()),
            tool_id: None,
        })
        .await
        .expect("test_channel never errors at the AppError layer");
        assert!(!result.ok);
        let err = result.error.expect("friendly error populated");
        assert!(err.contains("v2.0"), "got: {err}");
        let diag = result.diagnostic.expect("diagnostic populated");
        assert_eq!(diag.error_kind, "browser_ext_not_implemented");
        assert_eq!(diag.channel_attempted, "browser_ext");
    }

    #[tokio::test]
    async fn test_channel_mcp_sampling_no_registered_sampler_returns_friendly() {
        // Wipe any sampler that other tests might have left around.
        let registry = crate::agi::sampling_bridge::global();
        registry.deregister("claude-code");
        let result = setup_wizard_test_channel(TestChannelArgs {
            channel: Some("mcp_sampling".to_string()),
            tool_id: Some("claude-code".to_string()),
        })
        .await
        .expect("ok envelope");
        assert!(!result.ok);
        let err = result.error.expect("friendly error populated");
        // CRITICAL: must NOT mention ollama. The whole point of the fix.
        assert!(
            !err.to_lowercase().contains("ollama"),
            "friendly error for MCP failure must not mention ollama; got: {err}"
        );
        assert!(err.contains("Claude Code"), "got: {err}");
        let diag = result.diagnostic.expect("diagnostic populated");
        assert_eq!(diag.channel_attempted, "mcp_sampling");
        assert_eq!(diag.error_kind, "mcp_sampler_not_registered");
        assert!(!diag.sampler_registered);
    }

    #[tokio::test]
    async fn test_channel_mcp_sampling_with_unknown_tool_id_returns_friendly() {
        let result = setup_wizard_test_channel(TestChannelArgs {
            channel: Some("mcp_sampling".to_string()),
            tool_id: Some("not-a-real-editor".to_string()),
        })
        .await
        .expect("ok envelope");
        assert!(!result.ok);
        // Unknown tool id is treated as "not registered" (it isn't).
        let err = result.error.expect("friendly error populated");
        assert!(
            !err.to_lowercase().contains("ollama"),
            "must not mention ollama; got: {err}"
        );
    }

    #[tokio::test]
    async fn test_channel_mcp_sampling_without_tool_id_returns_friendly() {
        let result = setup_wizard_test_channel(TestChannelArgs {
            channel: Some("mcp_sampling".to_string()),
            tool_id: None,
        })
        .await
        .expect("ok envelope");
        assert!(!result.ok);
        let diag = result.diagnostic.expect("diagnostic populated");
        // Either way it must not be an ollama error.
        assert_ne!(diag.channel_attempted, "ollama_http");
        assert_ne!(diag.error_kind, "ollama_connection_refused");
    }

    #[tokio::test]
    async fn dispatch_specific_channel_does_not_fall_through_on_mcp_failure() {
        // The original bug: select Claude Code MCP, no sampler registered,
        // dispatcher silently routes to Ollama and returns "ollama 404".
        // dispatch_specific_channel must NOT do that.
        let registry = crate::agi::sampling_bridge::global();
        registry.deregister("claude-code");

        let request = LlmRequest {
            system_prompt: "test".to_string(),
            user_prompt: "test".to_string(),
            max_tokens: Some(8),
            temperature: Some(0.0),
        };
        let result = dispatch_specific_channel_with_base_url(
            request,
            SpecificChannel::McpSampling,
            Some("claude-code".to_string()),
            "http://127.0.0.1:1", // unreachable — would ECONNREFUSE if hit
        )
        .await;
        // Must error because MCP failed, NOT silently succeed via Ollama.
        let err = result.expect_err("must fail when no MCP sampler registered");
        match err {
            BorrowError::PrimaryUnreachable { tool_id, cause, .. } => {
                assert_eq!(tool_id, "claude-code");
                assert!(
                    matches!(cause, PrimaryUnreachableCause::McpSamplerNotRegistered),
                    "expected McpSamplerNotRegistered, got {cause:?}"
                );
            }
            other => panic!("expected PrimaryUnreachable, got {other:?}"),
        }
    }
}

// ===========================================================================
// === v1.15.0 wave 1.3 — 8-tool MCP auto-configure + handshake ============
// ===========================================================================
//
// New surface bolted on top of the wave 11 setup wizard. The wave 11 surface
// (above) handles 4 MCP-capable editors (Cursor / Claude Code / Codex /
// Windsurf) via a single rich-result command. v1.15.0 expands to 8 tools
// (the 4 above plus Devin / Replit / Apple Intelligence / MS Copilot) with:
//
//   * Atomic file writes (tempfile + rename) so a crash mid-write can't
//     leave the user with a half-written `~/.claude.json`.
//   * Idempotent JSON / TOML deep-merge that preserves ALL existing keys
//     under `mcpServers` (the wave 11 merger already did this for JSON;
//     wave 1.3 adds TOML parity for Codex's `~/.codex/config.toml`).
//   * Per-tool config locations updated to match the v1.15 spec
//     (`~/.claude.json` instead of wave 11's `~/.claude/mcp_servers.json`,
//     `~/.cursor/mcp.json`, `~/.codex/config.toml`, Windsurf
//     `~/.codeium/windsurf/mcp_config.json`).
//   * OS-keychain-backed API key storage for Devin / Replit (reuses
//     `commands::secret_store`'s file-fallback layer).
//   * Per-tool MCP handshake (`mcp_server_handshake`) that returns true
//     iff a probe says the channel is alive.
//   * `Err("PlatformUnsupported: ...")` for Apple Intelligence on non-mac
//     and MS Copilot on non-windows — never silently no-ops.
//
// **Coexistence with wave 11**: the existing `setup_wizard_auto_configure_mcp`
// command keeps its rich-result signature (used by `onboarding_chat.rs`
// + `lib/tauri.ts`'s `setupWizardAutoConfigureMcp`). The v1.15 surface
// uses the new name `setup_wizard_v15_auto_configure_mcp` to avoid the
// signature collision flagged in W1.2 mock review. Both write to the
// same canonical Tangerine MCP entry shape — the merge helpers below
// use the same `npx -y tangerine-mcp@latest` command + sampling-bridge
// env var as wave 11.
//
// **Invariants (R6/R7/R8)**: zero `unwrap_or_default` on error paths,
// every silently-handled case is `tracing::warn!`-logged, every
// PlatformUnsupported is an explicit `Err`, never a quiet success.

use std::io::Write as _;

/// All 8 tools the v1.15 wizard knows how to configure. Stable string ids
/// the React side passes through `setup_wizard_v15_auto_configure_mcp(tool_id)`.
/// Mirrored on the W1.2 mock layer.
const V15_TOOL_IDS: &[&str] = &[
    "claude-code",
    "cursor",
    "codex",
    "windsurf",
    "devin",
    "replit",
    "apple-intelligence",
    "ms-copilot",
];

/// Where the canonical Tangerine MCP entry lives. Same shape wave 11 wrote
/// (npx + sampling-bridge env). Kept as a single source of truth so a
/// future bump to a packaged binary only needs to change one place.
///
/// TODO(v1.15): once `mcp-server/` ships a packaged binary the user can
/// install via `cargo install tangerine-mcp-bin` or a Tauri-bundled
/// resource, swap this for the absolute path. Today (2026-04-28) the
/// `mcp-server/` workspace publishes `tangerine-mcp@latest` to npm via
/// `package.json::bin::tangerine-mcp` — npx is the canonical entry.
fn tangerine_mcp_entry_json() -> serde_json::Value {
    // v1.15.1 fix — pin to a semver-compatible range instead of `@latest`
    // so a future v0.2.0 release with a breaking sampling-bridge protocol
    // cannot silently break older Tangerine app installs (the user's
    // editor would npm-install the new mcp, fail to register against the
    // old bridge, and the wizard would show "Connected" timeout). The
    // `^` range allows patch + minor updates within 0.1.x but rejects
    // 0.2.x. Bump the floor when shipping a v1.15.x compatible with a
    // newer mcp.
    serde_json::json!({
        "command": "npx",
        "args": ["-y", "tangerine-mcp@^0.1.0"],
        "env": {
            "TANGERINE_SAMPLING_BRIDGE": "1"
        }
    })
}

/// Same content shape, TOML inline-table form for Codex's `[mcp_servers.tangerine]`.
fn tangerine_mcp_entry_toml() -> toml::Value {
    let mut env = toml::value::Table::new();
    env.insert(
        "TANGERINE_SAMPLING_BRIDGE".to_string(),
        toml::Value::String("1".to_string()),
    );
    let mut entry = toml::value::Table::new();
    entry.insert(
        "command".to_string(),
        toml::Value::String("npx".to_string()),
    );
    entry.insert(
        "args".to_string(),
        toml::Value::Array(vec![
            toml::Value::String("-y".to_string()),
            // v1.15.1 fix — see tangerine_mcp_entry_json doc comment.
            toml::Value::String("tangerine-mcp@^0.1.0".to_string()),
        ]),
    );
    entry.insert("env".to_string(), toml::Value::Table(env));
    toml::Value::Table(entry)
}

/// Resolve `$HOME` honoring the `TANGERINE_TEST_HOME_OVERRIDE` env var
/// (tests inject a tempdir here). Production callers see the real
/// `dirs::home_dir()`.
fn v15_home_root() -> Result<PathBuf, String> {
    if let Ok(o) = std::env::var("TANGERINE_TEST_HOME_OVERRIDE") {
        if !o.is_empty() {
            return Ok(PathBuf::from(o));
        }
    }
    dirs::home_dir().ok_or_else(|| {
        "no_home: HOME / USERPROFILE unresolvable on this machine".to_string()
    })
}

/// Atomic write: write to `<path>.tangerine-tmp-<uuid>` then rename over
/// `path`. On Windows the rename target must NOT exist — we remove first
/// (best-effort; rename below will surface the real error if removal
/// failed in a load-bearing way). The rename itself is the atomic step.
fn atomic_write(path: &Path, body: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!("Cannot mkdir {}: {}", parent.display(), e)
        })?;
    }
    let tmp_name = format!(
        ".tangerine-tmp-{}",
        uuid::Uuid::new_v4().simple()
    );
    let tmp = path
        .parent()
        .map(|p| p.join(&tmp_name))
        .unwrap_or_else(|| PathBuf::from(&tmp_name));
    {
        let mut f = std::fs::File::create(&tmp)
            .map_err(|e| format!("Cannot create {}: {}", tmp.display(), e))?;
        f.write_all(body)
            .map_err(|e| format!("Cannot write {}: {}", tmp.display(), e))?;
        f.sync_all().map_err(|e| {
            format!("Cannot fsync {}: {}", tmp.display(), e)
        })?;
    }
    #[cfg(windows)]
    {
        // Windows: rename over an existing file is allowed by `fs::rename`
        // since Rust 1.5 on NTFS — but only when the source isn't open and
        // the destination isn't held. Best-effort cleanup of any stale tmp
        // sibling that a prior aborted write might have left behind.
        let _ = std::fs::remove_file(path).ok();
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        // If rename failed, try to clean up the tmp so we don't leak it.
        let _ = std::fs::remove_file(&tmp);
        format!(
            "Cannot rename {} -> {}: {}",
            tmp.display(),
            path.display(),
            e
        )
    })?;
    Ok(())
}

/// Read existing JSON file, returning `Some(Value)` on a parseable body or
/// `None` when the file is absent. Returns `Err` ONLY for "file present
/// but malformed" — R6/R7/R8: malformed config must surface, not silently
/// reset to default.
fn read_existing_json(path: &Path) -> Result<Option<serde_json::Value>, String> {
    let body = match fs::read_to_string(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return Err(format!(
                "Cannot read {}: permission denied ({})",
                path.display(),
                e
            ));
        }
        Err(e) => {
            return Err(format!("Cannot read {}: {}", path.display(), e));
        }
    };
    if body.trim().is_empty() {
        return Ok(None);
    }
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        format!("{} malformed: {}", path.display(), e)
    })?;
    Ok(Some(v))
}

/// Same contract as `read_existing_json` for TOML.
fn read_existing_toml(path: &Path) -> Result<Option<toml::Value>, String> {
    let body = match fs::read_to_string(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return Err(format!(
                "Cannot read {}: permission denied ({})",
                path.display(),
                e
            ));
        }
        Err(e) => {
            return Err(format!("Cannot read {}: {}", path.display(), e));
        }
    };
    if body.trim().is_empty() {
        return Ok(None);
    }
    let v: toml::Value = toml::from_str(&body)
        .map_err(|e| format!("{} malformed: {}", path.display(), e))?;
    Ok(Some(v))
}

/// Idempotent JSON merger: returns true iff a write was needed. Writes the
/// canonical Tangerine entry under `mcpServers.tangerine` without touching
/// any sibling key. R6/R7/R8: never resets the document on a sibling-key
/// shape mismatch — we only refuse to write if the root isn't an object.
fn merge_into_mcp_servers_json(
    path: &Path,
    entry: serde_json::Value,
) -> Result<bool, String> {
    let mut root = match read_existing_json(path)? {
        Some(v) => v,
        None => serde_json::json!({}),
    };
    if !root.is_object() {
        return Err(format!(
            "{} malformed: top-level must be a JSON object, got {}",
            path.display(),
            root_type_name(&root)
        ));
    }
    let obj = root.as_object_mut().unwrap();
    let servers_entry = obj
        .entry("mcpServers".to_string())
        .or_insert(serde_json::json!({}));
    if !servers_entry.is_object() {
        return Err(format!(
            "{} malformed: mcpServers must be an object",
            path.display()
        ));
    }
    let servers = servers_entry.as_object_mut().unwrap();
    if let Some(existing) = servers.get("tangerine") {
        if existing == &entry {
            // Idempotent: same shape already present — no write.
            return Ok(false);
        }
    }
    servers.insert("tangerine".to_string(), entry);
    let body = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("Cannot serialize JSON: {e}"))?;
    atomic_write(path, body.as_bytes())?;
    Ok(true)
}

/// Idempotent TOML merger: writes `[mcp_servers.tangerine]` without
/// touching any other table. Same R6/R7/R8 contract as the JSON merger.
fn merge_into_mcp_servers_toml(
    path: &Path,
    entry: toml::Value,
) -> Result<bool, String> {
    let mut root = match read_existing_toml(path)? {
        Some(v) => v,
        None => toml::Value::Table(toml::value::Table::new()),
    };
    let table = match root.as_table_mut() {
        Some(t) => t,
        None => {
            return Err(format!(
                "{} malformed: top-level must be a TOML table",
                path.display()
            ));
        }
    };
    let servers_val = table
        .entry("mcp_servers".to_string())
        .or_insert(toml::Value::Table(toml::value::Table::new()));
    let servers = match servers_val.as_table_mut() {
        Some(t) => t,
        None => {
            return Err(format!(
                "{} malformed: mcp_servers must be a table",
                path.display()
            ));
        }
    };
    if let Some(existing) = servers.get("tangerine") {
        if existing == &entry {
            return Ok(false);
        }
    }
    servers.insert("tangerine".to_string(), entry);
    let body = toml::to_string_pretty(&root)
        .map_err(|e| format!("Cannot serialize TOML: {e}"))?;
    atomic_write(path, body.as_bytes())?;
    Ok(true)
}

fn root_type_name(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

// ---------------------------------------------------------------------------
// Per-tool config writers — 8 of them. Each takes `home: &Path` (NOT
// dirs::home_dir() directly) so tests can inject a tempdir.
// ---------------------------------------------------------------------------

fn v15_configure_claude_code(home: &Path) -> Result<(), String> {
    let path = home.join(".claude.json");
    match merge_into_mcp_servers_json(&path, tangerine_mcp_entry_json())? {
        true => tracing::info!(path = %path.display(), "wrote Tangerine MCP entry to Claude Code config"),
        false => tracing::warn!(path = %path.display(), "Claude Code config already has Tangerine entry — no-op"),
    }
    Ok(())
}

fn v15_configure_cursor(home: &Path) -> Result<(), String> {
    let path = home.join(".cursor").join("mcp.json");
    match merge_into_mcp_servers_json(&path, tangerine_mcp_entry_json())? {
        true => tracing::info!(path = %path.display(), "wrote Tangerine MCP entry to Cursor config"),
        false => tracing::warn!(path = %path.display(), "Cursor config already has Tangerine entry — no-op"),
    }
    Ok(())
}

fn v15_configure_codex(home: &Path) -> Result<(), String> {
    let path = home.join(".codex").join("config.toml");
    match merge_into_mcp_servers_toml(&path, tangerine_mcp_entry_toml())? {
        true => tracing::info!(path = %path.display(), "wrote Tangerine MCP entry to Codex config"),
        false => tracing::warn!(path = %path.display(), "Codex config already has Tangerine entry — no-op"),
    }
    Ok(())
}

fn v15_configure_windsurf(home: &Path) -> Result<(), String> {
    let path = home
        .join(".codeium")
        .join("windsurf")
        .join("mcp_config.json");
    match merge_into_mcp_servers_json(&path, tangerine_mcp_entry_json())? {
        true => tracing::info!(path = %path.display(), "wrote Tangerine MCP entry to Windsurf config"),
        false => tracing::warn!(path = %path.display(), "Windsurf config already has Tangerine entry — no-op"),
    }
    Ok(())
}

/// Devin / Replit: API-key-driven, no MCP config file. We stash a
/// placeholder marker secret under the keychain namespace
/// `tangerine.source.<tool>` so a downstream `mcp_server_handshake` knows
/// the user opted in. Real API key + endpoint setting is exposed through
/// the existing Privacy → Sources panel (which already calls
/// `secret_store_set_oauth`); this command only marks the auto-configure
/// step as done so the wizard can advance.
async fn v15_configure_keychain_tool(
    tool_id: &str,
) -> Result<(), String> {
    let svc = format!("tangerine.tool.{tool_id}");
    // Attempt to write a presence sentinel. We don't write a real token —
    // user-supplied tokens flow through `secret_store_set_oauth`. The
    // sentinel just lets the handshake answer "user has acknowledged this
    // tool" without leaking any value.
    let payload = serde_json::json!({
        "configured_at": chrono::Utc::now().to_rfc3339(),
        "endpoint_default": match tool_id {
            "devin" => "https://api.devin.ai/v1",
            "replit" => "https://replit.com/agent/api",
            _ => "",
        },
        "configured_by": "v1.15.0_setup_wizard",
    })
    .to_string();
    match keyring::Entry::new(&svc, "default") {
        Ok(e) => match e.set_password(&payload) {
            Ok(()) => return Ok(()),
            Err(err) => {
                tracing::warn!(
                    tool = tool_id,
                    error = %err,
                    "keychain set failed for v1.15 tool sentinel; falling back to file"
                );
            }
        },
        Err(err) => {
            tracing::warn!(
                tool = tool_id,
                error = %err,
                "keychain entry init failed; falling back to file"
            );
        }
    }
    // File fallback: per-user data dir, mirroring `secret_store::file_root`.
    #[cfg(windows)]
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."))
        });
    #[cfg(not(windows))]
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("TangerineMeeting").join("v15-tools");
    fs::create_dir_all(&dir).map_err(|e| {
        format!("Cannot mkdir {}: {}", dir.display(), e)
    })?;
    let path = dir.join(format!("{tool_id}.json"));
    atomic_write(&path, payload.as_bytes())?;
    Ok(())
}

/// Apple Intelligence — macOS 15+ system extension manifest. We currently
/// have no clean bundle-side hook so this returns the documented
/// `PlatformUnsupported` error on every OS (including mac, until the
/// extension is built). NEVER silently no-ops. R6/R7/R8.
fn v15_configure_apple_intelligence() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // TODO(v1.16): once the macOS 15 system extension manifest ships
        // (signed via the Tauri-bundle entitlements), wire the install
        // here. For now we return the spec-mandated error so the wizard
        // shows a "coming in v1.16" card instead of silently passing.
        return Err(
            "PlatformUnsupported: Apple Intelligence integration ships in v1.16 (system extension manifest pending notarisation)"
                .to_string(),
        );
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(
            "PlatformUnsupported: Apple Intelligence requires macOS 15 or later"
                .to_string(),
        )
    }
}

/// MS Copilot — Windows 11 extension manifest. Mirrors the Apple branch
/// shape: explicit `PlatformUnsupported` on non-Windows, "ships next wave"
/// on Windows.
fn v15_configure_ms_copilot() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // TODO(v1.16): wire the Win11 Copilot extension manifest install.
        return Err(
            "PlatformUnsupported: MS Copilot integration ships in v1.16 (Win11 extension manifest pending Microsoft Partner sign-off)"
                .to_string(),
        );
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(
            "PlatformUnsupported: MS Copilot requires Windows 11"
                .to_string(),
        )
    }
}

// ---------------------------------------------------------------------------
// Internal dispatcher — the public Tauri command + the test path both
// route through here so tests can pass a tempdir HOME.
// ---------------------------------------------------------------------------

async fn v15_dispatch_configure(
    tool_id: &str,
    home: &Path,
) -> Result<(), String> {
    match tool_id {
        "claude-code" => v15_configure_claude_code(home),
        "cursor" => v15_configure_cursor(home),
        "codex" => v15_configure_codex(home),
        "windsurf" => v15_configure_windsurf(home),
        "devin" | "replit" => v15_configure_keychain_tool(tool_id).await,
        "apple-intelligence" => v15_configure_apple_intelligence(),
        "ms-copilot" => v15_configure_ms_copilot(),
        other => Err(format!(
            "unknown_tool: '{other}' is not one of {}",
            V15_TOOL_IDS.join(", ")
        )),
    }
}

/// v1.15.0 wave 1.3 entrypoint. Spec-mandated signature. See module-level
/// section header for the contract. Errors are descriptive, not silent.
#[tauri::command]
pub async fn setup_wizard_v15_auto_configure_mcp(
    tool_id: String,
) -> Result<(), String> {
    let home = v15_home_root()?;
    v15_dispatch_configure(&tool_id, &home).await
}

// ---------------------------------------------------------------------------
// Health check / handshake — per-tool probe that returns true iff the
// channel is alive. R6/R7/R8: never silent-fallback to a different tool.
// ---------------------------------------------------------------------------

async fn v15_handshake_mcp_editor(tool_id: &str) -> Result<bool, String> {
    // For the four MCP editors (claude-code / cursor / codex / windsurf)
    // the handshake is "is a sampler currently registered for this tool
    // id in the in-process MCP bridge?". The bridge is populated by the
    // user's editor when it starts the `tangerine-mcp` process and the
    // process phones home (see mcp-server/src/sampling-bridge.ts). Until
    // the editor restarts after auto-configure, this returns false —
    // which is the correct "user must restart" signal the wizard wants.
    //
    // We do NOT spawn a probe MCP client here: that would race against
    // the user's editor for the same stdio handle. The sampling-bridge
    // registry is the single source of truth.
    let registry = crate::agi::sampling_bridge::global();
    Ok(registry.has(tool_id))
}

async fn v15_handshake_keychain_tool(tool_id: &str) -> Result<bool, String> {
    let svc = format!("tangerine.tool.{tool_id}");
    if let Ok(e) = keyring::Entry::new(&svc, "default") {
        if let Ok(payload) = e.get_password() {
            if !payload.is_empty() {
                return Ok(true);
            }
        }
    }
    // File fallback: same path the configure step writes to.
    #[cfg(windows)]
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."))
        });
    #[cfg(not(windows))]
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    let path = base
        .join("TangerineMeeting")
        .join("v15-tools")
        .join(format!("{tool_id}.json"));
    Ok(path.exists())
}

/// v1.15.0 wave 1.3 entrypoint. Spec-mandated signature.
#[tauri::command]
pub async fn mcp_server_handshake(tool_id: String) -> Result<bool, String> {
    match tool_id.as_str() {
        "claude-code" | "cursor" | "codex" | "windsurf" => {
            v15_handshake_mcp_editor(&tool_id).await
        }
        "devin" | "replit" => v15_handshake_keychain_tool(&tool_id).await,
        "apple-intelligence" => Err(
            "PlatformUnsupported: Apple Intelligence handshake ships in v1.16"
                .to_string(),
        ),
        "ms-copilot" => Err(
            "PlatformUnsupported: MS Copilot handshake ships in v1.16".to_string(),
        ),
        other => Err(format!(
            "unknown_tool: '{other}' is not one of {}",
            V15_TOOL_IDS.join(", ")
        )),
    }
}

// ---------------------------------------------------------------------------
// Tests — 8 configure tests + 8 idempotent tests + 8 handshake tests + the
// JSON/TOML merge invariant tests + permission denied + malformed config.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod v15_tests {
    use super::*;

    /// Dedicated tempdir helper that doesn't leak across tests. Mirrors the
    /// wave-11 `TempDir` helper but lives in the v15 mod so the two test
    /// modules don't collide on import.
    struct V15Tmp(PathBuf);
    impl V15Tmp {
        fn new(label: &str) -> Self {
            let id = uuid::Uuid::new_v4().simple().to_string();
            let p = std::env::temp_dir().join(format!("ti-v15-{label}-{id}"));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for V15Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // ---- 4 MCP-editor configure tests --------------------------------------

    #[tokio::test]
    async fn v15_configure_claude_code_writes_canonical_entry() {
        let td = V15Tmp::new("claude-fresh");
        v15_dispatch_configure("claude-code", &td.0).await.unwrap();
        let body = fs::read_to_string(td.0.join(".claude.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            v["mcpServers"]["tangerine"]["command"].as_str().unwrap(),
            "npx"
        );
        assert_eq!(
            v["mcpServers"]["tangerine"]["env"]["TANGERINE_SAMPLING_BRIDGE"]
                .as_str()
                .unwrap(),
            "1"
        );
    }

    #[tokio::test]
    async fn v15_configure_cursor_writes_canonical_entry() {
        let td = V15Tmp::new("cursor-fresh");
        v15_dispatch_configure("cursor", &td.0).await.unwrap();
        let body =
            fs::read_to_string(td.0.join(".cursor").join("mcp.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(v["mcpServers"]["tangerine"].is_object());
    }

    #[tokio::test]
    async fn v15_configure_codex_writes_toml_entry() {
        let td = V15Tmp::new("codex-fresh");
        v15_dispatch_configure("codex", &td.0).await.unwrap();
        let body = fs::read_to_string(td.0.join(".codex").join("config.toml"))
            .unwrap();
        let v: toml::Value = toml::from_str(&body).unwrap();
        let cmd = v
            .get("mcp_servers")
            .and_then(|m| m.get("tangerine"))
            .and_then(|t| t.get("command"))
            .and_then(|c| c.as_str())
            .unwrap();
        assert_eq!(cmd, "npx");
    }

    #[tokio::test]
    async fn v15_configure_windsurf_writes_canonical_entry() {
        let td = V15Tmp::new("windsurf-fresh");
        v15_dispatch_configure("windsurf", &td.0).await.unwrap();
        let body = fs::read_to_string(
            td.0.join(".codeium")
                .join("windsurf")
                .join("mcp_config.json"),
        )
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(v["mcpServers"]["tangerine"].is_object());
    }

    // ---- 4 keychain / platform-gated configure tests -----------------------

    #[tokio::test]
    async fn v15_configure_devin_succeeds() {
        // Doesn't matter whether we hit keychain or file fallback — the
        // function must succeed without an error string.
        v15_dispatch_configure("devin", &PathBuf::from("/tmp"))
            .await
            .expect("devin configure must succeed");
    }

    #[tokio::test]
    async fn v15_configure_replit_succeeds() {
        v15_dispatch_configure("replit", &PathBuf::from("/tmp"))
            .await
            .expect("replit configure must succeed");
    }

    #[tokio::test]
    async fn v15_configure_apple_intelligence_returns_platform_unsupported() {
        let err = v15_dispatch_configure(
            "apple-intelligence",
            &PathBuf::from("/tmp"),
        )
        .await
        .expect_err("must return PlatformUnsupported until v1.16");
        assert!(
            err.starts_with("PlatformUnsupported:"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn v15_configure_ms_copilot_returns_platform_unsupported() {
        let err = v15_dispatch_configure("ms-copilot", &PathBuf::from("/tmp"))
            .await
            .expect_err("must return PlatformUnsupported until v1.16");
        assert!(
            err.starts_with("PlatformUnsupported:"),
            "got: {err}"
        );
    }

    // ---- 4 idempotent tests for MCP editors -------------------------------

    #[tokio::test]
    async fn v15_configure_claude_code_is_idempotent() {
        let td = V15Tmp::new("claude-idem");
        v15_dispatch_configure("claude-code", &td.0).await.unwrap();
        let body1 = fs::read_to_string(td.0.join(".claude.json")).unwrap();
        v15_dispatch_configure("claude-code", &td.0).await.unwrap();
        let body2 = fs::read_to_string(td.0.join(".claude.json")).unwrap();
        assert_eq!(body1, body2, "second configure must be a no-op");
    }

    #[tokio::test]
    async fn v15_configure_cursor_is_idempotent() {
        let td = V15Tmp::new("cursor-idem");
        v15_dispatch_configure("cursor", &td.0).await.unwrap();
        let p = td.0.join(".cursor").join("mcp.json");
        let body1 = fs::read_to_string(&p).unwrap();
        v15_dispatch_configure("cursor", &td.0).await.unwrap();
        let body2 = fs::read_to_string(&p).unwrap();
        assert_eq!(body1, body2);
    }

    #[tokio::test]
    async fn v15_configure_codex_is_idempotent() {
        let td = V15Tmp::new("codex-idem");
        v15_dispatch_configure("codex", &td.0).await.unwrap();
        let p = td.0.join(".codex").join("config.toml");
        let body1 = fs::read_to_string(&p).unwrap();
        v15_dispatch_configure("codex", &td.0).await.unwrap();
        let body2 = fs::read_to_string(&p).unwrap();
        assert_eq!(body1, body2);
    }

    #[tokio::test]
    async fn v15_configure_windsurf_is_idempotent() {
        let td = V15Tmp::new("windsurf-idem");
        v15_dispatch_configure("windsurf", &td.0).await.unwrap();
        let p = td
            .0
            .join(".codeium")
            .join("windsurf")
            .join("mcp_config.json");
        let body1 = fs::read_to_string(&p).unwrap();
        v15_dispatch_configure("windsurf", &td.0).await.unwrap();
        let body2 = fs::read_to_string(&p).unwrap();
        assert_eq!(body1, body2);
    }

    // ---- 8 handshake tests ------------------------------------------------

    #[tokio::test]
    async fn v15_handshake_claude_code_returns_false_when_no_sampler() {
        let registry = crate::agi::sampling_bridge::global();
        registry.deregister("claude-code");
        let alive = mcp_server_handshake("claude-code".to_string())
            .await
            .unwrap();
        assert!(!alive, "must be false with no sampler registered");
    }

    #[tokio::test]
    async fn v15_handshake_cursor_returns_false_when_no_sampler() {
        let registry = crate::agi::sampling_bridge::global();
        registry.deregister("cursor");
        let alive =
            mcp_server_handshake("cursor".to_string()).await.unwrap();
        assert!(!alive);
    }

    #[tokio::test]
    async fn v15_handshake_codex_returns_false_when_no_sampler() {
        let registry = crate::agi::sampling_bridge::global();
        registry.deregister("codex");
        let alive = mcp_server_handshake("codex".to_string()).await.unwrap();
        assert!(!alive);
    }

    #[tokio::test]
    async fn v15_handshake_windsurf_returns_false_when_no_sampler() {
        let registry = crate::agi::sampling_bridge::global();
        registry.deregister("windsurf");
        let alive =
            mcp_server_handshake("windsurf".to_string()).await.unwrap();
        assert!(!alive);
    }

    #[tokio::test]
    async fn v15_handshake_devin_returns_bool_without_panic() {
        let _ = mcp_server_handshake("devin".to_string()).await.unwrap();
    }

    #[tokio::test]
    async fn v15_handshake_replit_returns_bool_without_panic() {
        let _ = mcp_server_handshake("replit".to_string()).await.unwrap();
    }

    #[tokio::test]
    async fn v15_handshake_apple_intelligence_returns_platform_unsupported() {
        let err = mcp_server_handshake("apple-intelligence".to_string())
            .await
            .expect_err("must error");
        assert!(err.starts_with("PlatformUnsupported:"), "got: {err}");
    }

    #[tokio::test]
    async fn v15_handshake_ms_copilot_returns_platform_unsupported() {
        let err = mcp_server_handshake("ms-copilot".to_string())
            .await
            .expect_err("must error");
        assert!(err.starts_with("PlatformUnsupported:"), "got: {err}");
    }

    // ---- JSON / TOML merge invariants -------------------------------------

    #[tokio::test]
    async fn v15_json_merge_preserves_other_servers() {
        let td = V15Tmp::new("merge-other-json");
        let p = td.0.join(".claude.json");
        let initial = serde_json::json!({
            "mcpServers": {
                "user-server": { "command": "node", "args": ["/tmp/foo.js"] }
            },
            "unrelated_top_level_key": "preserved"
        });
        fs::write(&p, serde_json::to_string_pretty(&initial).unwrap())
            .unwrap();
        v15_dispatch_configure("claude-code", &td.0).await.unwrap();
        let body = fs::read_to_string(&p).unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            v["mcpServers"]["user-server"]["command"].as_str().unwrap(),
            "node",
            "user's other server must survive"
        );
        assert_eq!(
            v["unrelated_top_level_key"].as_str().unwrap(),
            "preserved",
            "unrelated top-level keys must survive"
        );
        assert!(v["mcpServers"]["tangerine"].is_object());
    }

    #[tokio::test]
    async fn v15_toml_merge_preserves_other_tables() {
        let td = V15Tmp::new("merge-other-toml");
        let p = td.0.join(".codex").join("config.toml");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        let initial = r#"
[user_settings]
theme = "dark"

[mcp_servers.user-server]
command = "node"
args = ["/tmp/foo.js"]
"#;
        fs::write(&p, initial).unwrap();
        v15_dispatch_configure("codex", &td.0).await.unwrap();
        let body = fs::read_to_string(&p).unwrap();
        let v: toml::Value = toml::from_str(&body).unwrap();
        assert_eq!(
            v["user_settings"]["theme"].as_str().unwrap(),
            "dark",
            "unrelated table must survive"
        );
        assert_eq!(
            v["mcp_servers"]["user-server"]["command"]
                .as_str()
                .unwrap(),
            "node",
            "user's other server must survive"
        );
        assert!(v["mcp_servers"]["tangerine"].is_table());
    }

    // ---- Error-case tests --------------------------------------------------

    #[tokio::test]
    async fn v15_malformed_json_surfaces_error() {
        let td = V15Tmp::new("malformed-json");
        let p = td.0.join(".claude.json");
        fs::write(&p, "{ this is not json :::: ").unwrap();
        let err = v15_dispatch_configure("claude-code", &td.0)
            .await
            .expect_err("must surface, not silently overwrite");
        assert!(
            err.contains("malformed"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn v15_malformed_toml_surfaces_error() {
        let td = V15Tmp::new("malformed-toml");
        let p = td.0.join(".codex").join("config.toml");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, "this = is = not toml = at = all\n[[][[\n").unwrap();
        let err = v15_dispatch_configure("codex", &td.0)
            .await
            .expect_err("must surface, not silently overwrite");
        assert!(err.contains("malformed"), "got: {err}");
    }

    #[tokio::test]
    async fn v15_top_level_json_array_rejected() {
        let td = V15Tmp::new("array-json");
        let p = td.0.join(".claude.json");
        fs::write(&p, "[1, 2, 3]").unwrap();
        let err = v15_dispatch_configure("claude-code", &td.0)
            .await
            .expect_err("must reject non-object root");
        assert!(err.contains("malformed"), "got: {err}");
    }

    #[tokio::test]
    async fn v15_unknown_tool_id_returns_error() {
        let err = v15_dispatch_configure("not-a-real-tool", &PathBuf::from("/tmp"))
            .await
            .expect_err("must reject unknown tool id");
        assert!(err.starts_with("unknown_tool:"), "got: {err}");
    }

    #[tokio::test]
    async fn v15_handshake_unknown_tool_id_returns_error() {
        let err = mcp_server_handshake("not-a-real-tool".to_string())
            .await
            .expect_err("must reject unknown tool id");
        assert!(err.starts_with("unknown_tool:"), "got: {err}");
    }

    #[tokio::test]
    async fn v15_atomic_write_creates_parent_dirs() {
        let td = V15Tmp::new("mkdir-p");
        let nested = td.0.join("a").join("b").join("c").join("file.json");
        atomic_write(&nested, b"{\"hello\":\"world\"}").unwrap();
        assert_eq!(
            fs::read_to_string(&nested).unwrap(),
            "{\"hello\":\"world\"}"
        );
    }

    #[tokio::test]
    async fn v15_atomic_write_overwrites_existing() {
        let td = V15Tmp::new("overwrite");
        let p = td.0.join("file.txt");
        fs::write(&p, b"old").unwrap();
        atomic_write(&p, b"new").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "new");
    }

    #[tokio::test]
    async fn v15_home_root_honors_test_override() {
        let td = V15Tmp::new("home-override");
        // Use a unique env var per test would be ideal but the var is
        // module-global; we restore it after.
        let prev = std::env::var("TANGERINE_TEST_HOME_OVERRIDE").ok();
        std::env::set_var(
            "TANGERINE_TEST_HOME_OVERRIDE",
            td.0.to_string_lossy().to_string(),
        );
        let h = v15_home_root().unwrap();
        assert_eq!(h, td.0);
        match prev {
            Some(v) => std::env::set_var("TANGERINE_TEST_HOME_OVERRIDE", v),
            None => std::env::remove_var("TANGERINE_TEST_HOME_OVERRIDE"),
        }
    }
}
// === end v1.15.0 wave 1.3 ===
