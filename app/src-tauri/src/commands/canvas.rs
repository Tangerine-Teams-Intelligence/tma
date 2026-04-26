//! v1.8 Phase 4-B — Tauri command surface for the canvas ideation surface.
//!
//! Exposed to the React `/canvas` and `/canvas/:project` routes:
//!   * `canvas_list_projects`        — list projects with at least one topic
//!   * `canvas_list_topics(project)` — list topic slugs in a project
//!   * `canvas_load_topic(...)`      — read one topic's markdown
//!   * `canvas_save_topic(...)`      — atomically write a topic's markdown
//!
//! The atomic-write contract matters for the sibling P4-C agent: its AGI
//! peer behaviors run on a heartbeat that may inspect canvas files between
//! React saves. Atomic write (tmp + rename) means a P4-C tick never sees a
//! half-written file.

use std::path::PathBuf;

use crate::agi::canvas;

use super::AppError;

/// Resolve `<home>/.tangerine-memory/`. Mirrors the resolver pattern other
/// Phase 3+ commands use; we don't reach into AppState here because the
/// canvas surface has no shared state — every call is stateless against
/// the filesystem.
fn memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// List every project that has at least one canvas topic on disk. The
/// React `/canvas` index uses this to render the "Project canvases" cards.
#[tauri::command]
pub async fn canvas_list_projects() -> Result<Vec<String>, AppError> {
    let root = memory_root()?;
    canvas::list_projects(&root)
}

/// List the topic slugs in one project. The React project view uses this
/// to populate the topic switcher dropdown.
#[tauri::command]
pub async fn canvas_list_topics(project: String) -> Result<Vec<String>, AppError> {
    let root = memory_root()?;
    canvas::list_topics(&root, &project)
}

/// Read the markdown for one topic. Returns a friendly user-error when
/// the topic doesn't exist (the React side treats missing as the empty
/// state — but the empty state is rendered by the topic-list view, not
/// here, so a load_topic miss is only reachable via stale URL).
#[tauri::command]
pub async fn canvas_load_topic(project: String, topic: String) -> Result<String, AppError> {
    let root = memory_root()?;
    canvas::load_topic(&root, &project, &topic)
}

/// Atomically write a topic's markdown. The React side calls this after
/// every sticky / comment / drag mutation — debouncing happens client-side.
#[tauri::command]
pub async fn canvas_save_topic(
    project: String,
    topic: String,
    content: String,
) -> Result<(), AppError> {
    let root = memory_root()?;
    canvas::save_topic(&root, &project, &topic, &content)
}
