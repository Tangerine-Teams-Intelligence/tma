//! v1.8 Phase 4-C — AGI canvas writer (sticky-throw + comment append).
//!
//! Builds on top of P4-B's `agi::canvas::{load_topic, save_topic}` text-blob
//! API. The on-disk shape is owned by P4-B (see `app/src/lib/canvas.ts` and
//! `app/src-tauri/src/agi/canvas.rs`):
//!
//! ```markdown
//! ---
//! canvas_topic: ...
//! canvas_project: ...
//! created_at: ...
//! sticky_count: N
//! ---
//!
//! ## sticky-{uuid}
//! <!-- canvas-meta: {"x":80,"y":80,"color":"orange","author":"tangerine-agi","is_agi":true,"created_at":"...","comments":[...]} -->
//!
//! body text
//!
//! ### Replies
//! - **alice** at 2026-04-26T14:23: ...
//! ```
//!
//! We mutate that shape in place via tiny markdown surgery (frontmatter
//! `sticky_count` bump, append a new section, splice replies into the
//! `canvas-meta` JSON of the target sticky). Atomic-ness is delegated to
//! P4-B's `save_topic` which uses tmp + rename internally.

use std::path::Path;

use chrono::Utc;
use serde_json::{json, Value};

use crate::agi::canvas;
use crate::commands::AppError;

// ---------------------------------------------------------------------------
// Public API

/// AGI throws a fresh sticky onto a canvas surface. Returns the freshly
/// minted sticky id (a 12-hex-char short UUID, matching `lib/canvas.ts`'s
/// `shortUuid`).
pub async fn agi_throw_sticky(
    project: String,
    topic: String,
    body: String,
    color: String,
) -> Result<String, AppError> {
    let memory_root = default_memory_root()?;
    agi_throw_sticky_in(&memory_root, project, topic, body, color).await
}

/// Test-friendly variant — caller passes the memory root explicitly.
pub async fn agi_throw_sticky_in(
    memory_root: &Path,
    project: String,
    topic: String,
    body: String,
    color: String,
) -> Result<String, AppError> {
    let id = short_uuid();
    let now = Utc::now().to_rfc3339();
    let safe_color = if VALID_COLORS.contains(&color.as_str()) {
        color
    } else {
        "orange".to_string()
    };

    // Load existing topic — or seed an empty frontmatter block when missing.
    let existing = match canvas::load_topic(memory_root, &project, &topic) {
        Ok(s) => s,
        Err(AppError::User { code, .. }) if code == "canvas_topic_missing" => {
            seed_topic_md(&project, &topic, &now)
        }
        Err(e) => return Err(e),
    };

    let with_sticky = append_sticky_section(&existing, &id, &body, &safe_color, &now)?;
    canvas::save_topic(memory_root, &project, &topic, &with_sticky)?;
    Ok(id)
}

/// AGI replies on an existing sticky. The reply lands in the target
/// sticky's `canvas-meta` JSON `comments` array (which is what `lib/canvas.ts`
/// rehydrates as `Sticky.comments`).
pub async fn agi_comment_sticky(
    project: String,
    topic: String,
    sticky_id: String,
    body: String,
) -> Result<(), AppError> {
    let memory_root = default_memory_root()?;
    agi_comment_sticky_in(&memory_root, project, topic, sticky_id, body).await
}

/// Test-friendly variant.
pub async fn agi_comment_sticky_in(
    memory_root: &Path,
    project: String,
    topic: String,
    sticky_id: String,
    body: String,
) -> Result<(), AppError> {
    let now = Utc::now().to_rfc3339();
    let existing = canvas::load_topic(memory_root, &project, &topic)?;

    let with_comment = append_comment_to_sticky(&existing, &sticky_id, &body, &now)?;
    canvas::save_topic(memory_root, &project, &topic, &with_comment)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Markdown surgery

const VALID_COLORS: &[&str] = &["yellow", "pink", "blue", "green", "orange", "purple"];

fn seed_topic_md(project: &str, topic: &str, created_at: &str) -> String {
    format!(
        "---\ncanvas_topic: {topic}\ncanvas_project: {project}\ncreated_at: {created_at}\nsticky_count: 0\n---\n\n",
        topic = yaml_scalar(topic),
        project = yaml_scalar(project),
        created_at = created_at,
    )
}

fn yaml_scalar(s: &str) -> String {
    if s.is_empty() || s.contains([':', '#', '\n', '\r', '"', '\''])
        || s.starts_with(' ')
        || s.ends_with(' ')
    {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

/// Append a fresh sticky section to a topic's markdown. Bumps the
/// `sticky_count: N` frontmatter line if present.
pub fn append_sticky_section(
    existing: &str,
    id: &str,
    body: &str,
    color: &str,
    created_at: &str,
) -> Result<String, AppError> {
    let meta = json!({
        "x": 80,
        "y": 80,
        "color": color,
        "author": "tangerine-agi",
        "is_agi": true,
        "created_at": created_at,
        "comments": []
    });

    let body_norm = body.trim();
    let body_render = if body_norm.is_empty() {
        "_(empty)_".to_string()
    } else {
        body_norm.to_string()
    };

    let section = format!(
        "## sticky-{id}\n<!-- canvas-meta: {meta} -->\n\n{body}",
        id = id,
        meta = serde_json::to_string(&meta)
            .map_err(|e| AppError::internal("serialize_meta", e.to_string()))?,
        body = body_render,
    );

    let bumped = bump_sticky_count(existing);

    let needs_blank = !bumped.ends_with("\n\n");
    let separator = if bumped.ends_with('\n') {
        if needs_blank { "\n" } else { "" }
    } else {
        "\n\n"
    };
    let mut out = String::with_capacity(bumped.len() + separator.len() + section.len() + 1);
    out.push_str(&bumped);
    out.push_str(separator);
    out.push_str(&section);
    out.push('\n');
    Ok(out)
}

/// Increment the `sticky_count: N` frontmatter line. If none exists, leave
/// the input unchanged — defensive against hand-edited topic files.
fn bump_sticky_count(existing: &str) -> String {
    // Walk frontmatter only.
    let mut lines: Vec<String> = existing.lines().map(|s| s.to_string()).collect();
    if lines.is_empty() || lines[0].trim() != "---" {
        return existing.to_string();
    }
    let mut fm_end = None;
    for (i, l) in lines.iter().enumerate().skip(1) {
        if l.trim() == "---" {
            fm_end = Some(i);
            break;
        }
    }
    let fm_end = match fm_end {
        Some(n) => n,
        None => return existing.to_string(),
    };
    for line in lines.iter_mut().take(fm_end).skip(1) {
        if let Some(rest) = line.trim_start().strip_prefix("sticky_count:") {
            let n: i64 = rest.trim().parse().unwrap_or(0);
            *line = format!("sticky_count: {}", n + 1);
            break;
        }
    }
    let mut out = lines.join("\n");
    if existing.ends_with('\n') && !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Splice a new comment into the `canvas-meta` JSON of the target sticky.
/// Public for tests.
pub fn append_comment_to_sticky(
    existing: &str,
    sticky_id: &str,
    body: &str,
    now: &str,
) -> Result<String, AppError> {
    let header_marker = format!("## sticky-{}", sticky_id);
    let lines: Vec<&str> = existing.lines().collect();

    // Locate the sticky header.
    let mut header_idx = None;
    for (i, l) in lines.iter().enumerate() {
        if l.trim() == header_marker.trim() {
            header_idx = Some(i);
            break;
        }
    }
    let header_idx = header_idx.ok_or_else(|| {
        AppError::user(
            "sticky_not_found",
            format!("sticky `{}` not found", sticky_id),
        )
    })?;

    // Find the canvas-meta line within this section.
    let mut meta_idx = None;
    for (j, l) in lines.iter().enumerate().skip(header_idx + 1) {
        if l.trim_start().starts_with("## sticky-") {
            break;
        }
        if l.trim_start().starts_with("<!-- canvas-meta:") {
            meta_idx = Some(j);
            break;
        }
    }
    let meta_idx = meta_idx.ok_or_else(|| {
        AppError::internal(
            "canvas_meta_missing",
            format!("sticky `{}` has no canvas-meta sidecar", sticky_id),
        )
    })?;

    let meta_line = lines[meta_idx];
    let json_blob = extract_json_from_meta_line(meta_line).ok_or_else(|| {
        AppError::internal(
            "canvas_meta_unparseable",
            format!("could not extract JSON from `{}`", meta_line),
        )
    })?;
    let mut meta_val: Value = serde_json::from_str(&json_blob)
        .map_err(|e| AppError::internal("canvas_meta_json", e.to_string()))?;

    let new_comment = json!({
        "id": short_uuid(),
        "author": "tangerine-agi",
        "is_agi": true,
        "created_at": now,
        "body": body
    });

    {
        let comments = meta_val
            .as_object_mut()
            .ok_or_else(|| AppError::internal("canvas_meta_root", "meta is not an object"))?
            .entry("comments")
            .or_insert_with(|| Value::Array(Vec::new()));
        match comments {
            Value::Array(arr) => arr.push(new_comment),
            _ => {
                *comments = Value::Array(vec![new_comment]);
            }
        }
    }

    let new_meta_line = format!(
        "<!-- canvas-meta: {} -->",
        serde_json::to_string(&meta_val)
            .map_err(|e| AppError::internal("serialize_meta", e.to_string()))?,
    );

    let mut out_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    out_lines[meta_idx] = new_meta_line;
    let mut out = out_lines.join("\n");
    if existing.ends_with('\n') && !out.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

/// Pull the JSON blob out of `<!-- canvas-meta: {...} -->`. Returns `None` if
/// the comment doesn't end with `-->` on the same line.
fn extract_json_from_meta_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let prefix = "<!-- canvas-meta:";
    let suffix = "-->";
    let start = trimmed.find(prefix)?;
    let after = &trimmed[start + prefix.len()..];
    let end = after.rfind(suffix)?;
    Some(after[..end].trim().to_string())
}

// ---------------------------------------------------------------------------
// Helpers

fn default_memory_root() -> Result<std::path::PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// 12 hex chars — matches `lib/canvas.ts::shortUuid` so AGI-thrown ids are
/// indistinguishable from user-thrown ids in the markdown layout.
fn short_uuid() -> String {
    let u = uuid::Uuid::new_v4().simple().to_string();
    u[..12].to_string()
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_canvas_writer_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn parse_meta_for_sticky(md: &str, sticky_id: &str) -> Value {
        let header = format!("## sticky-{}", sticky_id);
        let mut found = false;
        for line in md.lines() {
            if line.trim() == header.trim() {
                found = true;
                continue;
            }
            if !found {
                continue;
            }
            if let Some(j) = extract_json_from_meta_line(line) {
                return serde_json::from_str::<Value>(&j).expect("valid json");
            }
            if line.trim_start().starts_with("## sticky-") {
                break;
            }
        }
        panic!("no canvas-meta found for {}", sticky_id);
    }

    #[tokio::test]
    async fn test_agi_throw_sticky_appends_to_topic() {
        let root = tmp_root();
        let id = agi_throw_sticky_in(
            &root,
            "tangerine".to_string(),
            "weekly-sync".to_string(),
            "Reminder: David promised follow-up by Fri.".to_string(),
            "yellow".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(id.len(), 12);

        let p = root.join("canvas/tangerine/weekly-sync.md");
        assert!(p.exists());
        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(raw.contains("canvas_project: tangerine"));
        assert!(raw.contains(&format!("## sticky-{}", id)));
        assert!(raw.contains("\"is_agi\":true"));
        assert!(raw.contains("\"author\":\"tangerine-agi\""));
        assert!(raw.contains("\"color\":\"yellow\""));
        assert!(raw.contains("David promised follow-up"));
        assert!(raw.contains("sticky_count: 1"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_agi_throw_sticky_bumps_count_for_existing_topic() {
        let root = tmp_root();
        // Seed a topic with one sticky already in it via P4-B's API (using
        // an empty-body sticky markdown shape).
        let seed = "---\ncanvas_topic: t\ncanvas_project: p\ncreated_at: 2026-04-26T00:00:00Z\nsticky_count: 1\n---\n\n## sticky-existing12\n<!-- canvas-meta: {\"x\":0,\"y\":0,\"color\":\"yellow\",\"author\":\"daizhe\",\"is_agi\":false,\"created_at\":\"2026-04-26T00:00:00Z\",\"comments\":[]} -->\n\nfirst\n";
        canvas::save_topic(&root, "p", "t", seed).unwrap();

        let _ = agi_throw_sticky_in(
            &root,
            "p".to_string(),
            "t".to_string(),
            "agi addition".to_string(),
            "blue".to_string(),
        )
        .await
        .unwrap();

        let raw = std::fs::read_to_string(root.join("canvas/p/t.md")).unwrap();
        assert!(raw.contains("sticky_count: 2"));
        assert!(raw.contains("agi addition"));
        assert!(raw.contains("first"), "must preserve existing stickies");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_agi_throw_sticky_falls_back_to_orange_for_invalid_color() {
        let root = tmp_root();
        let id = agi_throw_sticky_in(
            &root,
            "p".to_string(),
            "t".to_string(),
            "x".to_string(),
            "rainbow".to_string(),
        )
        .await
        .unwrap();
        let raw = std::fs::read_to_string(root.join("canvas/p/t.md")).unwrap();
        let meta = parse_meta_for_sticky(&raw, &id);
        assert_eq!(meta["color"].as_str(), Some("orange"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_agi_comment_sticky_splices_into_meta() {
        let root = tmp_root();
        let id = agi_throw_sticky_in(
            &root,
            "p".to_string(),
            "t".to_string(),
            "ground truth".to_string(),
            "yellow".to_string(),
        )
        .await
        .unwrap();

        agi_comment_sticky_in(
            &root,
            "p".to_string(),
            "t".to_string(),
            id.clone(),
            "Backed by yesterday's transcript.".to_string(),
        )
        .await
        .unwrap();

        let raw = std::fs::read_to_string(root.join("canvas/p/t.md")).unwrap();
        let meta = parse_meta_for_sticky(&raw, &id);
        let comments = meta["comments"].as_array().unwrap();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0]["author"].as_str(), Some("tangerine-agi"));
        assert_eq!(comments[0]["is_agi"].as_bool(), Some(true));
        assert!(comments[0]["body"].as_str().unwrap().contains("transcript"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_agi_comment_sticky_errors_when_missing() {
        let root = tmp_root();
        let _ = agi_throw_sticky_in(
            &root,
            "p".to_string(),
            "t".to_string(),
            "first".to_string(),
            "yellow".to_string(),
        )
        .await
        .unwrap();
        let err = agi_comment_sticky_in(
            &root,
            "p".to_string(),
            "t".to_string(),
            "ghost-id".to_string(),
            "won't land".to_string(),
        )
        .await;
        assert!(err.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_bump_sticky_count_increments() {
        let md = "---\ncanvas_topic: t\nsticky_count: 3\n---\n\nbody\n";
        let bumped = bump_sticky_count(md);
        assert!(bumped.contains("sticky_count: 4"));
    }

    #[test]
    fn test_bump_sticky_count_handles_missing_field() {
        let md = "---\ncanvas_topic: t\n---\n\nbody\n";
        let bumped = bump_sticky_count(md);
        // No sticky_count line → unchanged (defensive).
        assert_eq!(bumped, md);
    }

    #[test]
    fn test_extract_json_from_meta_line() {
        let line = "<!-- canvas-meta: {\"x\":1,\"y\":2} -->";
        let j = extract_json_from_meta_line(line).unwrap();
        assert_eq!(j, "{\"x\":1,\"y\":2}");
    }
}
