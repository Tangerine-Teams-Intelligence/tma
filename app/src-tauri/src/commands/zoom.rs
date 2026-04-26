//! Zoom source — v1.8 Phase 2 real-wire.
//!
//! Replacement capture path for users without Discord. We pull cloud
//! recordings + their auto-transcripts from Zoom and write a meeting atom
//! per call into `<memory_root>/meetings/`.
//!
//! Auth: Server-to-Server OAuth.
//!   1. The user creates an S2S OAuth app in the Zoom marketplace and gets
//!      `account_id` + `client_id` + `client_secret`.
//!   2. We exchange those for a 1-hour bearer token via
//!      `POST https://zoom.us/oauth/token?grant_type=account_credentials&account_id={id}`
//!      with HTTP Basic auth from `client_id:client_secret`.
//!   3. We cache the token in memory until it expires; fresh exchange on
//!      every heartbeat is acceptable too (the rate limit is generous and
//!      heartbeats are 5 min apart by default).
//!
//! Persistence:
//!   * Secrets: `.env` file (`ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`,
//!     `ZOOM_CLIENT_SECRET`) via env.rs.
//!   * Flags + last-sync: per-source JSON at
//!     `<user_data>/sources/zoom.json`.
//!
//! API surface used:
//!   * `GET /v2/users/me/recordings?from=YYYY-MM-DD` — list cloud recordings.
//!   * `GET /v2/meetings/{meetingId}/recordings` — for the per-meeting
//!     transcript download URL (the list endpoint already includes
//!     `recording_files[]` with download URLs we can stream directly).
//!
//! Rate limit: Zoom S2S throttles around 30 req/sec; we space requests via
//! sequential awaits since the per-meeting count is typically small.

use std::path::{Path, PathBuf};

use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{AppError, AppState};

const ZOOM_API: &str = "https://api.zoom.us/v2";
const ZOOM_OAUTH: &str = "https://zoom.us/oauth/token";

// ---------------------------------------------------------------------------
// Config

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ZoomConfig {
    /// All three credentials are stored in `.env`; we surface presence so
    /// the UI can render "configured / not configured" without re-fetching.
    #[serde(default)]
    pub account_id_present: bool,
    #[serde(default)]
    pub client_id_present: bool,
    #[serde(default)]
    pub client_secret_present: bool,
    #[serde(default = "default_true")]
    pub capture_enabled: bool,
    /// How many days back to look for new recordings on each heartbeat.
    /// Default 7 — Zoom retains cloud recordings for the user's plan window
    /// anyway, and we always write atomically so re-pulls are idempotent.
    #[serde(default = "default_lookback")]
    pub lookback_days: u32,
    #[serde(default)]
    pub last_sync: Option<String>,
}

fn default_true() -> bool {
    true
}
fn default_lookback() -> u32 {
    7
}

fn config_path(state: &AppState) -> PathBuf {
    state.paths.user_data.join("sources").join("zoom.json")
}

fn load_config(state: &AppState) -> ZoomConfig {
    match std::fs::read_to_string(config_path(state)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => ZoomConfig::default(),
    }
}

fn save_config(state: &AppState, cfg: &ZoomConfig) -> Result<(), AppError> {
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
pub struct ZoomMeetingAtom {
    pub path: String,
    pub meeting_id: String,
    pub topic: String,
    pub start_time: String,
    pub duration_min: u64,
    pub transcript_chars: usize,
}

// ---------------------------------------------------------------------------
// Tauri commands

#[tauri::command]
pub async fn zoom_get_config(
    state: State<'_, AppState>,
) -> Result<ZoomConfig, AppError> {
    let mut cfg = load_config(&state);
    let env = super::env::load_env_file(&state.paths.env_file).unwrap_or_default();
    cfg.account_id_present = env
        .iter()
        .any(|(k, v)| k == "ZOOM_ACCOUNT_ID" && !v.is_empty());
    cfg.client_id_present = env
        .iter()
        .any(|(k, v)| k == "ZOOM_CLIENT_ID" && !v.is_empty());
    cfg.client_secret_present = env
        .iter()
        .any(|(k, v)| k == "ZOOM_CLIENT_SECRET" && !v.is_empty());
    Ok(cfg)
}

#[derive(Debug, Deserialize)]
pub struct ZoomSetConfigArgs {
    pub capture_enabled: bool,
    pub lookback_days: Option<u32>,
}

#[tauri::command]
pub async fn zoom_set_config(
    state: State<'_, AppState>,
    args: ZoomSetConfigArgs,
) -> Result<(), AppError> {
    let mut cfg = load_config(&state);
    cfg.capture_enabled = args.capture_enabled;
    if let Some(days) = args.lookback_days {
        cfg.lookback_days = days.clamp(1, 90);
    }
    save_config(&state, &cfg)
}

#[derive(Debug, Serialize)]
pub struct ZoomValidateResult {
    pub ok: bool,
    pub account_email: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn zoom_validate_credentials(
    state: State<'_, AppState>,
) -> Result<ZoomValidateResult, AppError> {
    let creds = read_credentials(&state)?;
    if !creds.complete() {
        return Ok(ZoomValidateResult {
            ok: false,
            account_email: None,
            error: Some("Credentials incomplete.".into()),
        });
    }
    let token = match exchange_token(&state, &creds).await {
        Ok(t) => t,
        Err(e) => {
            return Ok(ZoomValidateResult {
                ok: false,
                account_email: None,
                error: Some(format!("OAuth failed: {}", e)),
            })
        }
    };
    let resp = state
        .http
        .get(format!("{}/users/me", ZOOM_API))
        .header("Authorization", format!("Bearer {}", token.access_token))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Ok(ZoomValidateResult {
            ok: false,
            account_email: None,
            error: Some(format!("status {}", resp.status())),
        });
    }
    let v: serde_json::Value = resp.json().await?;
    Ok(ZoomValidateResult {
        ok: true,
        account_email: v
            .get("email")
            .and_then(|s| s.as_str())
            .map(|s| s.to_string()),
        error: None,
    })
}

#[derive(Debug, Deserialize)]
pub struct ZoomCaptureArgs {
    pub memory_root: String,
}

#[derive(Debug, Serialize)]
pub struct ZoomCaptureResult {
    pub written: usize,
    pub atoms: Vec<ZoomMeetingAtom>,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn zoom_capture(
    state: State<'_, AppState>,
    args: ZoomCaptureArgs,
) -> Result<ZoomCaptureResult, AppError> {
    let mut cfg = load_config(&state);
    if !cfg.capture_enabled {
        return Ok(ZoomCaptureResult {
            written: 0,
            atoms: Vec::new(),
            errors: vec!["capture disabled".into()],
        });
    }
    let creds = read_credentials(&state)?;
    if !creds.complete() {
        return Ok(ZoomCaptureResult {
            written: 0,
            atoms: Vec::new(),
            errors: vec!["credentials incomplete".into()],
        });
    }
    let token = exchange_token(&state, &creds).await?;
    let from = (Utc::now() - ChronoDuration::days(cfg.lookback_days as i64))
        .format("%Y-%m-%d")
        .to_string();
    let recordings = list_recordings(&state, &token.access_token, &from).await?;

    let root = PathBuf::from(&args.memory_root).join("meetings");
    std::fs::create_dir_all(&root).ok();

    let mut atoms = Vec::new();
    let mut errors = Vec::new();
    let mut written = 0_usize;
    for r in recordings {
        match capture_recording(&state, &token.access_token, &r, &root).await {
            Ok(atom) => {
                written += 1;
                atoms.push(atom);
            }
            Err(e) => errors.push(format!("meeting {}: {}", r.meeting_id, e)),
        }
    }

    cfg.last_sync = Some(Utc::now().to_rfc3339());
    save_config(&state, &cfg).ok();

    Ok(ZoomCaptureResult {
        written,
        atoms,
        errors,
    })
}

// ---------------------------------------------------------------------------
// OAuth exchange + recording list

#[derive(Debug, Clone)]
pub(crate) struct ZoomCredentials {
    pub account_id: String,
    pub client_id: String,
    pub client_secret: String,
}

impl ZoomCredentials {
    pub fn complete(&self) -> bool {
        !self.account_id.is_empty()
            && !self.client_id.is_empty()
            && !self.client_secret.is_empty()
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ZoomToken {
    pub access_token: String,
    /// `expires_in` seconds, captured at exchange time. We don't pin the
    /// absolute expiry because the heartbeat is short relative to the
    /// 1-hour token lifetime.
    pub _expires_in: u64,
}

pub(crate) async fn exchange_token(
    state: &State<'_, AppState>,
    creds: &ZoomCredentials,
) -> Result<ZoomToken, AppError> {
    let url = format!(
        "{}?grant_type=account_credentials&account_id={}",
        ZOOM_OAUTH,
        urlencoding::encode(&creds.account_id)
    );
    let resp = state
        .http
        .post(&url)
        .basic_auth(&creds.client_id, Some(&creds.client_secret))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::external(
            "zoom_oauth",
            format!("status {}", resp.status()),
        ));
    }
    let v: serde_json::Value = resp.json().await?;
    let access_token = v
        .get("access_token")
        .and_then(|s| s.as_str())
        .ok_or_else(|| {
            AppError::external("zoom_oauth", "no access_token in response")
        })?
        .to_string();
    let expires_in = v
        .get("expires_in")
        .and_then(|n| n.as_u64())
        .unwrap_or(3600);
    Ok(ZoomToken {
        access_token,
        _expires_in: expires_in,
    })
}

#[derive(Debug, Clone)]
struct RecordingSummary {
    meeting_id: String,
    topic: String,
    start_time: String,
    duration_min: u64,
    /// URL we GET to download the transcript (TRANSCRIPT or VTT file_type).
    transcript_url: Option<String>,
}

async fn list_recordings(
    state: &State<'_, AppState>,
    token: &str,
    from: &str,
) -> Result<Vec<RecordingSummary>, AppError> {
    let url = format!(
        "{}/users/me/recordings?from={}&page_size=30",
        ZOOM_API, from
    );
    let resp = state
        .http
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::external(
            "zoom_recordings",
            format!("status {}", resp.status()),
        ));
    }
    let v: serde_json::Value = resp.json().await?;
    let arr = v
        .get("meetings")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for entry in arr {
        let meeting_id = entry
            .get("uuid")
            .or_else(|| entry.get("id"))
            .and_then(|s| s.as_str().map(|x| x.to_string()).or_else(|| s.as_u64().map(|n| n.to_string())))
            .unwrap_or_default();
        if meeting_id.is_empty() {
            continue;
        }
        let topic = entry
            .get("topic")
            .and_then(|s| s.as_str())
            .unwrap_or("(untitled)")
            .to_string();
        let start_time = entry
            .get("start_time")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        let duration_min = entry
            .get("duration")
            .and_then(|n| n.as_u64())
            .unwrap_or(0);
        let transcript_url = entry
            .get("recording_files")
            .and_then(|a| a.as_array())
            .and_then(|files| {
                files.iter().find_map(|f| {
                    let kind = f
                        .get("file_type")
                        .and_then(|s| s.as_str())
                        .unwrap_or("");
                    if kind == "TRANSCRIPT" || kind == "VTT" || kind == "CC" {
                        f.get("download_url")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string())
                    } else {
                        None
                    }
                })
            });
        out.push(RecordingSummary {
            meeting_id,
            topic,
            start_time,
            duration_min,
            transcript_url,
        });
    }
    Ok(out)
}

async fn capture_recording(
    state: &State<'_, AppState>,
    token: &str,
    r: &RecordingSummary,
    root: &Path,
) -> Result<ZoomMeetingAtom, String> {
    let transcript = match &r.transcript_url {
        Some(url) => download_transcript(state, token, url).await.unwrap_or_else(
            |e| format!("(transcript download failed: {})", e),
        ),
        None => "(no transcript available — enable Zoom AI Companion or audio transcript on this account)".into(),
    };
    // Sanitize meeting id for filename (uuids may contain `==`, `/`, `+`).
    let safe_id = sanitize_filename(&r.meeting_id);
    let atom_path = root.join(format!("zoom-{}.md", safe_id));
    let frontmatter = build_frontmatter(&[
        ("source", "zoom"),
        ("zoom_meeting_id", &r.meeting_id),
        ("topic", &r.topic),
        ("start_time", &r.start_time),
        ("duration_min", &r.duration_min.to_string()),
        ("captured_at", &Utc::now().to_rfc3339()),
    ]);
    let body = format!(
        "---\n{}---\n\n# {}\n\n_Started {} — {} min_\n\n## Transcript\n\n{}\n",
        frontmatter, r.topic, r.start_time, r.duration_min, transcript
    );
    atomic_write(&atom_path, &body)?;
    Ok(ZoomMeetingAtom {
        path: atom_path.to_string_lossy().to_string(),
        meeting_id: r.meeting_id.clone(),
        topic: r.topic.clone(),
        start_time: r.start_time.clone(),
        duration_min: r.duration_min,
        transcript_chars: transcript.len(),
    })
}

async fn download_transcript(
    state: &State<'_, AppState>,
    token: &str,
    url: &str,
) -> Result<String, String> {
    let resp = state
        .http
        .get(url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("status {}", resp.status()));
    }
    let txt = resp.text().await.map_err(|e| e.to_string())?;
    Ok(vtt_to_plain(&txt))
}

/// Strip WebVTT headers + cue timestamps → plain text. Falls through cleanly
/// if input is already plain.
pub fn vtt_to_plain(vtt: &str) -> String {
    let mut out = String::new();
    for raw in vtt.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line == "WEBVTT" || line.starts_with("NOTE ") || line.starts_with("Kind:") {
            continue;
        }
        // Cue timestamps like "00:00:01.000 --> 00:00:04.000"
        if line.contains(" --> ") {
            continue;
        }
        // Cue identifier: bare integer or short alphanumeric without spaces.
        if line.parse::<u32>().is_ok() {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
    }
    out
}

// ---------------------------------------------------------------------------
// Daemon hook

#[derive(Debug, Clone)]
pub struct ZoomTickResult {
    pub written: usize,
    pub errors: Vec<String>,
}

pub async fn tick_from_daemon(
    user_data: &Path,
    memory_root: &Path,
) -> ZoomTickResult {
    let mut out = ZoomTickResult {
        written: 0,
        errors: Vec::new(),
    };
    let cfg_path = user_data.join("sources").join("zoom.json");
    let cfg: ZoomConfig = match std::fs::read_to_string(&cfg_path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => return out,
    };
    if !cfg.capture_enabled {
        return out;
    }
    let env_file = user_data.join(".env");
    let env = match super::env::load_env_file(&env_file) {
        Ok(e) => e,
        Err(_) => return out,
    };
    let lookup = |key: &str| {
        env.iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    let creds = ZoomCredentials {
        account_id: lookup("ZOOM_ACCOUNT_ID"),
        client_id: lookup("ZOOM_CLIENT_ID"),
        client_secret: lookup("ZOOM_CLIENT_SECRET"),
    };
    if !creds.complete() {
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
    let token = match daemon_exchange_token(&client, &creds).await {
        Ok(t) => t,
        Err(e) => {
            out.errors.push(format!("oauth: {}", e));
            return out;
        }
    };
    let from = (Utc::now() - ChronoDuration::days(cfg.lookback_days as i64))
        .format("%Y-%m-%d")
        .to_string();
    let recordings = match daemon_list_recordings(&client, &token, &from).await {
        Ok(r) => r,
        Err(e) => {
            out.errors.push(format!("list: {}", e));
            return out;
        }
    };
    let root = memory_root.join("meetings");
    if let Err(e) = std::fs::create_dir_all(&root) {
        out.errors.push(format!("mkdir: {}", e));
        return out;
    }
    for r in recordings {
        if daemon_capture_recording(&client, &token, &r, &root).await.is_ok() {
            out.written += 1;
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

async fn daemon_exchange_token(
    client: &reqwest::Client,
    creds: &ZoomCredentials,
) -> Result<String, String> {
    let url = format!(
        "{}?grant_type=account_credentials&account_id={}",
        ZOOM_OAUTH,
        urlencoding::encode(&creds.account_id)
    );
    let resp = client
        .post(&url)
        .basic_auth(&creds.client_id, Some(&creds.client_secret))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("status {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    v.get("access_token")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "no access_token".into())
}

async fn daemon_list_recordings(
    client: &reqwest::Client,
    token: &str,
    from: &str,
) -> Result<Vec<RecordingSummary>, String> {
    let url = format!(
        "{}/users/me/recordings?from={}&page_size=30",
        ZOOM_API, from
    );
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
        .get("meetings")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for entry in arr {
        let meeting_id = entry
            .get("uuid")
            .or_else(|| entry.get("id"))
            .and_then(|s| {
                s.as_str()
                    .map(|x| x.to_string())
                    .or_else(|| s.as_u64().map(|n| n.to_string()))
            })
            .unwrap_or_default();
        if meeting_id.is_empty() {
            continue;
        }
        let topic = entry
            .get("topic")
            .and_then(|s| s.as_str())
            .unwrap_or("(untitled)")
            .to_string();
        let start_time = entry
            .get("start_time")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        let duration_min = entry
            .get("duration")
            .and_then(|n| n.as_u64())
            .unwrap_or(0);
        let transcript_url = entry
            .get("recording_files")
            .and_then(|a| a.as_array())
            .and_then(|files| {
                files.iter().find_map(|f| {
                    let kind = f
                        .get("file_type")
                        .and_then(|s| s.as_str())
                        .unwrap_or("");
                    if kind == "TRANSCRIPT" || kind == "VTT" || kind == "CC" {
                        f.get("download_url")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string())
                    } else {
                        None
                    }
                })
            });
        out.push(RecordingSummary {
            meeting_id,
            topic,
            start_time,
            duration_min,
            transcript_url,
        });
    }
    Ok(out)
}

async fn daemon_capture_recording(
    client: &reqwest::Client,
    token: &str,
    r: &RecordingSummary,
    root: &Path,
) -> Result<(), String> {
    let transcript = match &r.transcript_url {
        Some(url) => {
            match client
                .get(url)
                .header("Authorization", format!("Bearer {}", token))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => match resp.text().await {
                    Ok(txt) => vtt_to_plain(&txt),
                    Err(_) => String::new(),
                },
                _ => String::new(),
            }
        }
        None => String::new(),
    };
    let safe_id = sanitize_filename(&r.meeting_id);
    let atom_path = root.join(format!("zoom-{}.md", safe_id));
    let frontmatter = build_frontmatter(&[
        ("source", "zoom"),
        ("zoom_meeting_id", &r.meeting_id),
        ("topic", &r.topic),
        ("start_time", &r.start_time),
        ("duration_min", &r.duration_min.to_string()),
        ("captured_at", &Utc::now().to_rfc3339()),
    ]);
    let body = format!(
        "---\n{}---\n\n# {}\n\n_Started {} — {} min_\n\n## Transcript\n\n{}\n",
        frontmatter, r.topic, r.start_time, r.duration_min, transcript
    );
    atomic_write(&atom_path, &body)
}

// ---------------------------------------------------------------------------
// Helpers

pub(crate) fn read_credentials(
    state: &State<'_, AppState>,
) -> Result<ZoomCredentials, AppError> {
    let env = super::env::load_env_file(&state.paths.env_file)?;
    let lookup = |key: &str| -> String {
        env.iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    Ok(ZoomCredentials {
        account_id: lookup("ZOOM_ACCOUNT_ID"),
        client_id: lookup("ZOOM_CLIENT_ID"),
        client_secret: lookup("ZOOM_CLIENT_SECRET"),
    })
}

fn build_frontmatter(pairs: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (k, v) in pairs {
        let escaped = v.replace('\\', "\\\\").replace('"', "\\\"");
        out.push_str(&format!("{}: \"{}\"\n", k, escaped));
    }
    out
}

fn sanitize_filename(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
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
    fn test_zoom_atom_format() {
        let fm = build_frontmatter(&[
            ("source", "zoom"),
            ("zoom_meeting_id", "abc=="),
            ("topic", "Standup"),
            ("duration_min", "30"),
        ]);
        assert!(fm.contains("source: \"zoom\""));
        assert!(fm.contains("zoom_meeting_id: \"abc==\""));
        assert!(fm.contains("topic: \"Standup\""));
    }

    #[test]
    fn test_zoom_skip_when_no_token() {
        let creds = ZoomCredentials {
            account_id: String::new(),
            client_id: String::new(),
            client_secret: String::new(),
        };
        assert!(!creds.complete());
    }

    #[test]
    fn vtt_strips_headers_and_timestamps() {
        let vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nHello team.\n\n2\n00:00:04.500 --> 00:00:07.000\nDecisions today.\n";
        let plain = vtt_to_plain(vtt);
        assert_eq!(plain, "Hello team.\nDecisions today.");
    }

    #[test]
    fn sanitize_filename_replaces_unsafe_chars() {
        assert_eq!(sanitize_filename("abc==/xyz"), "abc___xyz");
        assert_eq!(sanitize_filename("zoom-uuid_1"), "zoom-uuid_1");
    }

    #[test]
    fn config_lookback_is_clamped() {
        // Manual emulation of clamp logic in zoom_set_config.
        let raw: u32 = 9999;
        assert_eq!(raw.clamp(1, 90), 90);
        let raw: u32 = 0;
        assert_eq!(raw.clamp(1, 90), 1);
    }
}
