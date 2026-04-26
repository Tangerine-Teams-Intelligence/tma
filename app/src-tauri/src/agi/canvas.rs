//! v1.8 Phase 4-B — Canvas surface filesystem layer.
//!
//! Per-project ideation surface. Each canvas topic is a markdown file at
//! `<memory_root>/canvas/<project-slug>/<topic-slug>.md`. The shape is
//! frontmatter + one `## sticky-{uuid}` section per note, with a
//! `<!-- canvas-meta: {...} -->` JSON sidecar carrying position / color /
//! comment list. See `app/src/lib/canvas.ts` for the round-trip details.
//!
//! Sibling P4-C (AGI peer behaviors on the canvas) reads / writes the same
//! files via the same Tauri commands — we don't need a shared in-memory
//! state because the markdown files are the source of truth and the React
//! components reload after every save. The atomic-write helper keeps a
//! concurrent P4-C tick from observing a half-written file.

use std::path::{Path, PathBuf};

use crate::commands::AppError;

/// List every topic file under `<memory_root>/canvas/<project>/`. Returns
/// the topic slugs (file stems with the `.md` suffix stripped), sorted
/// case-insensitively so the UI gets a stable order without an extra pass.
/// Missing dir → empty Vec, not an error: a fresh canvas has zero topics.
pub fn list_topics(memory_root: &Path, project: &str) -> Result<Vec<String>, AppError> {
    let dir = canvas_project_dir(memory_root, project)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<String> = Vec::new();
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| AppError::internal("read_canvas_dir", e.to_string()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        if let Some(stem) = name.strip_suffix(".md") {
            out.push(stem.to_string());
        }
    }
    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(out)
}

/// List every project that has at least one canvas topic on disk. Returns
/// project slugs (the immediate subdirs of `<memory_root>/canvas/`).
/// Missing root canvas dir → empty Vec.
pub fn list_projects(memory_root: &Path) -> Result<Vec<String>, AppError> {
    let dir = memory_root.join("canvas");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<String> = Vec::new();
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| AppError::internal("read_canvas_root", e.to_string()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        out.push(name.to_string());
    }
    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(out)
}

/// Read one topic file as a UTF-8 string. Returns a friendly user-error
/// when the file doesn't exist so the React side can render an inline
/// "topic missing" message instead of a generic IO crash.
pub fn load_topic(
    memory_root: &Path,
    project: &str,
    topic: &str,
) -> Result<String, AppError> {
    let path = topic_path(memory_root, project, topic)?;
    if !path.exists() {
        return Err(AppError::user(
            "canvas_topic_missing",
            format!(
                "No canvas topic at canvas/{}/{}.md — create it first.",
                project, topic,
            ),
        ));
    }
    std::fs::read_to_string(&path).map_err(|e| AppError::internal("read_topic", e.to_string()))
}

/// Atomically write a topic file. Creates the project subdir if it
/// doesn't already exist. Atomic via tmp + rename so a concurrent reader
/// (P4-C heartbeat or another tab) never sees a partial write.
pub fn save_topic(
    memory_root: &Path,
    project: &str,
    topic: &str,
    content: &str,
) -> Result<(), AppError> {
    let path = topic_path(memory_root, project, topic)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir_canvas", e.to_string()))?;
    }
    atomic_write(&path, content)
}

/// Resolve `<memory_root>/canvas/<project-slug>/`. Validates that the
/// project slug is filesystem-safe (no path separators, no parent refs).
fn canvas_project_dir(memory_root: &Path, project: &str) -> Result<PathBuf, AppError> {
    validate_slug("project", project)?;
    Ok(memory_root.join("canvas").join(project))
}

/// Resolve `<memory_root>/canvas/<project>/<topic>.md`. Validates both
/// slugs are filesystem-safe.
fn topic_path(memory_root: &Path, project: &str, topic: &str) -> Result<PathBuf, AppError> {
    validate_slug("project", project)?;
    validate_slug("topic", topic)?;
    Ok(memory_root
        .join("canvas")
        .join(project)
        .join(format!("{}.md", topic)))
}

fn validate_slug(kind: &str, s: &str) -> Result<(), AppError> {
    if s.is_empty() {
        return Err(AppError::user(
            "canvas_bad_slug",
            format!("{} slug must not be empty", kind),
        ));
    }
    // Disallow path traversal + Windows path separators. We accept only
    // a small character set so we can confidently ship paths to the OS.
    for c in s.chars() {
        let ok = c.is_ascii_alphanumeric() || c == '-' || c == '_';
        if !ok {
            return Err(AppError::user(
                "canvas_bad_slug",
                format!(
                    "{} slug must contain only [a-z0-9-_]; got {:?}",
                    kind, s,
                ),
            ));
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, content: &str) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir", e.to_string()))?;
    }
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, content)
        .map_err(|e| AppError::internal("write_tmp", e.to_string()))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::internal("rename", e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_canvas_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn test_save_topic_atomic() {
        let root = tmp_root();
        let content = "---\ncanvas_topic: test\n---\n\nbody\n";
        save_topic(&root, "myproject", "ideation", content).unwrap();

        let path = root.join("canvas/myproject/ideation.md");
        assert!(path.exists());
        let read = std::fs::read_to_string(&path).unwrap();
        assert_eq!(read, content);

        // The .tmp sidecar must NOT linger after a successful rename.
        let tmp = root.join("canvas/myproject/ideation.md.tmp");
        assert!(!tmp.exists(), "tmp sidecar must be removed by rename");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_load_topic_missing_returns_friendly_error() {
        let root = tmp_root();
        let res = load_topic(&root, "myproject", "ghost");
        assert!(res.is_err());
        match res {
            Err(AppError::User { code, .. }) => assert_eq!(code, "canvas_topic_missing"),
            other => panic!("expected user error, got {:?}", other),
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_list_topics_empty_dir() {
        let root = tmp_root();
        let topics = list_topics(&root, "no-such-project").unwrap();
        assert!(topics.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_list_topics_returns_sorted_stems() {
        let root = tmp_root();
        save_topic(&root, "p1", "zeta", "x").unwrap();
        save_topic(&root, "p1", "alpha", "x").unwrap();
        save_topic(&root, "p1", "mid", "x").unwrap();
        let topics = list_topics(&root, "p1").unwrap();
        assert_eq!(topics, vec!["alpha", "mid", "zeta"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_list_projects_returns_sorted_dirs() {
        let root = tmp_root();
        save_topic(&root, "zproj", "a", "x").unwrap();
        save_topic(&root, "aproj", "a", "x").unwrap();
        let projs = list_projects(&root).unwrap();
        assert_eq!(projs, vec!["aproj", "zproj"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_validate_slug_rejects_path_traversal() {
        let root = tmp_root();
        let bad = save_topic(&root, "..", "test", "x");
        assert!(bad.is_err(), "must reject `..` as a project slug");
        let bad2 = save_topic(&root, "ok", "../escape", "x");
        assert!(bad2.is_err(), "must reject `../escape` as a topic slug");
        let bad3 = save_topic(&root, "ok", "with space", "x");
        assert!(bad3.is_err(), "must reject space in slug");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_save_then_load_roundtrip() {
        let root = tmp_root();
        let content = "---\ncanvas_topic: roundtrip\n---\n\n## sticky-abc\n<!-- canvas-meta: {\"x\":10,\"y\":20} -->\n\nhello\n";
        save_topic(&root, "p", "t", content).unwrap();
        let read = load_topic(&root, "p", "t").unwrap();
        assert_eq!(read, content);
        let _ = std::fs::remove_dir_all(&root);
    }
}
