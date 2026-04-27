//! Perf (API_SURFACE_SPEC §5): `detect_ai_tools` / `get_ai_tool_status` are
//! read commands → 50 ms p95 typical (one Ollama probe with 1 s timeout pushes
//! worst-case to ~1.1 s; sidebar polls at 60 s so this is acceptable).
//!
//! v1.8 Phase 1 — AI tools detection.
//!
//! Detects whether the user has each of the 10 supported AI tools installed
//! locally. The frontend renders a sidebar status (✅ on / pending setup /
//! not installed) per tool from this data.
//!
//! Detection is best-effort and never errors — tools that can't be detected
//! from the filesystem (claude.ai, ChatGPT, Gemini, v0) are reported as
//! `browser_ext_required`. Ollama is detected via a 1s HTTP probe to
//! localhost:11434/api/tags.
//!
//! All paths are resolved with `dirs::home_dir()` (cross-platform). Windows
//! `%APPDATA%` is read via `dirs::config_dir()` which returns
//! `C:\Users\<user>\AppData\Roaming` on Windows and `~/.config` on Linux.
//! On macOS we fall back to `~/Library/Application Support`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use super::AppError;

#[derive(Serialize, Debug, Clone)]
pub struct AIToolStatus {
    /// Stable id ("cursor", "claude-code", ...).
    pub id: String,
    /// Display name ("Cursor", "Claude Code", ...).
    pub name: String,
    /// "installed" | "not_installed" | "browser_ext_required" | "needs_setup"
    pub status: String,
    /// "mcp" | "browser_ext" | "ide_plugin" | "local_http"
    pub channel: String,
    /// Optional download / install URL shown in the UI when not installed.
    pub install_url: Option<String>,
}

/// Catalog of every supported tool. Order is the order shown in the UI.
const CATALOG: &[(&str, &str, &str, &str)] = &[
    // (id, name, channel, install_url)
    ("cursor", "Cursor", "mcp", "https://cursor.sh/"),
    ("claude-code", "Claude Code", "mcp", "https://claude.ai/download"),
    ("codex", "Codex", "mcp", "https://platform.openai.com/"),
    ("windsurf", "Windsurf", "mcp", "https://codeium.com/windsurf"),
    ("claude-ai", "Claude.ai", "browser_ext", "https://claude.ai/"),
    ("chatgpt", "ChatGPT", "browser_ext", "https://chat.openai.com/"),
    ("gemini", "Gemini", "browser_ext", "https://gemini.google.com/"),
    ("copilot", "GitHub Copilot", "ide_plugin", "https://github.com/features/copilot"),
    ("v0", "v0", "browser_ext", "https://v0.dev/"),
    ("ollama", "Ollama", "local_http", "https://ollama.com/download"),
];

/// Look up the catalog row for `id`. Returns the tuple unchanged.
fn catalog_row(id: &str) -> Option<&'static (&'static str, &'static str, &'static str, &'static str)> {
    CATALOG.iter().find(|(cid, _, _, _)| *cid == id)
}

/// Build a status struct from a catalog row + a detection verdict.
fn build_status(
    row: &(&'static str, &'static str, &'static str, &'static str),
    status: &str,
) -> AIToolStatus {
    AIToolStatus {
        id: row.0.to_string(),
        name: row.1.to_string(),
        status: status.to_string(),
        channel: row.2.to_string(),
        install_url: Some(row.3.to_string()),
    }
}

/// Returns true if the path exists and is a directory.
fn dir_exists(p: &Path) -> bool {
    p.is_dir()
}

/// Returns true if the path exists (file or dir).
fn path_exists(p: &Path) -> bool {
    p.exists()
}

/// Resolve `%APPDATA%` on Windows or its closest equivalent elsewhere.
/// Falls back to `~` if `dirs::config_dir()` returns None (rare).
fn appdata_dir() -> Option<PathBuf> {
    dirs::config_dir().or_else(dirs::home_dir)
}

/// `~/Library/Application Support/<name>` on macOS.
#[cfg(target_os = "macos")]
fn macos_app_support(name: &str) -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join("Library").join("Application Support").join(name))
}

/// Detect Cursor: `%APPDATA%\Cursor` on Windows, `~/.cursor` on Linux,
/// `~/Library/Application Support/Cursor` on macOS. Also check
/// `~/.cursor/mcp.json` for the richer "configured" verdict.
fn detect_cursor() -> &'static str {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return "not_installed",
    };

    // Cross-platform: ~/.cursor exists on Linux + when the user has set up
    // MCP on any OS.
    let dot_cursor = home.join(".cursor");
    let mcp_json = dot_cursor.join("mcp.json");

    #[cfg(target_os = "windows")]
    let platform_dir = appdata_dir().map(|d| d.join("Cursor"));

    #[cfg(target_os = "macos")]
    let platform_dir = macos_app_support("Cursor");

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let platform_dir: Option<PathBuf> = Some(dot_cursor.clone());

    let platform_present = platform_dir.as_deref().map(dir_exists).unwrap_or(false);
    let dot_present = dir_exists(&dot_cursor);
    let mcp_present = path_exists(&mcp_json);

    if mcp_present {
        "installed"
    } else if platform_present || dot_present {
        // App installed but MCP not configured yet.
        "needs_setup"
    } else {
        "not_installed"
    }
}

/// Detect Claude Code: `~/.claude/` dir, plus `~/.claude/mcp_servers.json`
/// for the richer verdict.
fn detect_claude_code() -> &'static str {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return "not_installed",
    };
    let claude_dir = home.join(".claude");
    let mcp_json = claude_dir.join("mcp_servers.json");

    if path_exists(&mcp_json) {
        "installed"
    } else if dir_exists(&claude_dir) {
        "needs_setup"
    } else {
        "not_installed"
    }
}

/// Detect Codex (best-effort — real path may vary by SDK version).
fn detect_codex() -> &'static str {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return "not_installed",
    };
    // ~/.config/openai/ — XDG-style config.
    let openai_cfg = home.join(".config").join("openai");
    // ~/.codex/ — best-effort guess for the codex CLI.
    let codex_dir = home.join(".codex");

    if dir_exists(&openai_cfg) || dir_exists(&codex_dir) {
        "installed"
    } else {
        "needs_setup"
    }
}

/// Detect Windsurf: `~/.windsurf/` and `%APPDATA%\Windsurf` on Windows.
fn detect_windsurf() -> &'static str {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return "not_installed",
    };
    let dot_windsurf = home.join(".windsurf");

    #[cfg(target_os = "windows")]
    let platform_dir = appdata_dir().map(|d| d.join("Windsurf"));

    #[cfg(target_os = "macos")]
    let platform_dir = macos_app_support("Windsurf");

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let platform_dir: Option<PathBuf> = None;

    let platform_present = platform_dir.as_deref().map(dir_exists).unwrap_or(false);
    let dot_present = dir_exists(&dot_windsurf);

    if dot_present {
        "installed"
    } else if platform_present {
        "needs_setup"
    } else {
        "not_installed"
    }
}

/// Detect GitHub Copilot via the VS Code extensions dir
/// (`~/.vscode/extensions/github.copilot-*`). Glob via a manual prefix scan
/// so we don't pull in a `glob` crate.
fn detect_copilot() -> &'static str {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return "not_installed",
    };
    let ext_root = home.join(".vscode").join("extensions");

    let dir_iter = match std::fs::read_dir(&ext_root) {
        Ok(it) => it,
        Err(_) => return "not_installed",
    };

    for entry in dir_iter.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // Matches `github.copilot-1.x.y` and `github.copilot-chat-*`.
        if name_str.starts_with("github.copilot") {
            if entry.path().is_dir() {
                return "installed";
            }
        }
    }
    "not_installed"
}

/// Detect Ollama via HTTP GET to localhost:11434/api/tags with a 1s timeout.
/// Fast path for the common case where Ollama is not running.
async fn detect_ollama() -> &'static str {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
    {
        Ok(c) => c,
        Err(_) => return "not_installed",
    };

    match client.get("http://localhost:11434/api/tags").send().await {
        Ok(resp) if resp.status().is_success() => "installed",
        Ok(_) => "needs_setup",
        Err(_) => "not_installed",
    }
}

/// Run the right detector for `id` and produce a status struct.
async fn detect_one(id: &str) -> AIToolStatus {
    // catalog row is guaranteed for every id we dispatch on; if the id is
    // unknown we still want a sensible struct back.
    let row = match catalog_row(id) {
        Some(r) => r,
        None => {
            return AIToolStatus {
                id: id.to_string(),
                name: id.to_string(),
                status: "not_installed".to_string(),
                channel: "unknown".to_string(),
                install_url: None,
            };
        }
    };

    let verdict = match id {
        "cursor" => detect_cursor(),
        "claude-code" => detect_claude_code(),
        "codex" => detect_codex(),
        "windsurf" => detect_windsurf(),
        "claude-ai" | "chatgpt" | "gemini" | "v0" => "browser_ext_required",
        "copilot" => detect_copilot(),
        "ollama" => detect_ollama().await,
        _ => "not_installed",
    };

    build_status(row, verdict)
}

#[tauri::command]
pub async fn detect_ai_tools() -> Result<Vec<AIToolStatus>, AppError> {
    let mut out = Vec::with_capacity(CATALOG.len());
    for (id, _, _, _) in CATALOG {
        out.push(detect_one(id).await);
    }
    Ok(out)
}

#[tauri::command]
pub async fn get_ai_tool_status(id: String) -> Result<AIToolStatus, AppError> {
    Ok(detect_one(&id).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// Ensure the ollama HTTP probe finishes well under 2 seconds even when
    /// nothing is listening on localhost:11434.
    #[tokio::test]
    async fn test_ollama_detection_timeout() {
        let start = Instant::now();
        let verdict = detect_ollama().await;
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_secs(2),
            "ollama detection took {:?}, expected < 2s",
            elapsed
        );
        // Verdict can be any of the three; we only assert it's a known
        // string so a future change doesn't accidentally introduce a typo.
        assert!(
            matches!(verdict, "installed" | "needs_setup" | "not_installed"),
            "unexpected verdict: {}",
            verdict
        );
    }

    #[tokio::test]
    async fn test_cursor_detection_returns_struct() {
        let status = detect_one("cursor").await;
        assert_eq!(status.id, "cursor");
        assert_eq!(status.name, "Cursor");
        assert_eq!(status.channel, "mcp");
        assert!(status.install_url.is_some());
        assert!(matches!(
            status.status.as_str(),
            "installed" | "needs_setup" | "not_installed"
        ));
    }

    #[tokio::test]
    async fn test_browser_ext_required_tools_have_correct_channel() {
        for id in ["claude-ai", "chatgpt", "gemini", "v0"] {
            let status = detect_one(id).await;
            assert_eq!(status.id, id);
            assert_eq!(status.channel, "browser_ext", "id={id}");
            assert_eq!(status.status, "browser_ext_required", "id={id}");
            assert!(status.install_url.is_some());
        }
    }

    #[tokio::test]
    async fn test_detect_ai_tools_returns_all_ten() {
        let tools = detect_ai_tools().await.expect("detect should not error");
        assert_eq!(tools.len(), 10);
        // Every catalog id must appear exactly once.
        let mut ids: Vec<_> = tools.iter().map(|t| t.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 10);
    }

    #[tokio::test]
    async fn test_get_ai_tool_status_unknown_id() {
        // Unknown ids should still produce a sensible struct without erroring.
        let status = get_ai_tool_status("not-a-real-tool".to_string()).await.unwrap();
        assert_eq!(status.id, "not-a-real-tool");
        assert_eq!(status.status, "not_installed");
    }
}
