//! v1.8 Phase 2-D — Voice notes source.
//!
//! In-app recorder pipeline:
//!
//!   1. React side opens `getUserMedia({audio: true})`, records via the
//!      `MediaRecorder` Web API (default container — webm/opus on Chromium,
//!      audio/wav on the Tauri webview when configured), then base64-encodes
//!      the resulting Blob.
//!   2. Frontend invokes `voice_notes_record_and_transcribe(audio_b64,
//!      mime_type)`.
//!   3. We decode → write a temp file → invoke the bundled
//!      `python -m tmi.transcribe --audio <tmp> --model-dir <dir>` (the
//!      same path the Discord meeting flow uses for chunk transcription).
//!   4. Parse the transcription JSON, write an atom to
//!      `~/.tangerine-memory/threads/voice/{YYYY-MM-DD-HHMM}.md`.
//!
//! Whisper reuse: we deliberately do NOT add a new transcription dependency.
//! The meeting flow already spawns `python -m tmi.transcribe`; we reuse it
//! verbatim. The temp file lives in the system temp dir and is deleted on
//! success (best-effort on failure — the OS cleans tmp on reboot).
//!
//! Format detection: ffmpeg-style transcoding would be heavy. Instead, when
//! the incoming MIME is `audio/wav` we forward the bytes as-is; for any
//! other MIME (webm/opus, mp4/m4a) we still hand the bytes off to Whisper —
//! `faster-whisper` (via `pyav`) accepts most container formats on the
//! Python side. The `.bin` extension keeps Whisper's auto-detect happy
//! without forcing us to maintain a MIME → extension mapping.
//!
//! Filename collision: when two recordings finish in the same minute, the
//! second gets a `-2`, `-3`, ... suffix. We never overwrite an existing
//! atom (the user might be mid-edit). Tested in
//! `test_voice_filename_collision`.

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::{AppError, AppState};

// ---------------------------------------------------------------------------
// Atom shape

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VoiceAtom {
    pub recorded_at: String,
    pub duration_sec: f32,
    pub transcript: String,
    pub source: String,
    pub mime_type: String,
    /// Path to the resulting markdown file on disk. Returned to the
    /// frontend so the recorder can navigate straight to it.
    pub file_path: String,
}

/// Build the markdown body for a voice note atom. Pure function — tests
/// assert on the shape directly.
pub fn build_voice_atom(
    recorded_at: &DateTime<Utc>,
    duration_sec: f32,
    transcript: &str,
    mime_type: &str,
) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str("source: voice-notes\n");
    out.push_str(&format!("recorded_at: {}\n", recorded_at.to_rfc3339()));
    out.push_str(&format!("duration_sec: {:.1}\n", duration_sec));
    out.push_str(&format!("mime_type: {}\n", yaml_scalar(mime_type)));
    out.push_str("---\n\n");
    out.push_str("# Voice note\n\n");
    let trimmed = transcript.trim();
    if trimmed.is_empty() {
        out.push_str("_(empty transcript — Whisper returned no text)_\n");
    } else {
        out.push_str(trimmed);
        out.push_str("\n");
    }
    out
}

fn yaml_scalar(s: &str) -> String {
    let needs_quote = s.is_empty() || s.contains(':') || s.contains('#') || s.contains('\n');
    if needs_quote {
        let escaped = s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
        format!("\"{}\"", escaped)
    } else {
        s.to_string()
    }
}

// ---------------------------------------------------------------------------
// Filename + path helpers

/// `<memory_root>/threads/voice/`. Created on demand.
pub fn voice_threads_dir(memory_root: &Path) -> PathBuf {
    memory_root.join("threads").join("voice")
}

/// `{YYYY-MM-DD-HHMM}` — the user's local time. We deliberately skip
/// seconds so back-to-back recordings collide under the same minute key
/// and exercise the suffix codepath.
pub fn timestamp_slug(local: &DateTime<Local>) -> String {
    local.format("%Y-%m-%d-%H%M").to_string()
}

/// Resolve the next non-conflicting path under the voice dir. Tries
/// `{slug}.md` first, then `{slug}-2.md`, `{slug}-3.md`, ... up to a
/// safety cap of 100 (well past any reasonable burst).
pub fn next_voice_path(dir: &Path, slug: &str) -> PathBuf {
    let primary = dir.join(format!("{}.md", slug));
    if !primary.exists() {
        return primary;
    }
    for n in 2..=100 {
        let candidate = dir.join(format!("{}-{}.md", slug, n));
        if !candidate.exists() {
            return candidate;
        }
    }
    // Fallback — random suffix. Avoids ever returning a path that exists.
    dir.join(format!(
        "{}-{}.md",
        slug,
        uuid::Uuid::new_v4().simple()
    ))
}

// ---------------------------------------------------------------------------
// Default memory root

fn default_memory_root() -> Result<PathBuf, AppError> {
    dirs::home_dir()
        .map(|h| h.join(".tangerine-memory"))
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))
}

// ---------------------------------------------------------------------------
// Whisper invocation — reuses the meeting flow's `python -m tmi.transcribe`.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone)]
struct WhisperCallSpec {
    python: PathBuf,
    model_dir: PathBuf,
}

fn resolve_whisper_call(state: &State<'_, AppState>) -> Result<WhisperCallSpec, AppError> {
    let python = state.paths.python_exe.clone();
    if !python.is_file() {
        return Err(AppError::config(
            "python_missing",
            format!(
                "bundled python not found at {} — run scripts/build_python.ps1",
                python.display()
            ),
        ));
    }
    // Same model dir convention as `commands::whisper_model::model_dir`. We
    // duplicate the path build here rather than make `model_dir` public so
    // the cross-module surface stays tight.
    let model_dir = state
        .paths
        .user_data
        .join("models")
        .join("faster-whisper-small-int8");
    if !model_dir.is_dir() || !model_dir.join("model.bin").is_file() {
        return Err(AppError::config(
            "whisper_model_missing",
            "faster-whisper small model not downloaded — visit /sources/discord and click 'Download model'",
        ));
    }
    Ok(WhisperCallSpec { python, model_dir })
}

/// Spawn `<python> -m tmi.transcribe --audio <wav> --model-dir <dir>` and
/// parse the JSON it prints to stdout. Returns `(transcript_text,
/// duration_sec)` — duration is taken from the last segment's `end` field
/// when present, falling back to 0.0 for empty audio.
async fn transcribe_via_python(
    spec: &WhisperCallSpec,
    audio_path: &Path,
) -> Result<(String, f32), AppError> {
    let python = spec.python.clone();
    let model_dir = spec.model_dir.clone();
    let audio_path = audio_path.to_path_buf();
    let join = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&python);
        cmd.arg("-m")
            .arg("tmi.transcribe")
            .arg("--audio")
            .arg(&audio_path)
            .arg("--model-dir")
            .arg(&model_dir);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.output()
            .map_err(|e| format!("python spawn: {e}"))
    })
    .await
    .map_err(|e| AppError::internal("whisper_join", e.to_string()))?;
    let out = join.map_err(|e| AppError::external("whisper_spawn", e))?;
    if !out.status.success() {
        let code = out.status.code().unwrap_or(-1);
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        return Err(AppError::external(
            "whisper_exit",
            format!("python -m tmi.transcribe exit {}: {}", code, stderr),
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| AppError::external("whisper_parse", format!("{e}: stdout={stdout}")))?;
    let text = parsed
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let duration = parsed
        .get("segments")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.last())
        .and_then(|seg| seg.get("end"))
        .and_then(|e| e.as_f64())
        .unwrap_or(0.0) as f32;
    Ok((text, duration))
}

// ---------------------------------------------------------------------------
// Public Tauri commands

#[derive(Debug, Deserialize)]
pub struct VoiceRecordArgs {
    /// Base64-encoded audio blob captured by the React MediaRecorder.
    pub audio_b64: String,
    /// MIME type the browser reported. `audio/webm`, `audio/wav`, etc.
    pub mime_type: String,
}

/// Decode the base64 blob, run Whisper, write the atom. Returns the atom
/// (frontmatter fields + file path) so the frontend can navigate to it.
#[tauri::command(rename_all = "snake_case")]
pub async fn voice_notes_record_and_transcribe(
    state: State<'_, AppState>,
    args: VoiceRecordArgs,
) -> Result<VoiceAtom, AppError> {
    if args.audio_b64.is_empty() {
        return Err(AppError::user("empty_audio", "audio_b64 is empty"));
    }
    let bytes = B64
        .decode(args.audio_b64.as_bytes())
        .map_err(|e| AppError::user("audio_b64_decode", e.to_string()))?;
    if bytes.is_empty() {
        return Err(AppError::user("empty_audio_decoded", "decoded audio is empty"));
    }
    // 25 MB hard cap — well above a 10-min webm/opus capture.
    if bytes.len() > 25 * 1024 * 1024 {
        return Err(AppError::user(
            "audio_too_large",
            format!("audio blob is {} bytes; max 25 MB", bytes.len()),
        ));
    }
    let spec = resolve_whisper_call(&state)?;

    // Write to a temp file. Whisper handles WAV/OPUS/M4A natively via
    // pyav so we don't need to transcode — just hand the raw bytes to it.
    let tmp_path = state
        .paths
        .user_data
        .join("tmp")
        .join(format!("voice-{}.bin", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(tmp_path.parent().unwrap())
        .map_err(|e| AppError::internal("voice_tmpdir", e.to_string()))?;
    std::fs::write(&tmp_path, &bytes)
        .map_err(|e| AppError::internal("voice_tmp_write", e.to_string()))?;

    // Transcribe. On error, clean the tmp file and propagate.
    let result = transcribe_via_python(&spec, &tmp_path).await;
    let _ = std::fs::remove_file(&tmp_path);
    let (transcript, duration) = result?;

    // Build the atom.
    let now_utc = Utc::now();
    let now_local: DateTime<Local> = DateTime::from(now_utc);
    let body = build_voice_atom(&now_utc, duration, &transcript, &args.mime_type);
    let memory_root = default_memory_root()?;
    let dir = voice_threads_dir(&memory_root);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal("voice_dir", e.to_string()))?;
    let path = next_voice_path(&dir, &timestamp_slug(&now_local));
    atomic_write(&path, &body)?;

    Ok(VoiceAtom {
        recorded_at: now_utc.to_rfc3339(),
        duration_sec: duration,
        transcript,
        source: "voice-notes".into(),
        mime_type: args.mime_type,
        file_path: path.to_string_lossy().to_string(),
    })
}

#[derive(Debug, Serialize)]
pub struct VoiceListItem {
    pub slug: String,
    pub recorded_at: String,
    pub duration_sec: f32,
    pub path: String,
}

/// Return the most recent 20 voice notes (by filename desc, since the
/// timestamp is baked into the slug and lexicographic sort matches
/// chronological order on YYYY-MM-DD-HHMM).
#[tauri::command(rename_all = "snake_case")]
pub async fn voice_notes_list_recent(
    _state: State<'_, AppState>,
) -> Result<Vec<VoiceListItem>, AppError> {
    let memory_root = default_memory_root()?;
    let dir = voice_threads_dir(&memory_root);
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut rows: Vec<VoiceListItem> = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| AppError::internal("voice_list_read", e.to_string()))?
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let slug = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let (recorded_at, duration_sec) = parse_voice_frontmatter(&raw);
        rows.push(VoiceListItem {
            slug,
            recorded_at,
            duration_sec,
            path: path.to_string_lossy().to_string(),
        });
    }
    rows.sort_by(|a, b| b.slug.cmp(&a.slug));
    rows.truncate(20);
    Ok(rows)
}

/// Quick-and-dirty frontmatter peek: pull `recorded_at` and `duration_sec`.
fn parse_voice_frontmatter(raw: &str) -> (String, f32) {
    let mut recorded_at = String::new();
    let mut duration: f32 = 0.0;
    let mut in_block = false;
    for line in raw.lines() {
        if line.trim() == "---" {
            in_block = !in_block;
            if !in_block {
                break;
            }
            continue;
        }
        if !in_block {
            continue;
        }
        if let Some(rest) = line.trim_start().strip_prefix("recorded_at:") {
            recorded_at = rest.trim().trim_matches('"').to_string();
        } else if let Some(rest) = line.trim_start().strip_prefix("duration_sec:") {
            duration = rest.trim().parse::<f32>().unwrap_or(0.0);
        }
    }
    (recorded_at, duration)
}

// ---------------------------------------------------------------------------
// Atomic write — same pattern as views::atomic_write.

fn atomic_write(path: &Path, body: &str) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let tmp = path.with_extension(format!("tmp.{}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&tmp, body)
        .map_err(|e| AppError::internal("voice_atomic_write", format!("write: {e}")))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::internal("voice_atomic_write", format!("rename: {e}")))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_voice_atom_format() {
        // Locked frontmatter shape. The daemon and the React reader rely
        // on these exact key names and order.
        let ts = Utc.with_ymd_and_hms(2026, 4, 26, 13, 42, 7).unwrap();
        let body = build_voice_atom(&ts, 7.5, "Hello world.", "audio/webm");
        assert!(body.starts_with("---\n"));
        assert!(body.contains("source: voice-notes\n"));
        assert!(body.contains("recorded_at: 2026-04-26T13:42:07+00:00\n"));
        assert!(body.contains("duration_sec: 7.5\n"));
        assert!(body.contains("mime_type: audio/webm\n"));
        assert!(body.contains("---\n\n# Voice note\n\nHello world.\n"));
    }

    #[test]
    fn test_voice_atom_handles_empty_transcript() {
        let ts = Utc.with_ymd_and_hms(2026, 4, 26, 13, 42, 7).unwrap();
        let body = build_voice_atom(&ts, 1.0, "   ", "audio/wav");
        assert!(body.contains("(empty transcript"));
    }

    #[test]
    fn test_voice_filename_collision() {
        // Recording two voice notes in the same minute should produce
        // distinct filenames via the `-2`, `-3` suffix.
        let tmp = std::env::temp_dir().join(format!(
            "tmi_voice_collision_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let slug = "2026-04-26-1342";
        let p1 = next_voice_path(&tmp, slug);
        std::fs::write(&p1, "first\n").unwrap();
        let p2 = next_voice_path(&tmp, slug);
        std::fs::write(&p2, "second\n").unwrap();
        let p3 = next_voice_path(&tmp, slug);
        assert_ne!(p1, p2);
        assert_ne!(p2, p3);
        assert_eq!(p1.file_name().unwrap(), "2026-04-26-1342.md");
        assert_eq!(p2.file_name().unwrap(), "2026-04-26-1342-2.md");
        assert_eq!(p3.file_name().unwrap(), "2026-04-26-1342-3.md");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn timestamp_slug_includes_minute() {
        let dt = Local
            .with_ymd_and_hms(2026, 4, 26, 13, 42, 7)
            .unwrap();
        assert_eq!(timestamp_slug(&dt), "2026-04-26-1342");
    }

    #[test]
    fn parse_voice_frontmatter_pulls_fields() {
        let raw = "---\n\
source: voice-notes\n\
recorded_at: 2026-04-26T13:42:07+00:00\n\
duration_sec: 12.3\n\
mime_type: audio/webm\n\
---\n\nbody\n";
        let (ts, dur) = parse_voice_frontmatter(raw);
        assert_eq!(ts, "2026-04-26T13:42:07+00:00");
        assert!((dur - 12.3).abs() < 0.001);
    }

    #[test]
    fn yaml_scalar_quotes_when_needed() {
        assert_eq!(yaml_scalar("plain"), "plain");
        assert_eq!(yaml_scalar("audio/webm"), "audio/webm");
        assert_eq!(yaml_scalar(""), "\"\"");
        assert_eq!(yaml_scalar("a:b"), "\"a:b\"");
    }
}
