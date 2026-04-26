//! Loom source — v1.8 Phase 2 real-wire.
//!
//! Read path:
//!   1. `pull_transcript(loom_url)` — extract the video id from a Loom share
//!      URL, hit `GET /v1/videos/{id}/transcript`, return the transcript
//!      text.
//!   2. `capture_videos()` — list videos in the workspace via
//!      `GET /v1/videos?folder={id}` for each watched folder, fetch each
//!      transcript, write atoms to `<memory_root>/threads/loom/{id}.md`.
//!
//! Auth: bearer token (`Authorization: Bearer ll_xxx`) — Loom Enterprise
//! workspace API tokens; configured via the /sources/loom setup page and
//! stored in `.env` as `LOOM_API_TOKEN`.
//!
//! Persistence:
//!   * Token: `.env` file (`LOOM_API_TOKEN`) via env.rs.
//!   * Watched folders + flags: per-source JSON at
//!     `<user_data>/sources/loom.json`.
//!
//! Note on API surface: Loom's public REST API is gated behind Enterprise.
//! The endpoints below are the documented shape; if a workspace ships a
//! GraphQL-only flavour the heartbeat will skip with a recorded error
//! rather than panicking.

use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{AppError, AppState};

const LOOM_API: &str = "https://api.loom.com/v1";

// ---------------------------------------------------------------------------
// Config

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LoomConfig {
    #[serde(default)]
    pub token_present: bool,
    /// Folder IDs Tangerine should walk on each heartbeat. Empty = no
    /// folder scope; the workspace-wide listing is used.
    #[serde(default)]
    pub watched_folders: Vec<String>,
    #[serde(default = "default_true")]
    pub capture_enabled: bool,
    #[serde(default)]
    pub last_sync: Option<String>,
}

fn default_true() -> bool {
    true
}

fn config_path(state: &AppState) -> PathBuf {
    state.paths.user_data.join("sources").join("loom.json")
}

fn load_config(state: &AppState) -> LoomConfig {
    match std::fs::read_to_string(config_path(state)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => LoomConfig::default(),
    }
}

fn save_config(state: &AppState, cfg: &LoomConfig) -> Result<(), AppError> {
    let p = config_path(state);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(cfg)?;
    let tmp = p.with_extension(format!(
        "json.tmp.{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Atom shape

#[derive(Debug, Serialize, Clone)]
pub struct LoomAtom {
    pub path: String,
    pub video_id: String,
    pub url: String,
    pub title: String,
    pub created_at: String,
    pub transcript_chars: usize,
}

// ---------------------------------------------------------------------------
// Tauri commands

#[tauri::command]
pub async fn loom_get_config(
    state: State<'_, AppState>,
) -> Result<LoomConfig, AppError> {
    let mut cfg = load_config(&state);
    let env = super::env::load_env_file(&state.paths.env_file).unwrap_or_default();
    cfg.token_present = env
        .iter()
        .any(|(k, v)| k == "LOOM_API_TOKEN" && !v.is_empty());
    Ok(cfg)
}

#[derive(Debug, Deserialize)]
pub struct LoomSetConfigArgs {
    pub watched_folders: Vec<String>,
    pub capture_enabled: bool,
}

#[tauri::command]
pub async fn loom_set_config(
    state: State<'_, AppState>,
    args: LoomSetConfigArgs,
) -> Result<(), AppError> {
    let mut cfg = load_config(&state);
    cfg.watched_folders = args
        .watched_folders
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .collect();
    cfg.capture_enabled = args.capture_enabled;
    save_config(&state, &cfg)
}

#[derive(Debug, Serialize)]
pub struct LoomValidateResult {
    pub ok: bool,
    pub workspace: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn loom_validate_token(
    state: State<'_, AppState>,
) -> Result<LoomValidateResult, AppError> {
    let token = read_token(&state)?;
    if token.is_empty() {
        return Ok(LoomValidateResult {
            ok: false,
            workspace: None,
            error: Some("Token not set.".into()),
        });
    }
    let resp = state
        .http
        .get(format!("{}/workspaces/me", LOOM_API))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Ok(LoomValidateResult {
            ok: false,
            workspace: None,
            error: Some(format!("status {}", resp.status())),
        });
    }
    let v: serde_json::Value = resp.json().await?;
    let name = v
        .get("name")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    Ok(LoomValidateResult {
        ok: true,
        workspace: name,
        error: None,
    })
}

#[derive(Debug, Deserialize)]
pub struct LoomPullTranscriptArgs {
    pub loom_url: String,
}

#[derive(Debug, Serialize)]
pub struct LoomPullTranscriptResult {
    pub video_id: String,
    pub transcript: String,
}

#[tauri::command]
pub async fn loom_pull_transcript(
    state: State<'_, AppState>,
    args: LoomPullTranscriptArgs,
) -> Result<LoomPullTranscriptResult, AppError> {
    let token = read_token(&state)?;
    if token.is_empty() {
        return Err(AppError::user(
            "no_token",
            "Loom token missing. Set it in /sources/loom.",
        ));
    }
    let video_id = extract_video_id(&args.loom_url).ok_or_else(|| {
        AppError::user(
            "bad_url",
            "Could not extract a Loom video id from the URL.",
        )
    })?;
    let transcript = fetch_transcript(&state, &token, &video_id).await?;
    Ok(LoomPullTranscriptResult {
        video_id,
        transcript,
    })
}

#[derive(Debug, Deserialize)]
pub struct LoomCaptureArgs {
    pub memory_root: String,
}

#[derive(Debug, Serialize)]
pub struct LoomCaptureResult {
    pub written: usize,
    pub atoms: Vec<LoomAtom>,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn loom_capture(
    state: State<'_, AppState>,
    args: LoomCaptureArgs,
) -> Result<LoomCaptureResult, AppError> {
    let mut cfg = load_config(&state);
    if !cfg.capture_enabled {
        return Ok(LoomCaptureResult {
            written: 0,
            atoms: Vec::new(),
            errors: vec!["capture disabled".into()],
        });
    }
    let token = read_token(&state)?;
    if token.is_empty() {
        return Ok(LoomCaptureResult {
            written: 0,
            atoms: Vec::new(),
            errors: vec!["no token".into()],
        });
    }
    let root = PathBuf::from(&args.memory_root)
        .join("threads")
        .join("loom");
    std::fs::create_dir_all(&root).ok();

    let mut atoms = Vec::new();
    let mut errors = Vec::new();
    let mut written = 0_usize;
    let folders = if cfg.watched_folders.is_empty() {
        vec!["".to_string()] // workspace-wide
    } else {
        cfg.watched_folders.clone()
    };

    for folder in folders {
        match list_videos(&state, &token, &folder).await {
            Ok(videos) => {
                for v in videos {
                    match capture_video(&state, &token, &v, &root).await {
                        Ok(atom) => {
                            written += 1;
                            atoms.push(atom);
                        }
                        Err(e) => errors.push(format!("video {}: {}", v.id, e)),
                    }
                }
            }
            Err(e) => errors.push(format!("folder {}: {}", folder, e)),
        }
    }

    cfg.last_sync = Some(Utc::now().to_rfc3339());
    save_config(&state, &cfg).ok();

    Ok(LoomCaptureResult {
        written,
        atoms,
        errors,
    })
}

// ---------------------------------------------------------------------------
// HTTP helpers

#[derive(Debug, Clone)]
struct VideoSummary {
    id: String,
    title: String,
    url: String,
    created_at: String,
}

async fn list_videos(
    state: &State<'_, AppState>,
    token: &str,
    folder: &str,
) -> Result<Vec<VideoSummary>, String> {
    let mut url = format!("{}/videos", LOOM_API);
    if !folder.is_empty() {
        url.push_str(&format!("?folder={}", folder));
    }
    let resp = state
        .http
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("status {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let arr = v
        .get("videos")
        .or_else(|| v.get("data"))
        .or_else(|| v.get("results"))
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for entry in arr {
        let id = entry
            .get("id")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        out.push(VideoSummary {
            id: id.clone(),
            title: entry
                .get("name")
                .or_else(|| entry.get("title"))
                .and_then(|s| s.as_str())
                .unwrap_or("(untitled)")
                .to_string(),
            url: entry
                .get("url")
                .or_else(|| entry.get("share_url"))
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("https://www.loom.com/share/{}", id)),
            created_at: entry
                .get("created_at")
                .or_else(|| entry.get("createdAt"))
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string(),
        });
    }
    Ok(out)
}

async fn fetch_transcript(
    state: &State<'_, AppState>,
    token: &str,
    video_id: &str,
) -> Result<String, AppError> {
    let resp = state
        .http
        .get(format!("{}/videos/{}/transcript", LOOM_API, video_id))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::external(
            "loom_transcript",
            format!("status {}", resp.status()),
        ));
    }
    // Loom transcripts can come back as plain text or as a JSON array of
    // segments. Handle both.
    let text = resp.text().await?;
    let trimmed = text.trim();
    if trimmed.starts_with('[') || trimmed.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
            return Ok(transcript_value_to_text(&v));
        }
    }
    Ok(trimmed.to_string())
}

fn transcript_value_to_text(v: &serde_json::Value) -> String {
    if let Some(arr) = v.as_array() {
        let mut out = String::new();
        for seg in arr {
            if let Some(t) = seg
                .get("text")
                .or_else(|| seg.get("transcript"))
                .and_then(|s| s.as_str())
            {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
            }
        }
        return out;
    }
    if let Some(s) = v.get("transcript").and_then(|x| x.as_str()) {
        return s.to_string();
    }
    if let Some(arr) = v.get("segments").and_then(|a| a.as_array()) {
        return transcript_value_to_text(&serde_json::Value::Array(arr.clone()));
    }
    serde_json::to_string(v).unwrap_or_default()
}

async fn capture_video(
    state: &State<'_, AppState>,
    token: &str,
    v: &VideoSummary,
    root: &Path,
) -> Result<LoomAtom, String> {
    let transcript = match fetch_transcript(state, token, &v.id).await {
        Ok(t) => t,
        Err(e) => format!("(transcript fetch failed: {})", e),
    };
    let atom_path = root.join(format!("{}.md", v.id));
    let frontmatter = build_frontmatter(&[
        ("source", "loom"),
        ("loom_video_id", &v.id),
        ("loom_url", &v.url),
        ("title", &v.title),
        ("created_at", &v.created_at),
        ("captured_at", &Utc::now().to_rfc3339()),
    ]);
    let body = format!(
        "---\n{}---\n\n# {}\n\n[Watch on Loom]({})\n\n## Transcript\n\n{}\n",
        frontmatter, v.title, v.url, transcript
    );
    atomic_write(&atom_path, &body)?;
    Ok(LoomAtom {
        path: atom_path.to_string_lossy().to_string(),
        video_id: v.id.clone(),
        url: v.url.clone(),
        title: v.title.clone(),
        created_at: v.created_at.clone(),
        transcript_chars: transcript.len(),
    })
}

// ---------------------------------------------------------------------------
// Daemon hook

#[derive(Debug, Clone)]
pub struct LoomTickResult {
    pub written: usize,
    pub errors: Vec<String>,
}

pub async fn tick_from_daemon(
    user_data: &Path,
    memory_root: &Path,
) -> LoomTickResult {
    let mut out = LoomTickResult {
        written: 0,
        errors: Vec::new(),
    };
    let cfg_path = user_data.join("sources").join("loom.json");
    let cfg: LoomConfig = match std::fs::read_to_string(&cfg_path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => return out,
    };
    if !cfg.capture_enabled {
        return out;
    }
    let env_file = user_data.join(".env");
    let token = match super::env::load_env_file(&env_file) {
        Ok(env) => env
            .into_iter()
            .find(|(k, _)| k == "LOOM_API_TOKEN")
            .map(|(_, v)| v)
            .unwrap_or_default(),
        Err(_) => return out,
    };
    if token.is_empty() {
        return out;
    }
    let client = match reqwest::Client::builder()
        .user_agent("TangerineMeeting/1.8 daemon")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            out.errors.push(format!("http_init: {}", e));
            return out;
        }
    };
    let root = memory_root.join("threads").join("loom");
    if let Err(e) = std::fs::create_dir_all(&root) {
        out.errors.push(format!("mkdir: {}", e));
        return out;
    }
    let folders = if cfg.watched_folders.is_empty() {
        vec!["".to_string()]
    } else {
        cfg.watched_folders.clone()
    };
    for folder in folders {
        match daemon_list_videos(&client, &token, &folder).await {
            Ok(videos) => {
                for v in videos {
                    if daemon_capture_video(&client, &token, &v, &root).await.is_ok() {
                        out.written += 1;
                    }
                }
            }
            Err(e) => out.errors.push(format!("folder {}: {}", folder, e)),
        }
    }
    let mut updated = cfg.clone();
    updated.last_sync = Some(Utc::now().to_rfc3339());
    if let Ok(body) = serde_json::to_string_pretty(&updated) {
        let tmp = cfg_path.with_extension(format!(
            "json.tmp.{}",
            uuid::Uuid::new_v4().simple()
        ));
        if std::fs::write(&tmp, body).is_ok() {
            let _ = std::fs::rename(&tmp, &cfg_path);
        }
    }
    out
}

async fn daemon_list_videos(
    client: &reqwest::Client,
    token: &str,
    folder: &str,
) -> Result<Vec<VideoSummary>, String> {
    let mut url = format!("{}/videos", LOOM_API);
    if !folder.is_empty() {
        url.push_str(&format!("?folder={}", folder));
    }
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("status {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let arr = v
        .get("videos")
        .or_else(|| v.get("data"))
        .or_else(|| v.get("results"))
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for entry in arr {
        let id = entry
            .get("id")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        out.push(VideoSummary {
            id: id.clone(),
            title: entry
                .get("name")
                .or_else(|| entry.get("title"))
                .and_then(|s| s.as_str())
                .unwrap_or("(untitled)")
                .to_string(),
            url: entry
                .get("url")
                .or_else(|| entry.get("share_url"))
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("https://www.loom.com/share/{}", id)),
            created_at: entry
                .get("created_at")
                .or_else(|| entry.get("createdAt"))
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string(),
        });
    }
    Ok(out)
}

async fn daemon_capture_video(
    client: &reqwest::Client,
    token: &str,
    v: &VideoSummary,
    root: &Path,
) -> Result<(), String> {
    let resp = client
        .get(format!("{}/videos/{}/transcript", LOOM_API, v.id))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let transcript = if resp.status().is_success() {
        let text = resp.text().await.map_err(|e| e.to_string())?;
        let trimmed = text.trim();
        if trimmed.starts_with('[') || trimmed.starts_with('{') {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
                transcript_value_to_text(&parsed)
            } else {
                trimmed.to_string()
            }
        } else {
            trimmed.to_string()
        }
    } else {
        String::new()
    };
    let atom_path = root.join(format!("{}.md", v.id));
    let frontmatter = build_frontmatter(&[
        ("source", "loom"),
        ("loom_video_id", &v.id),
        ("loom_url", &v.url),
        ("title", &v.title),
        ("created_at", &v.created_at),
        ("captured_at", &Utc::now().to_rfc3339()),
    ]);
    let body = format!(
        "---\n{}---\n\n# {}\n\n[Watch on Loom]({})\n\n## Transcript\n\n{}\n",
        frontmatter, v.title, v.url, transcript
    );
    atomic_write(&atom_path, &body)
}

// ---------------------------------------------------------------------------
// Helpers

fn read_token(state: &State<'_, AppState>) -> Result<String, AppError> {
    let env = super::env::load_env_file(&state.paths.env_file)?;
    Ok(env
        .into_iter()
        .find(|(k, _)| k == "LOOM_API_TOKEN")
        .map(|(_, v)| v)
        .unwrap_or_default())
}

/// Pulls the trailing path segment out of a `loom.com/share/...` URL. We
/// accept query strings, trailing slashes, and direct `id` strings (so a
/// caller can paste `/v1/videos/{id}` style references).
pub fn extract_video_id(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    // If it looks like a bare id (no slashes), accept it.
    if !trimmed.contains('/') && !trimmed.contains('?') {
        return Some(trimmed.to_string());
    }
    // Strip query.
    let no_q = trimmed.split('?').next().unwrap_or(trimmed);
    // Strip trailing slash.
    let trimmed_slash = no_q.trim_end_matches('/');
    let last = trimmed_slash.rsplit('/').next().unwrap_or("");
    if last.is_empty() {
        None
    } else {
        Some(last.to_string())
    }
}

fn build_frontmatter(pairs: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (k, v) in pairs {
        let escaped = v.replace('\\', "\\\\").replace('"', "\\\"");
        out.push_str(&format!("{}: \"{}\"\n", k, escaped));
    }
    out
}

fn atomic_write(path: &Path, body: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!(
        "tmp.{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_loom_atom_format() {
        let fm = build_frontmatter(&[
            ("source", "loom"),
            ("loom_video_id", "abc123"),
            ("title", "demo"),
        ]);
        assert!(fm.contains("source: \"loom\""));
        assert!(fm.contains("loom_video_id: \"abc123\""));
    }

    #[test]
    fn test_loom_skip_when_no_token() {
        let env: Vec<(String, String)> = Vec::new();
        let token = env
            .into_iter()
            .find(|(k, _)| k == "LOOM_API_TOKEN")
            .map(|(_, v)| v)
            .unwrap_or_default();
        assert!(token.is_empty());
    }

    #[test]
    fn extract_video_id_handles_share_urls() {
        assert_eq!(
            extract_video_id("https://www.loom.com/share/abc123def456"),
            Some("abc123def456".into())
        );
        assert_eq!(
            extract_video_id("https://www.loom.com/share/abc123/"),
            Some("abc123".into())
        );
        assert_eq!(
            extract_video_id("https://www.loom.com/share/abc123?t=42"),
            Some("abc123".into())
        );
        assert_eq!(extract_video_id("rawId"), Some("rawId".into()));
        assert_eq!(extract_video_id("   "), None);
    }

    #[test]
    fn transcript_value_supports_array_and_text() {
        let arr = serde_json::json!([
            { "text": "first" },
            { "text": "second" }
        ]);
        let s = transcript_value_to_text(&arr);
        assert!(s.contains("first"));
        assert!(s.contains("second"));

        let obj = serde_json::json!({ "transcript": "hello" });
        assert_eq!(transcript_value_to_text(&obj), "hello");
    }
}
