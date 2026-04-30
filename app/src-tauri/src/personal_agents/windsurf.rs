//! v3.0 §1.4 — Windsurf conversation capture.
//!
//! Windsurf is a Codeium fork; its on-disk shape is close enough to Cursor's
//! that we reuse the Cursor JSON parser via [`super::cursor::parse_conversation`]
//! and only swap the `source` tag in the resulting atom. Probed paths
//! (v1.15.2 fix #2 cross-platform sweep — first hit wins for the
//! Settings "Looking for X at <path>" line):
//!
//!   * Windows: `%APPDATA%\Windsurf\User\conversations\` (Electron `userData`)
//!   * macOS:   `~/Library/Application Support/Windsurf/User/conversations/`
//!   * Linux:   `~/.config/Windsurf/User/conversations/`
//!   * Codeium fork (all OS): `~/.codeium/windsurf/sessions/` and
//!     `~/.codeium/windsurf/conversations/` (matches the v1.15.1
//!     setup_wizard.rs fix that anchored MCP config under `~/.codeium/windsurf/`)
//!   * Legacy fallbacks: `~/.windsurf/sessions/`, `~/.windsurf/conversations/`,
//!     and the early `<userData>/sessions` shape some pre-1.0 builds used
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

/// Platform-canonical Windsurf Electron `userData/User` dir, or `None`
/// when no platform path is resolvable. Mirrors the helper in
/// `cursor.rs` — Windsurf is a Cursor fork so the on-disk layout is the
/// same. Pulled into its own helper so the candidate-dir builder and
/// `windsurf_home()` agree.
fn platform_user_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Some(cfg) = dirs::config_dir() {
            return Some(cfg.join("Windsurf").join("User"));
        }
        if let Ok(app) = std::env::var("APPDATA") {
            return Some(PathBuf::from(app).join("Windsurf").join("User"));
        }
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            return Some(
                home.join("Library")
                    .join("Application Support")
                    .join("Windsurf")
                    .join("User"),
            );
        }
        return None;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(cfg) = dirs::config_dir() {
            return Some(cfg.join("Windsurf").join("User"));
        }
        return None;
    }
    #[allow(unreachable_code)]
    None
}

fn candidate_dirs() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    let push = |p: PathBuf, list: &mut Vec<PathBuf>| {
        if !list.contains(&p) {
            list.push(p);
        }
    };
    // 1) Platform-canonical Electron `User/conversations` — head of the
    //    list so Settings shows the Windows / macOS / Linux native path
    //    on the right OS.
    if let Some(user_dir) = platform_user_dir() {
        push(user_dir.join("conversations"), &mut v);
        push(user_dir.join("sessions"), &mut v);
    }
    // 2) Codeium fork canonical (`~/.codeium/windsurf/`) — matches the
    //    v1.15.1 setup_wizard.rs fix that anchored MCP config at
    //    `~/.codeium/windsurf/mcp_config.json`. Shipped Windsurf builds
    //    use this on every OS.
    if let Some(home) = dirs::home_dir() {
        let codeium = home.join(".codeium").join("windsurf");
        push(codeium.join("sessions"), &mut v);
        push(codeium.join("conversations"), &mut v);
        // 3) Legacy `~/.windsurf/` — pre-1.0 internal-tutorial path.
        push(home.join(".windsurf").join("sessions"), &mut v);
        push(home.join(".windsurf").join("conversations"), &mut v);
    }
    // 4) macOS Application Support direct-children fallback (some early
    //    Windsurf alphas wrote `sessions/` directly under the bundle
    //    root rather than under `User/`).
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            push(
                home.join("Library")
                    .join("Application Support")
                    .join("Windsurf")
                    .join("sessions"),
                &mut v,
            );
        }
    }
    // 5) Windows `%APPDATA%\Windsurf\sessions` — same alpha-era
    //    fallback as the macOS one above.
    #[cfg(target_os = "windows")]
    {
        if let Ok(app) = std::env::var("APPDATA") {
            push(PathBuf::from(&app).join("Windsurf").join("sessions"), &mut v);
            push(
                PathBuf::from(&app).join("Windsurf").join("conversations"),
                &mut v,
            );
        }
    }
    v
}

/// Resolve the canonical Windsurf sessions dir for the Settings UI's
/// "looking for X at <path>" line. v1.15.2 fix #2 — returns the
/// platform-canonical Electron path on each OS, falling back to the
/// `~/.codeium/windsurf/` shipped Windsurf path when the Electron dir
/// can't be resolved (e.g., Windows without `%APPDATA%`).
pub fn windsurf_home() -> PathBuf {
    if let Some(user_dir) = platform_user_dir() {
        return user_dir.join("conversations");
    }
    if let Some(home) = dirs::home_dir() {
        return home
            .join(".codeium")
            .join("windsurf")
            .join("sessions");
    }
    PathBuf::from("Windsurf").join("conversations")
}

pub fn detected() -> bool {
    candidate_dirs().iter().any(|p| p.is_dir())
}

// === v1.14.5 round-6 ===
/// Structured detection — see `cursor::detection_status` for rationale.
pub fn detection_status() -> super::PersonalAgentDetectionStatus {
    super::probe_candidates(&candidate_dirs())
}
// === end v1.14.5 round-6 ===

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
    // === v1.18.2 R6 fix === When parsed `conversation_id` (from the JSON
    // `id` field) differs from the filename stem, the provisional check
    // above misses and we'd write the atom every heartbeat — counted as
    // `written` instead of `skipped`. Mirrors the same fix in codex /
    // claude_code adapters so the Settings toast doesn't lie about
    // capture work being done.
    if final_path != provisional {
        if let Some(prev) = read_atom_source_mtime(&final_path) {
            if prev >= src_nanos {
                return Ok(false);
            }
        }
    }
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

    // === v1.15.2 fix #2 ===
    #[test]
    #[cfg(target_os = "windows")]
    fn windsurf_home_windows_resolves_to_appdata_user_conversations() {
        let p = windsurf_home();
        let s = p.to_string_lossy().to_lowercase();
        assert!(
            s.contains("appdata") || s.contains("roaming") || s.contains(".codeium"),
            "Windows windsurf_home must point under %APPDATA% or .codeium fallback, got {}",
            p.display()
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn windsurf_home_macos_resolves_to_application_support() {
        let p = windsurf_home();
        let s = p.to_string_lossy();
        assert!(
            s.contains("Library/Application Support/Windsurf"),
            "macOS windsurf_home must use Application Support, got {}",
            p.display()
        );
    }

    #[test]
    #[cfg(all(unix, not(target_os = "macos")))]
    fn windsurf_home_linux_resolves_to_config_windsurf() {
        let p = windsurf_home();
        let s = p.to_string_lossy();
        assert!(
            s.contains("Windsurf"),
            "Linux windsurf_home must contain Windsurf, got {}",
            p.display()
        );
    }

    /// Codeium fork canonical path (`~/.codeium/windsurf/`) must be in
    /// the candidate sweep on every OS — that's the path v1.15.1's
    /// setup_wizard.rs fix anchored to as the shipped Windsurf MCP
    /// path.
    #[test]
    fn candidate_dirs_includes_codeium_windsurf_on_every_os() {
        let dirs = candidate_dirs();
        let has_codeium = dirs.iter().any(|p| {
            let s = p.to_string_lossy();
            s.contains(".codeium") && s.contains("windsurf")
        });
        assert!(
            has_codeium,
            "candidate_dirs must include ~/.codeium/windsurf/, got {:?}",
            dirs
        );
    }
    // === end v1.15.2 fix #2 ===

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

    /// === v1.18.2 R6 regression test ===
    /// Pre-fix bug: when the JSON's `id` differed from the filename stem
    /// (Windsurf rename / re-export), the second pass wrote the same atom
    /// every heartbeat and reported it as `written`. The Settings toast
    /// "wrote N, skipped 0" therefore lied about how much real work the
    /// capture pass did. Mirror of the codex regression test.
    #[test]
    fn capture_is_idempotent_when_json_id_differs_from_filename_stem() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_ws_idemp_{}",
            uuid::Uuid::new_v4().simple()
        ));
        let src_dir = tmp.join("src");
        let target_dir = tmp.join("dest").join("windsurf");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&target_dir).unwrap();
        let src_file = src_dir.join("file-stem.json");
        fs::write(
            &src_file,
            r#"{"id":"parsed-id","title":"x","messages":[{"role":"user","content":"hi"}]}"#,
        )
        .unwrap();
        let first = capture_one(&src_file, &target_dir).unwrap();
        assert!(first, "first run should write");
        assert!(
            target_dir.join("parsed-id.md").is_file(),
            "atom must land at parsed-id.md (JSON id), not file-stem.md"
        );
        let second = capture_one(&src_file, &target_dir).unwrap();
        assert!(
            !second,
            "second run must skip — pre-fix returned true, inflating wrote-N"
        );
        let _ = fs::remove_dir_all(&tmp);
    }
}
