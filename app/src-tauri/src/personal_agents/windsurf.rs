//! v3.0 §1.4 — Windsurf conversation capture.
//!
//! Windsurf is a Codeium fork; its on-disk shape is close enough to Cursor's
//! that we reuse the Cursor JSON parser via [`super::cursor::parse_conversation`]
//! and only swap the `source` tag in the resulting atom. Probed paths:
//!
//!   * `~/Library/Application Support/Windsurf/sessions/`     (macOS)
//!   * `%APPDATA%/Windsurf/sessions/`                          (Windows)
//!   * `~/.windsurf/sessions/` and `~/.windsurf/conversations/` (Linux / fallback)
//!
//! When the on-disk schema diverges from Cursor's the parser fails-soft —
//! we log the parse error per file and move on.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use super::{
    cursor as cursor_adapter, read_atom_source_mtime, render_atom, system_time_to_nanos,
    PersonalAgentCaptureResult,
};

fn candidate_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(home) = dirs::home_dir() {
        // macOS standard location.
        v.push(
            home.join("Library")
                .join("Application Support")
                .join("Windsurf")
                .join("sessions"),
        );
        // Linux fallback (best-effort).
        v.push(home.join(".windsurf").join("sessions"));
        v.push(home.join(".windsurf").join("conversations"));
    }
    if cfg!(windows) {
        if let Ok(app) = std::env::var("APPDATA") {
            let base = PathBuf::from(&app).join("Windsurf");
            v.push(base.join("sessions"));
            v.push(base.join("conversations"));
        }
    }
    v
}

/// Resolve the canonical Windsurf sessions dir for the Settings UI's
/// "looking for X at <path>" line.
pub fn windsurf_home() -> PathBuf {
    if cfg!(windows) {
        if let Ok(app) = std::env::var("APPDATA") {
            return PathBuf::from(app).join("Windsurf").join("sessions");
        }
    }
    if let Some(home) = dirs::home_dir() {
        return home
            .join("Library")
            .join("Application Support")
            .join("Windsurf")
            .join("sessions");
    }
    PathBuf::from("Windsurf").join("sessions")
}

pub fn detected() -> bool {
    candidate_dirs().iter().any(|p| p.is_dir())
}

pub fn count_conversations() -> usize {
    candidate_dirs()
        .iter()
        .map(|d| list_session_files(d).len())
        .sum()
}

pub fn capture(dest_root: &Path) -> PersonalAgentCaptureResult {
    let mut result = PersonalAgentCaptureResult::empty("windsurf");
    let target_dir = dest_root.join("windsurf");
    if let Err(e) = fs::create_dir_all(&target_dir) {
        result
            .errors
            .push(format!("create_dir_all {}: {}", target_dir.display(), e));
        return result;
    }
    for dir in candidate_dirs() {
        for path in list_session_files(&dir) {
            match capture_one(&path, &target_dir) {
                Ok(true) => result.written += 1,
                Ok(false) => result.skipped += 1,
                Err(e) => result
                    .errors
                    .push(format!("{}: {}", path.display(), e)),
            }
        }
    }
    result
}

fn list_session_files(dir: &Path) -> Vec<PathBuf> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .map(|e| e.eq_ignore_ascii_case("json"))
                    .unwrap_or(false)
        })
        .collect();
    out.sort();
    out
}

fn capture_one(src: &Path, target_dir: &Path) -> Result<bool, String> {
    let src_meta = fs::metadata(src).map_err(|e| format!("metadata: {}", e))?;
    let src_mtime = src_meta.modified().unwrap_or_else(|_| SystemTime::now());
    let src_nanos = system_time_to_nanos(src_mtime);
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("session")
        .to_string();
    let provisional = target_dir.join(format!("{}.md", sanitize_id(&stem)));
    if let Some(prev) = read_atom_source_mtime(&provisional) {
        if prev >= src_nanos {
            return Ok(false);
        }
    }
    let raw = fs::read_to_string(src).map_err(|e| format!("read: {}", e))?;
    // Reuse the Cursor parser then re-tag.
    let mut atom = cursor_adapter::parse_conversation(&raw, src)
        .map_err(|e| format!("parse: {}", e))?;
    atom.source = "windsurf".to_string();
    atom.source_mtime_nanos = src_nanos;
    let final_path = target_dir.join(format!("{}.md", sanitize_id(&atom.conversation_id)));
    fs::write(&final_path, render_atom(&atom))
        .map_err(|e| format!("write {}: {}", final_path.display(), e))?;
    Ok(true)
}

fn sanitize_id(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else if c.is_alphanumeric() {
            out.push(c);
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "session".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_one_round_trips_via_cursor_parser() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_ws_{}",
            uuid::Uuid::new_v4().simple()
        ));
        let src_dir = tmp.join("src");
        let target_dir = tmp.join("dest").join("windsurf");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&target_dir).unwrap();
        let src_file = src_dir.join("ws-1.json");
        fs::write(
            &src_file,
            r#"{"id":"ws-1","title":"x","messages":[{"role":"user","content":"hi"}]}"#,
        )
        .unwrap();
        let first = capture_one(&src_file, &target_dir).unwrap();
        assert!(first);
        // File should be tagged source: windsurf.
        let body = fs::read_to_string(target_dir.join("ws-1.md")).unwrap();
        assert!(body.contains("source: windsurf"));
        // Idempotent.
        assert!(!capture_one(&src_file, &target_dir).unwrap());
        let _ = fs::remove_dir_all(&tmp);
    }
}
