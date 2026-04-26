//! v1.8 Phase 4-C — Canvas → decision atom "propose lock".
//!
//! When a user (or the AGI) feels a sticky on a Canvas has crystallised into
//! a decision, the "Propose as decision" affordance lifts that sticky's body
//! + comments into a draft decision atom under
//! `~/.tangerine-memory/decisions/canvas-{topic}-{stickyid}.md`.
//!
//! The atom is `status: draft` so it doesn't fire writeback adapters (Slack,
//! GitHub, Linear, Notion only act on finalised atoms — see
//! `commands::writeback`). The user must edit + flip the status manually.
//!
//! ## Idempotency
//!
//! `propose_decision_from_sticky` is idempotent — calling it twice for the
//! same `(project, topic, sticky_id)` triple produces the **same** file path
//! and does NOT overwrite a decision that has already had its `status` flipped
//! away from `draft`. Specifically:
//!
//!   * filename is deterministic: `canvas-{slug(topic)}-{slug(sticky_id)}.md`
//!   * if the target file exists AND its frontmatter `status` is anything
//!     other than `draft`, we leave it untouched and just return the path —
//!     the user-curated status survives a second click on the button.
//!   * if the target file exists AND `status: draft`, we re-write it with a
//!     freshly generated body so the draft picks up any new comments that
//!     landed between the two clicks.
//!
//! ## Canvas integration
//!
//! Reads stickies via `agi::canvas::load_topic` (P4-B's text-blob API) +
//! local parser for the `## sticky-{uuid}` / `<!-- canvas-meta: {...} -->`
//! shape `lib/canvas.ts` round-trips. We deliberately don't depend on a
//! shared in-memory CRDT — markdown is the source of truth.

use std::path::{Path, PathBuf};

use chrono::Utc;
use serde_json::Value;

use crate::agi::canvas;
use crate::commands::AppError;

/// One sticky's content for the decision-atom builder. Mirrors what
/// `lib/canvas.ts::Sticky` carries on the React side.
#[derive(Debug, Clone, Default)]
pub struct StickyView {
    pub id: String,
    pub body: String,
    pub author: String,
    pub created_at: String,
    pub is_agi: bool,
    pub color: String,
    pub comments: Vec<CommentView>,
}

#[derive(Debug, Clone, Default)]
pub struct CommentView {
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub is_agi: bool,
}

/// Resolve the user's memory root.
fn default_memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// Build the deterministic decision-atom path for a sticky. Same slug rules
/// as `commands::writeback` so the file lands next to other decision atoms.
pub fn decision_path_for_sticky(memory_root: &Path, topic: &str, sticky_id: &str) -> PathBuf {
    let topic_slug = sanitize_slug(topic);
    let id_slug = sanitize_slug(sticky_id);
    memory_root
        .join("decisions")
        .join(format!("canvas-{}-{}.md", topic_slug, id_slug))
}

/// Build a draft decision atom from one sticky note. Idempotent — see module
/// docs for the rules.
pub async fn propose_decision_from_sticky(
    project: String,
    topic: String,
    sticky_id: String,
) -> Result<PathBuf, AppError> {
    let memory_root = default_memory_root()?;
    propose_decision_from_sticky_in(&memory_root, project, topic, sticky_id).await
}

/// Test-friendly variant.
pub async fn propose_decision_from_sticky_in(
    memory_root: &Path,
    project: String,
    topic: String,
    sticky_id: String,
) -> Result<PathBuf, AppError> {
    let sticky = read_sticky(memory_root, &project, &topic, &sticky_id)?;

    let dest = decision_path_for_sticky(memory_root, &topic, &sticky_id);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir_decisions", e.to_string()))?;
    }

    // Idempotency rule: if file exists with a non-draft status, leave it
    // alone. Otherwise (missing OR status=draft) (over)write a fresh draft.
    if dest.exists() && existing_status_locked(&dest)? {
        return Ok(dest);
    }

    let body = build_decision_atom(&project, &topic, &sticky);
    atomic_write(&dest, &body)?;
    Ok(dest)
}

/// Load the topic markdown via P4-B's `canvas::load_topic`, then parse out
/// the requested sticky. Soft-fails to a breadcrumb StickyView when the
/// canvas file is missing or the sticky id can't be located, so the
/// propose-lock UI never dead-ends.
fn read_sticky(
    memory_root: &Path,
    project: &str,
    topic: &str,
    sticky_id: &str,
) -> Result<StickyView, AppError> {
    let raw = match canvas::load_topic(memory_root, project, topic) {
        Ok(s) => s,
        Err(AppError::User { code, .. }) if code == "canvas_topic_missing" => {
            return Ok(breadcrumb_sticky(sticky_id, &format!(
                "(Canvas topic `canvas/{}/{}.md` not found)",
                project, topic,
            )));
        }
        Err(e) => return Err(e),
    };

    Ok(parse_sticky_from_topic_md(&raw, sticky_id).unwrap_or_else(|| {
        breadcrumb_sticky(
            sticky_id,
            &format!("(Sticky `{}` not found in topic `{}`)", sticky_id, topic),
        )
    }))
}

fn breadcrumb_sticky(sticky_id: &str, body: &str) -> StickyView {
    StickyView {
        id: sticky_id.to_string(),
        body: body.to_string(),
        author: "(unknown)".to_string(),
        created_at: Utc::now().to_rfc3339(),
        is_agi: false,
        color: "yellow".to_string(),
        comments: Vec::new(),
    }
}

/// Parse one sticky out of a P4-B canvas markdown. Returns `None` when the
/// `## sticky-{id}` heading isn't present.
///
/// Recognised shape (from `lib/canvas.ts::stickyToMarkdown`):
///
/// ```markdown
/// ## sticky-{id}
/// <!-- canvas-meta: {"x":..., "color":..., "author":..., "is_agi":..., "created_at":..., "comments":[...]} -->
///
/// body text
///
/// ### Replies
/// - **alice** at <ts>: ...
/// ```
pub fn parse_sticky_from_topic_md(raw: &str, sticky_id: &str) -> Option<StickyView> {
    let header_marker = format!("## sticky-{}", sticky_id);
    let lines: Vec<&str> = raw.lines().collect();

    let mut header_idx = None;
    for (i, l) in lines.iter().enumerate() {
        if l.trim() == header_marker.trim() {
            header_idx = Some(i);
            break;
        }
    }
    let header_idx = header_idx?;

    // End of section: next `## sticky-` header or EOF.
    let mut end = lines.len();
    for (j, l) in lines.iter().enumerate().skip(header_idx + 1) {
        if l.trim_start().starts_with("## sticky-") {
            end = j;
            break;
        }
    }

    let section = &lines[header_idx + 1..end];

    // Parse canvas-meta JSON if present.
    let mut meta_idx: Option<usize> = None;
    let mut meta_val: Option<Value> = None;
    for (k, l) in section.iter().enumerate() {
        if let Some(json_blob) = extract_json_from_meta_line(l) {
            meta_val = serde_json::from_str(&json_blob).ok();
            meta_idx = Some(k);
            break;
        }
    }

    // Body is everything after the meta line, up to the `### Replies` block.
    let body_start = meta_idx.map(|k| k + 1).unwrap_or(0);
    let mut body_end = section.len();
    for (k, l) in section.iter().enumerate().skip(body_start) {
        if l.trim() == "### Replies" {
            body_end = k;
            break;
        }
    }
    let body_raw = section[body_start..body_end].join("\n");
    let body = body_raw
        .trim_matches(|c: char| c == '\n' || c == '\r' || c == ' ')
        .to_string();
    let body = if body == "_(empty)_" { String::new() } else { body };

    // Pull fields off canvas-meta.
    let mut sticky = StickyView {
        id: sticky_id.to_string(),
        body,
        ..Default::default()
    };
    if let Some(m) = meta_val.as_ref() {
        if let Some(s) = m.get("author").and_then(|v| v.as_str()) {
            sticky.author = s.to_string();
        }
        if let Some(b) = m.get("is_agi").and_then(|v| v.as_bool()) {
            sticky.is_agi = b;
        }
        if let Some(s) = m.get("created_at").and_then(|v| v.as_str()) {
            sticky.created_at = s.to_string();
        }
        if let Some(s) = m.get("color").and_then(|v| v.as_str()) {
            sticky.color = s.to_string();
        }
        if let Some(arr) = m.get("comments").and_then(|v| v.as_array()) {
            for c in arr {
                sticky.comments.push(CommentView {
                    author: c
                        .get("author")
                        .and_then(|v| v.as_str())
                        .unwrap_or("(anon)")
                        .to_string(),
                    body: c
                        .get("body")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    created_at: c
                        .get("created_at")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    is_agi: c.get("is_agi").and_then(|v| v.as_bool()).unwrap_or(false),
                });
            }
        }
    }
    if sticky.author.is_empty() {
        sticky.author = "(unknown)".to_string();
    }
    if sticky.color.is_empty() {
        sticky.color = "yellow".to_string();
    }

    Some(sticky)
}

fn extract_json_from_meta_line(line: &str) -> Option<String> {
    let t = line.trim();
    let prefix = "<!-- canvas-meta:";
    let suffix = "-->";
    let start = t.find(prefix)?;
    let after = &t[start + prefix.len()..];
    let end = after.rfind(suffix)?;
    Some(after[..end].trim().to_string())
}

/// Returns true when the existing decision atom has already had its status
/// flipped away from `draft` (so we should NOT overwrite it on a second
/// propose-lock click).
fn existing_status_locked(path: &Path) -> Result<bool, AppError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| AppError::internal("read_existing_decision", e.to_string()))?;

    let mut in_fm = false;
    for (i, line) in raw.lines().enumerate() {
        if i == 0 && line.trim() == "---" {
            in_fm = true;
            continue;
        }
        if in_fm {
            if line.trim() == "---" {
                break;
            }
            if let Some(rest) = line.trim_start().strip_prefix("status:") {
                let s = rest.trim();
                return Ok(!s.eq_ignore_ascii_case("draft"));
            }
        }
    }
    // No status field found → treat as locked-out (safer to not overwrite a
    // file we don't fully understand).
    Ok(true)
}

/// Render the decision-atom markdown body. Public for tests.
pub fn build_decision_atom(project: &str, topic: &str, sticky: &StickyView) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str("source: canvas\n");
    out.push_str(&format!("canvas_project: {}\n", yaml_str(project)));
    out.push_str(&format!("canvas_topic: {}\n", yaml_str(topic)));
    out.push_str(&format!("canvas_sticky_id: {}\n", yaml_str(&sticky.id)));
    out.push_str("proposed_by: tangerine-agi\n");
    out.push_str(&format!("proposed_at: {}\n", Utc::now().to_rfc3339()));
    out.push_str("status: draft\n");
    if sticky.is_agi {
        out.push_str("origin: agi-sticky\n");
    } else {
        out.push_str("origin: human-sticky\n");
    }
    out.push_str("---\n\n");

    out.push_str(&format!("# Decision draft from canvas — {}\n\n", topic));

    out.push_str("## Sticky body\n\n");
    if sticky.body.is_empty() {
        out.push_str("(empty)\n\n");
    } else {
        out.push_str(&sticky.body);
        if !sticky.body.ends_with('\n') {
            out.push('\n');
        }
        out.push('\n');
    }

    out.push_str(&format!(
        "Author: {} ({})\n",
        if sticky.author.is_empty() {
            "(unknown)"
        } else {
            sticky.author.as_str()
        },
        if sticky.is_agi { "AGI" } else { "human" },
    ));
    if !sticky.created_at.is_empty() {
        out.push_str(&format!("Created at: {}\n", sticky.created_at));
    }
    out.push('\n');

    if !sticky.comments.is_empty() {
        out.push_str("## Comments\n\n");
        for c in &sticky.comments {
            out.push_str(&format!(
                "- **{}** ({}) — {}\n",
                if c.author.is_empty() {
                    "(unknown)"
                } else {
                    c.author.as_str()
                },
                if c.is_agi { "AGI" } else { "human" },
                first_line(&c.body)
            ));
        }
        out.push('\n');
    }

    out.push_str("## Decision (edit me)\n\n");
    out.push_str("(Replace this stub with the locked decision text. Flip `status: draft` → `status: final` when ready — that's the trigger writeback adapters watch for.)\n\n");

    out.push_str("## Notes\n\n");
    out.push_str(&format!(
        "- Source canvas: `canvas/{project}/{topic}.md` sticky `{id}`\n",
        project = project,
        topic = topic,
        id = sticky.id,
    ));
    out.push_str("- Proposed by: Tangerine co-thinker (AGI)\n");

    out
}

fn yaml_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().to_string()
}

fn sanitize_slug(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut last_dash = false;
    for c in lower.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "item".to_string()
    } else {
        trimmed
    }
}

fn atomic_write(path: &Path, content: &str) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir", e.to_string()))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content)
        .map_err(|e| AppError::internal("write_tmp_decision", e.to_string()))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::internal("rename_decision", e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_propose_lock_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn seed_canvas_topic(root: &Path, project: &str, topic: &str, body: &str) {
        canvas::save_topic(root, project, topic, body).unwrap();
    }

    fn sample_topic_md() -> &'static str {
        "---\ncanvas_topic: pricing-discussion\ncanvas_project: tangerine\ncreated_at: 2026-04-26T14:23:00Z\nsticky_count: 2\n---\n\n## sticky-stk001\n<!-- canvas-meta: {\"x\":120,\"y\":80,\"color\":\"yellow\",\"author\":\"daizhe\",\"is_agi\":false,\"created_at\":\"2026-04-26T14:23:00Z\",\"comments\":[{\"id\":\"c1\",\"author\":\"tangerine-agi\",\"is_agi\":true,\"created_at\":\"2026-04-26T14:24:00Z\",\"body\":\"+1 — matches david-sync transcript\"},{\"id\":\"c2\",\"author\":\"hongyu\",\"is_agi\":false,\"created_at\":\"2026-04-26T14:25:00Z\",\"body\":\"LGTM, ship it.\"}]} -->\n\nWe should lock pricing at $20/seat for v1.\n3-seat minimum for billing simplicity.\n\n## sticky-stk002\n<!-- canvas-meta: {\"x\":300,\"y\":200,\"color\":\"orange\",\"author\":\"tangerine-agi\",\"is_agi\":true,\"created_at\":\"2026-04-26T14:30:00Z\",\"comments\":[]} -->\n\nOpen question: do we grandfather the 5 existing $15 seats?\n"
    }

    #[test]
    fn test_parse_sticky_from_topic_md_extracts_fields() {
        let s = parse_sticky_from_topic_md(sample_topic_md(), "stk001").unwrap();
        assert_eq!(s.id, "stk001");
        assert_eq!(s.author, "daizhe");
        assert!(!s.is_agi);
        assert_eq!(s.color, "yellow");
        assert!(s.body.contains("$20/seat"));
        assert_eq!(s.comments.len(), 2);
        assert_eq!(s.comments[0].author, "tangerine-agi");
        assert!(s.comments[0].is_agi);
        assert!(s.comments[1].body.contains("LGTM"));
    }

    #[test]
    fn test_parse_sticky_returns_none_for_missing_id() {
        let s = parse_sticky_from_topic_md(sample_topic_md(), "stk-999");
        assert!(s.is_none());
    }

    #[test]
    fn test_parse_sticky_handles_agi_sticky() {
        let s = parse_sticky_from_topic_md(sample_topic_md(), "stk002").unwrap();
        assert!(s.is_agi);
        assert_eq!(s.color, "orange");
        assert!(s.body.contains("grandfather"));
    }

    #[test]
    fn test_decision_path_is_deterministic() {
        let root = tmp_root();
        let a = decision_path_for_sticky(&root, "Pricing Discussion!", "stk001");
        let b = decision_path_for_sticky(&root, "pricing discussion", "stk001");
        assert_eq!(a.file_name(), b.file_name());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_build_decision_atom_has_required_frontmatter() {
        let s = StickyView {
            id: "stk1".into(),
            body: "lock pricing".into(),
            author: "daizhe".into(),
            created_at: "2026-04-26T14:23:00Z".into(),
            is_agi: false,
            color: "yellow".into(),
            comments: vec![],
        };
        let md = build_decision_atom("p", "t", &s);
        assert!(md.contains("source: canvas"));
        assert!(md.contains("canvas_project: \"p\""));
        assert!(md.contains("canvas_topic: \"t\""));
        assert!(md.contains("canvas_sticky_id: \"stk1\""));
        assert!(md.contains("proposed_by: tangerine-agi"));
        assert!(md.contains("status: draft"));
        assert!(md.contains("origin: human-sticky"));
        assert!(md.contains("lock pricing"));
    }

    #[tokio::test]
    async fn test_propose_lock_writes_decision_atom() {
        let root = tmp_root();
        seed_canvas_topic(&root, "tangerine", "pricing-discussion", sample_topic_md());

        let path = propose_decision_from_sticky_in(
            &root,
            "tangerine".to_string(),
            "pricing-discussion".to_string(),
            "stk001".to_string(),
        )
        .await
        .unwrap();

        assert!(path.exists());
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("source: canvas"));
        assert!(raw.contains("canvas_topic: \"pricing-discussion\""));
        assert!(raw.contains("canvas_sticky_id: \"stk001\""));
        assert!(raw.contains("proposed_by: tangerine-agi"));
        assert!(raw.contains("status: draft"));
        assert!(raw.contains("$20/seat"));
        assert!(
            path.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("canvas-pricing-discussion-stk001"))
                .unwrap_or(false),
            "filename should be deterministic, got {:?}",
            path.file_name()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_propose_lock_idempotent() {
        let root = tmp_root();
        seed_canvas_topic(&root, "tangerine", "pricing-discussion", sample_topic_md());

        let p1 = propose_decision_from_sticky_in(
            &root,
            "tangerine".to_string(),
            "pricing-discussion".to_string(),
            "stk001".to_string(),
        )
        .await
        .unwrap();
        let p2 = propose_decision_from_sticky_in(
            &root,
            "tangerine".to_string(),
            "pricing-discussion".to_string(),
            "stk001".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(p1, p2);

        let n = std::fs::read_dir(root.join("decisions")).unwrap().count();
        assert_eq!(n, 1, "must not create a duplicate file");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_propose_lock_does_not_overwrite_finalized_decision() {
        let root = tmp_root();
        seed_canvas_topic(&root, "tangerine", "pricing-discussion", sample_topic_md());

        let path = propose_decision_from_sticky_in(
            &root,
            "tangerine".to_string(),
            "pricing-discussion".to_string(),
            "stk001".to_string(),
        )
        .await
        .unwrap();

        let original = std::fs::read_to_string(&path).unwrap();
        let user_edited = original.replace("status: draft", "status: final");
        let user_edited = format!("{}\n\nUSER MARKER — do not overwrite\n", user_edited);
        std::fs::write(&path, &user_edited).unwrap();

        let path2 = propose_decision_from_sticky_in(
            &root,
            "tangerine".to_string(),
            "pricing-discussion".to_string(),
            "stk001".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(path, path2);
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("USER MARKER"));
        assert!(after.contains("status: final"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_propose_lock_soft_fails_on_missing_canvas_file() {
        let root = tmp_root();
        // No canvas file at all.
        let path = propose_decision_from_sticky_in(
            &root,
            "ghostproject".to_string(),
            "missingtopic".to_string(),
            "stkx".to_string(),
        )
        .await
        .unwrap();
        assert!(path.exists());
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("(Canvas topic"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_sanitize_slug_collapses_punctuation() {
        assert_eq!(sanitize_slug("Hello World!"), "hello-world");
        assert_eq!(sanitize_slug("a/b/c"), "a-b-c");
        assert_eq!(sanitize_slug("---"), "item");
        assert_eq!(sanitize_slug("stk_001"), "stk_001");
    }

    #[test]
    fn test_existing_status_locked_detects_final() {
        let root = tmp_root();
        let p = root.join("decisions/x.md");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "---\nstatus: final\n---\n\nfinal content\n").unwrap();
        assert!(existing_status_locked(&p).unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_existing_status_locked_treats_draft_as_unlocked() {
        let root = tmp_root();
        let p = root.join("decisions/y.md");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "---\nstatus: draft\n---\n\ndraft\n").unwrap();
        assert!(!existing_status_locked(&p).unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }
}
