//! v3.0 §2.4 — YouTube transcript capture.
//!
//! User flow:
//!   1. User pastes a YouTube URL into Settings → External → "Capture YouTube"
//!      (or via the `tangerine://capture/youtube?url=...` deep link, handled
//!      by `uri_handler.rs`).
//!   2. We extract the video id from the URL.
//!   3. Fetch the captions track via the public timed-text endpoint
//!      (`https://www.youtube.com/api/timedtext?v=<id>&lang=en`).
//!   4. Parse the timed-text XML into a transcript and write an atom under
//!      `<memory_root>/personal/<user>/threads/external/youtube/<id>.md`.
//!
//! Captions are baseline; if the user wants speaker-grade transcripts they
//! can opt-in to local Whisper via `yt-dlp` (audio download) → existing
//! voice_notes pipeline. v3.0-beta.1 lands the captions pass; the
//! Whisper-on-yt-dlp branch is a follow-up gated behind an explicit
//! `transcribe_via_whisper: true` flag.
//!
//! v3.0-beta.1 keeps the network code OUT of this module — the test path
//! drives `parse_timedtext` and `build_youtube_atom` directly with sample
//! XML. The Tauri command wires the network fetch in `commands/external.rs`.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{
    resolve_external_dir, rfc3339, slugify_external, strip_html, yaml_scalar, ExternalFetchResult,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct YoutubeCaptureRequest {
    pub url: String,
    /// Optional override — defaults to "en" if not set.
    #[serde(default)]
    pub language: Option<String>,
}

/// Extract the YouTube video id from a URL. Handles the four common forms:
///   * `https://www.youtube.com/watch?v=<id>`
///   * `https://youtu.be/<id>`
///   * `https://www.youtube.com/shorts/<id>`
///   * `https://www.youtube.com/embed/<id>`
pub fn extract_video_id(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    // youtu.be short link.
    if let Some(rest) = url.split_once("youtu.be/") {
        let id_segment = rest.1.split(['?', '&', '#', '/']).next().unwrap_or("");
        if is_valid_id(id_segment) {
            return Some(id_segment.to_string());
        }
    }
    // youtube.com/watch?v=...
    if let Some((_, query)) = url.split_once("watch?") {
        for kv in query.split('&') {
            if let Some(v) = kv.strip_prefix("v=") {
                let id = v.split(['&', '#']).next().unwrap_or("");
                if is_valid_id(id) {
                    return Some(id.to_string());
                }
            }
        }
    }
    // youtube.com/shorts/<id> or /embed/<id>.
    for marker in ["shorts/", "embed/"] {
        if let Some(rest) = url.split_once(marker) {
            let id = rest.1.split(['?', '&', '#', '/']).next().unwrap_or("");
            if is_valid_id(id) {
                return Some(id.to_string());
            }
        }
    }
    None
}

fn is_valid_id(s: &str) -> bool {
    s.len() == 11
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Parse a YouTube timed-text XML payload into a single transcript string.
/// We don't preserve timing because the atom body is read by humans + the
/// co-thinker, not by a player.
///
/// Schema (truncated):
///   <transcript>
///     <text start="0.0" dur="3.5">Hello and welcome</text>
///     <text start="3.5" dur="2.0">to the show.</text>
///   </transcript>
pub fn parse_timedtext(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len());
    let lower = xml.to_ascii_lowercase();
    let key = "<text";
    let close = "</text>";
    let mut cursor = 0usize;
    while let Some(rel) = lower[cursor..].find(key) {
        let tag_start = cursor + rel;
        let Some(open_close_rel) = xml[tag_start..].find('>') else {
            break;
        };
        let body_start = tag_start + open_close_rel + 1;
        let body_lower = &lower[body_start..];
        let Some(end_rel) = body_lower.find(close) else {
            break;
        };
        let body_end = body_start + end_rel;
        let line = strip_html(&xml[body_start..body_end]);
        if !line.trim().is_empty() {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(line.trim());
        }
        cursor = body_end + close.len();
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YoutubeAtomInput<'a> {
    pub video_id: &'a str,
    pub url: &'a str,
    pub title: &'a str,
    pub channel: &'a str,
    pub duration_sec: Option<u64>,
    pub transcript: &'a str,
    pub fetched_at: DateTime<Utc>,
}

pub fn build_youtube_atom(input: &YoutubeAtomInput) -> String {
    let title = if input.title.is_empty() { "(untitled)".to_string() } else { input.title.to_string() };
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str("source: youtube\n");
    out.push_str(&format!("video_id: {}\n", yaml_scalar(input.video_id)));
    out.push_str(&format!("video_url: {}\n", yaml_scalar(input.url)));
    out.push_str(&format!("title: {}\n", yaml_scalar(&title)));
    if !input.channel.is_empty() {
        out.push_str(&format!("channel: {}\n", yaml_scalar(input.channel)));
    }
    if let Some(d) = input.duration_sec {
        out.push_str(&format!("duration_sec: {}\n", d));
    }
    out.push_str(&format!(
        "consumed_at: {}\n",
        yaml_scalar(&rfc3339(&input.fetched_at))
    ));
    out.push_str("topic_keys: []\n");
    out.push_str(&format!(
        "summary: {}\n",
        yaml_scalar(&summary_capped(input.transcript, 280))
    ));
    out.push_str("---\n\n");
    out.push_str(&format!("# {}\n\n", title));
    if !input.channel.is_empty() {
        out.push_str(&format!("_{}_\n\n", input.channel));
    }
    if !input.transcript.trim().is_empty() {
        out.push_str("## Transcript\n\n");
        out.push_str(input.transcript.trim());
        out.push_str("\n\n");
    } else {
        out.push_str("_(no transcript available — captions may be disabled for this video)_\n\n");
    }
    out.push_str(&format!("[Watch on YouTube →]({})\n", input.url));
    out
}

fn summary_capped(s: &str, max_chars: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut buf = String::new();
    let mut count = 0usize;
    for c in s.chars() {
        if count >= max_chars - 1 {
            break;
        }
        buf.push(c);
        count += 1;
    }
    buf.push('…');
    buf
}

pub fn youtube_dir(memory_root: &Path, current_user: &str) -> PathBuf {
    resolve_external_dir(memory_root, current_user, "youtube")
}

pub fn write_youtube_atom(
    memory_root: &Path,
    current_user: &str,
    input: &YoutubeAtomInput,
) -> std::io::Result<(PathBuf, bool)> {
    let dir = youtube_dir(memory_root, current_user);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.md", slugify_external(input.video_id)));
    if path.exists() {
        return Ok((path, false));
    }
    std::fs::write(&path, build_youtube_atom(input))?;
    Ok((path, true))
}

pub fn ingest_video(
    memory_root: &Path,
    current_user: &str,
    input: &YoutubeAtomInput,
) -> ExternalFetchResult {
    let mut res = ExternalFetchResult::new("youtube");
    res.items_seen = 1;
    match write_youtube_atom(memory_root, current_user, input) {
        Ok((_, true)) => res.atoms_written = 1,
        Ok((_, false)) => {}
        Err(e) => res.errors.push(format!("{}: {}", input.url, e)),
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_extract_video_id_from_url() {
        assert_eq!(
            extract_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(
            extract_video_id("https://youtu.be/dQw4w9WgXcQ?t=42"),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(
            extract_video_id("https://www.youtube.com/shorts/dQw4w9WgXcQ"),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(
            extract_video_id("https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1"),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(extract_video_id("https://example.com/notyoutube"), None);
        assert_eq!(extract_video_id(""), None);
        // Watch link with extra query params.
        assert_eq!(
            extract_video_id("https://www.youtube.com/watch?list=ABC&v=abc-DEF_123"),
            Some("abc-DEF_123".to_string())
        );
    }

    #[test]
    fn parse_timedtext_concatenates_lines() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<transcript>
  <text start="0" dur="3">Hello and welcome</text>
  <text start="3" dur="2">to the show.</text>
  <text start="5" dur="1">&lt;applause&gt;</text>
</transcript>"#;
        let out = parse_timedtext(xml);
        assert!(out.contains("Hello and welcome"));
        assert!(out.contains("to the show."));
        // Entity-decoded but tags stripped — the < > should appear in-line as text.
        assert!(out.contains("applause"));
    }

    #[test]
    fn build_atom_renders_transcript_section() {
        let input = YoutubeAtomInput {
            video_id: "dQw4w9WgXcQ",
            url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            title: "Never Gonna Give You Up",
            channel: "Rick Astley",
            duration_sec: Some(212),
            transcript: "We're no strangers to love...",
            fetched_at: Utc::now(),
        };
        let body = build_youtube_atom(&input);
        assert!(body.contains("source: youtube"));
        assert!(body.contains("video_id: dQw4w9WgXcQ"));
        assert!(body.contains("# Never Gonna Give You Up"));
        assert!(body.contains("## Transcript"));
        assert!(body.contains("[Watch on YouTube →]"));
    }

    #[test]
    fn ingest_writes_atom_and_dedupes() {
        let dir = std::env::temp_dir().join(format!("tii_yt_{}", uuid::Uuid::new_v4().simple()));
        let now = Utc::now();
        let input = YoutubeAtomInput {
            video_id: "abc12345678",
            url: "https://www.youtube.com/watch?v=abc12345678",
            title: "Sample",
            channel: "Sample channel",
            duration_sec: None,
            transcript: "transcript here",
            fetched_at: now,
        };
        let r1 = ingest_video(&dir, "alice", &input);
        assert_eq!(r1.atoms_written, 1);
        let r2 = ingest_video(&dir, "alice", &input);
        assert_eq!(r2.atoms_written, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
