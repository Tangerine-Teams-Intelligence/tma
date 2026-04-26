//! Stage 1 Wave 3 — view-layer commands. Read-only surface that the
//! React UX layer calls into to render `/today`, `/people`, `/projects`,
//! `/threads`, `/alignment`, and `/inbox`.
//!
//! All reads target the sidecar dir at `<memory>/.tangerine/`:
//!   * `timeline.json` — flat index of every atom (id, ts, source, refs, …)
//!   * `cursors/<user>.json` — per-user view/ack/defer state
//!   * `alignment.json` — same-screen rate snapshot
//!   * `briefs/<date>.md` — daily AI brief
//!   * `briefs/pending.md` — pending alerts queue
//!
//! Cursor write commands (`mark_atom_viewed`, `mark_atom_acked`,
//! `mark_atom_opened`) update `cursors/<user>.json` atomically. The schema
//! mirrors `src/tmi/cursors.py::Cursor` so the Python side and Rust side
//! never diverge.
//!
//! Memory-root resolution: the same `<home>/.tangerine-memory/` path the
//! `memory.rs` module exposes via `resolve_memory_root`. We don't refactor
//! that into shared state because each command may be called before the
//! daemon is up, and the resolution is two filesystem syscalls.
//!
//! Stage 2 hook §5: every view in the UI reserves a `<TangerineNotes/>`
//! component slot at the top. Stage 1 ships an empty notes list — the notes
//! field is populated by the reasoning loop that lands in Stage 2. The
//! command surface here returns `notes: []` everywhere as a placeholder so
//! the UI never has to special-case missing data.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use chrono::{Local, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use super::AppError;

/// Default memory root: `<home>/.tangerine-memory/`. Mirrors the helper in
/// `commands::memory` — kept private so callers never need to reach across
/// modules to build the same path.
fn memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// `<root>/.tangerine/` — sidecar with timeline, cursors, alignment, briefs.
fn sidecar_dir(root: &Path) -> PathBuf {
    root.join(".tangerine")
}

fn timeline_index_path(root: &Path) -> PathBuf {
    sidecar_dir(root).join("timeline.json")
}

fn alignment_path(root: &Path) -> PathBuf {
    sidecar_dir(root).join("alignment.json")
}

fn cursors_dir(root: &Path) -> PathBuf {
    sidecar_dir(root).join("cursors")
}

fn cursor_file_path(root: &Path, user: &str) -> Result<PathBuf, AppError> {
    if !is_valid_alias(user) {
        return Err(AppError::user(
            "bad_alias",
            format!("user alias must match [a-z][a-z0-9_]*, got {user:?}"),
        ));
    }
    Ok(cursors_dir(root).join(format!("{user}.json")))
}

fn briefs_dir(root: &Path) -> PathBuf {
    root.join("briefs")
}

fn brief_file_path(root: &Path, date: &str) -> Result<PathBuf, AppError> {
    if NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
        return Err(AppError::user(
            "bad_date",
            format!("date must be YYYY-MM-DD, got {date:?}"),
        ));
    }
    Ok(briefs_dir(root).join(format!("{date}.md")))
}

fn pending_alerts_path(root: &Path) -> PathBuf {
    briefs_dir(root).join("pending.md")
}

fn is_valid_alias(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let mut chars = s.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_lowercase() {
        return false;
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

// Atomic write: tmp + rename. Mirrors `tmi.utils.atomic_write_text`.
fn atomic_write(path: &Path, body: &str) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let tmp = path.with_extension(format!(
        "tmp.{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&tmp, body)
        .map_err(|e| AppError::internal("atomic_write", format!("write tmp: {e}")))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::internal("atomic_write", format!("rename: {e}")))?;
    Ok(())
}

// --------------------------------------------------------------------------
// Timeline events — read sidecar/timeline.json and slice by date / filters.

/// One row of the chronological feed. Matches `Event::to_index_record` on the
/// Python side. We're permissive on the shape (passes through unknown keys)
/// so a Python schema bump doesn't break the Tauri command surface.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TimelineEvent {
    pub id: String,
    pub ts: String,
    pub source: String,
    pub actor: String,
    #[serde(default)]
    pub actors: Vec<String>,
    pub kind: String,
    #[serde(default)]
    pub refs: serde_json::Value,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub line: Option<u64>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub lifecycle: Option<serde_json::Value>,
    #[serde(default)]
    pub sample: bool,

    // Stage 2 hooks — Stage 1 carries defaults. The wire encoding always
    // surfaces them so downstream React doesn't have to special-case
    // their presence.
    #[serde(default = "default_confidence")]
    pub confidence: f32,
    #[serde(default)]
    pub concepts: Vec<String>,
    #[serde(default)]
    pub alternatives: Vec<serde_json::Value>,
    #[serde(default = "default_source_count")]
    pub source_count: u32,
}

fn default_confidence() -> f32 {
    1.0
}
fn default_source_count() -> u32 {
    1
}

#[derive(Debug, Serialize)]
pub struct TimelineSliceOut {
    pub date: String,
    pub events: Vec<TimelineEvent>,
    /// Stage 2 hook §5 — empty in Stage 1.
    pub notes: Vec<serde_json::Value>,
}

/// Load `timeline.json` from disk. Returns `Vec<TimelineEvent>` (possibly
/// empty) — never panics, never errors on a missing file.
fn load_all_events(root: &Path) -> Vec<TimelineEvent> {
    let p = timeline_index_path(root);
    let Ok(raw) = std::fs::read_to_string(&p) else {
        return vec![];
    };
    let Ok(idx) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return vec![];
    };
    let Some(arr) = idx.get("events").and_then(|v| v.as_array()) else {
        return vec![];
    };
    arr.iter()
        .filter_map(|v| serde_json::from_value::<TimelineEvent>(v.clone()).ok())
        .collect()
}

#[tauri::command]
pub async fn read_timeline_today(date: Option<String>) -> Result<TimelineSliceOut, AppError> {
    let root = memory_root()?;
    let date_str = match date {
        Some(d) => d,
        None => Local::now().format("%Y-%m-%d").to_string(),
    };
    let mut events: Vec<TimelineEvent> = load_all_events(&root)
        .into_iter()
        .filter(|e| e.ts.starts_with(&date_str))
        .collect();
    // Sort ascending (chronological). The UI flips for reverse-chrono rails.
    events.sort_by(|a, b| a.ts.cmp(&b.ts));
    Ok(TimelineSliceOut {
        date: date_str,
        events,
        notes: vec![],
    })
}

#[derive(Debug, Serialize)]
pub struct TimelineRecentOut {
    pub events: Vec<TimelineEvent>,
    pub notes: Vec<serde_json::Value>,
}

/// Reverse-chronological feed used by the right-rail ActivityFeed and the
/// /this-week aggregation. Caps at `limit` (default 200).
#[tauri::command]
pub async fn read_timeline_recent(limit: Option<usize>) -> Result<TimelineRecentOut, AppError> {
    let root = memory_root()?;
    let limit = limit.unwrap_or(200).clamp(1, 2000);
    let mut events = load_all_events(&root);
    events.sort_by(|a, b| b.ts.cmp(&a.ts));
    events.truncate(limit);
    Ok(TimelineRecentOut {
        events,
        notes: vec![],
    })
}

// --------------------------------------------------------------------------
// Aggregations: people, projects, threads.

#[derive(Debug, Serialize)]
pub struct PersonRow {
    pub alias: String,
    /// Most recent atom ts where this user appears in `actors` or `actor`.
    pub last_active: Option<String>,
    pub atom_count: u32,
    /// Stage 2: same-screen rate per user. Stage 1 = null when no cursor.
    pub same_screen_rate: Option<f32>,
}

#[derive(Debug, Serialize)]
pub struct PersonListOut {
    pub people: Vec<PersonRow>,
    pub notes: Vec<serde_json::Value>,
}

fn collect_person_aliases(ev: &TimelineEvent, out: &mut BTreeSet<String>) {
    if !ev.actor.is_empty() {
        out.insert(ev.actor.clone());
    }
    for a in &ev.actors {
        if !a.is_empty() {
            out.insert(a.clone());
        }
    }
    if let Some(map) = ev.refs.as_object() {
        if let Some(p) = map.get("people").and_then(|v| v.as_array()) {
            for item in p {
                if let Some(s) = item.as_str() {
                    if !s.is_empty() {
                        out.insert(s.to_string());
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub async fn read_people_list() -> Result<PersonListOut, AppError> {
    let root = memory_root()?;
    let events = load_all_events(&root);
    let mut by_alias: BTreeMap<String, (Option<String>, u32)> = BTreeMap::new();
    for ev in &events {
        if ev.sample {
            continue;
        }
        let mut who: BTreeSet<String> = BTreeSet::new();
        collect_person_aliases(ev, &mut who);
        for a in who {
            let entry = by_alias.entry(a).or_insert((None, 0));
            entry.1 += 1;
            entry.0 = match entry.0.take() {
                Some(prev) if prev > ev.ts => Some(prev),
                _ => Some(ev.ts.clone()),
            };
        }
    }
    let mut rows: Vec<PersonRow> = by_alias
        .into_iter()
        .map(|(alias, (last_active, atom_count))| PersonRow {
            alias,
            last_active,
            atom_count,
            same_screen_rate: None,
        })
        .collect();
    rows.sort_by(|a, b| b.last_active.cmp(&a.last_active).then(a.alias.cmp(&b.alias)));
    Ok(PersonListOut {
        people: rows,
        notes: vec![],
    })
}

#[derive(Debug, Serialize)]
pub struct PersonDetailOut {
    pub alias: String,
    pub recent_events: Vec<TimelineEvent>,
    pub mentioned_projects: Vec<String>,
    pub mentioned_threads: Vec<String>,
    pub notes: Vec<serde_json::Value>,
}

#[tauri::command]
pub async fn read_person(alias: String) -> Result<PersonDetailOut, AppError> {
    if !is_valid_alias(&alias) {
        return Err(AppError::user(
            "bad_alias",
            format!("alias must be lowercase letters/digits/_, got {alias:?}"),
        ));
    }
    let root = memory_root()?;
    let mut events: Vec<TimelineEvent> = load_all_events(&root)
        .into_iter()
        .filter(|ev| {
            if ev.sample {
                return false;
            }
            let mut s: BTreeSet<String> = BTreeSet::new();
            collect_person_aliases(ev, &mut s);
            s.contains(&alias)
        })
        .collect();
    events.sort_by(|a, b| b.ts.cmp(&a.ts));
    // Last 30 days slice.
    let cutoff = (Utc::now() - chrono::Duration::days(30))
        .format("%Y-%m-%d")
        .to_string();
    let recent: Vec<TimelineEvent> = events
        .iter()
        .filter(|ev| ev.ts.as_str() >= cutoff.as_str())
        .cloned()
        .take(60)
        .collect();
    let mut projects: BTreeSet<String> = BTreeSet::new();
    let mut threads: BTreeSet<String> = BTreeSet::new();
    for ev in &events {
        if let Some(map) = ev.refs.as_object() {
            if let Some(arr) = map.get("projects").and_then(|v| v.as_array()) {
                for v in arr {
                    if let Some(s) = v.as_str() {
                        projects.insert(s.to_string());
                    }
                }
            }
            if let Some(arr) = map.get("threads").and_then(|v| v.as_array()) {
                for v in arr {
                    if let Some(s) = v.as_str() {
                        threads.insert(s.to_string());
                    }
                }
            }
        }
    }
    Ok(PersonDetailOut {
        alias,
        recent_events: recent,
        mentioned_projects: projects.into_iter().collect(),
        mentioned_threads: threads.into_iter().collect(),
        notes: vec![],
    })
}

// ---- projects ----

#[derive(Debug, Serialize)]
pub struct ProjectRow {
    pub slug: String,
    pub last_active: Option<String>,
    pub atom_count: u32,
    pub member_count: u32,
}

#[derive(Debug, Serialize)]
pub struct ProjectListOut {
    pub projects: Vec<ProjectRow>,
    pub notes: Vec<serde_json::Value>,
}

fn collect_project_slugs(ev: &TimelineEvent, out: &mut BTreeSet<String>) {
    if let Some(map) = ev.refs.as_object() {
        if let Some(arr) = map.get("projects").and_then(|v| v.as_array()) {
            for v in arr {
                if let Some(s) = v.as_str() {
                    if !s.is_empty() {
                        out.insert(s.to_string());
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub async fn read_projects_list() -> Result<ProjectListOut, AppError> {
    let root = memory_root()?;
    let events = load_all_events(&root);
    let mut by_slug: BTreeMap<String, (Option<String>, u32, BTreeSet<String>)> = BTreeMap::new();
    for ev in &events {
        if ev.sample {
            continue;
        }
        let mut slugs: BTreeSet<String> = BTreeSet::new();
        collect_project_slugs(ev, &mut slugs);
        for slug in slugs {
            let entry = by_slug.entry(slug).or_insert((None, 0, BTreeSet::new()));
            entry.1 += 1;
            entry.0 = match entry.0.take() {
                Some(prev) if prev > ev.ts => Some(prev),
                _ => Some(ev.ts.clone()),
            };
            let mut who: BTreeSet<String> = BTreeSet::new();
            collect_person_aliases(ev, &mut who);
            entry.2.extend(who);
        }
    }
    let mut rows: Vec<ProjectRow> = by_slug
        .into_iter()
        .map(|(slug, (last_active, atom_count, members))| ProjectRow {
            slug,
            last_active,
            atom_count,
            member_count: members.len() as u32,
        })
        .collect();
    rows.sort_by(|a, b| b.last_active.cmp(&a.last_active).then(a.slug.cmp(&b.slug)));
    Ok(ProjectListOut {
        projects: rows,
        notes: vec![],
    })
}

#[derive(Debug, Serialize)]
pub struct ProjectDetailOut {
    pub slug: String,
    pub recent_events: Vec<TimelineEvent>,
    pub members: Vec<String>,
    pub threads: Vec<String>,
    pub notes: Vec<serde_json::Value>,
}

#[tauri::command]
pub async fn read_project(slug: String) -> Result<ProjectDetailOut, AppError> {
    let root = memory_root()?;
    let mut matching: Vec<TimelineEvent> = load_all_events(&root)
        .into_iter()
        .filter(|ev| {
            if ev.sample {
                return false;
            }
            let mut s: BTreeSet<String> = BTreeSet::new();
            collect_project_slugs(ev, &mut s);
            s.contains(&slug)
        })
        .collect();
    matching.sort_by(|a, b| b.ts.cmp(&a.ts));
    let mut members: BTreeSet<String> = BTreeSet::new();
    let mut threads: BTreeSet<String> = BTreeSet::new();
    for ev in &matching {
        collect_person_aliases(ev, &mut members);
        if let Some(map) = ev.refs.as_object() {
            if let Some(arr) = map.get("threads").and_then(|v| v.as_array()) {
                for v in arr {
                    if let Some(s) = v.as_str() {
                        threads.insert(s.to_string());
                    }
                }
            }
        }
    }
    let recent: Vec<TimelineEvent> = matching.iter().cloned().take(60).collect();
    Ok(ProjectDetailOut {
        slug,
        recent_events: recent,
        members: members.into_iter().collect(),
        threads: threads.into_iter().collect(),
        notes: vec![],
    })
}

// ---- threads ----

#[derive(Debug, Serialize)]
pub struct ThreadRow {
    pub topic: String,
    pub last_active: Option<String>,
    pub atom_count: u32,
}

#[derive(Debug, Serialize)]
pub struct ThreadListOut {
    pub threads: Vec<ThreadRow>,
    pub notes: Vec<serde_json::Value>,
}

fn collect_thread_topics(ev: &TimelineEvent, out: &mut BTreeSet<String>) {
    if let Some(map) = ev.refs.as_object() {
        if let Some(arr) = map.get("threads").and_then(|v| v.as_array()) {
            for v in arr {
                if let Some(s) = v.as_str() {
                    if !s.is_empty() {
                        out.insert(s.to_string());
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub async fn read_threads_list() -> Result<ThreadListOut, AppError> {
    let root = memory_root()?;
    let events = load_all_events(&root);
    let mut by_topic: BTreeMap<String, (Option<String>, u32)> = BTreeMap::new();
    for ev in &events {
        if ev.sample {
            continue;
        }
        let mut topics: BTreeSet<String> = BTreeSet::new();
        collect_thread_topics(ev, &mut topics);
        for t in topics {
            let entry = by_topic.entry(t).or_insert((None, 0));
            entry.1 += 1;
            entry.0 = match entry.0.take() {
                Some(prev) if prev > ev.ts => Some(prev),
                _ => Some(ev.ts.clone()),
            };
        }
    }
    let mut rows: Vec<ThreadRow> = by_topic
        .into_iter()
        .map(|(topic, (last_active, atom_count))| ThreadRow {
            topic,
            last_active,
            atom_count,
        })
        .collect();
    rows.sort_by(|a, b| b.last_active.cmp(&a.last_active).then(a.topic.cmp(&b.topic)));
    Ok(ThreadListOut {
        threads: rows,
        notes: vec![],
    })
}

#[derive(Debug, Serialize)]
pub struct ThreadDetailOut {
    pub topic: String,
    pub events: Vec<TimelineEvent>,
    pub members: Vec<String>,
    pub notes: Vec<serde_json::Value>,
}

#[tauri::command]
pub async fn read_thread(topic: String) -> Result<ThreadDetailOut, AppError> {
    let root = memory_root()?;
    let mut events: Vec<TimelineEvent> = load_all_events(&root)
        .into_iter()
        .filter(|ev| {
            if ev.sample {
                return false;
            }
            let mut s: BTreeSet<String> = BTreeSet::new();
            collect_thread_topics(ev, &mut s);
            s.contains(&topic)
        })
        .collect();
    events.sort_by(|a, b| a.ts.cmp(&b.ts));
    let mut members: BTreeSet<String> = BTreeSet::new();
    for ev in &events {
        collect_person_aliases(ev, &mut members);
    }
    Ok(ThreadDetailOut {
        topic,
        events,
        members: members.into_iter().collect(),
        notes: vec![],
    })
}

// --------------------------------------------------------------------------
// Briefs + alignment + pending alerts.

#[derive(Debug, Serialize)]
pub struct BriefOut {
    pub date: String,
    pub markdown: Option<String>,
    pub exists: bool,
    pub notes: Vec<serde_json::Value>,
}

#[tauri::command]
pub async fn read_brief(date: Option<String>) -> Result<BriefOut, AppError> {
    let root = memory_root()?;
    let date_str = match date {
        Some(d) => d,
        None => Local::now().format("%Y-%m-%d").to_string(),
    };
    let path = brief_file_path(&root, &date_str)?;
    let (md, exists) = match std::fs::read_to_string(&path) {
        Ok(s) => (Some(s), true),
        Err(_) => (None, false),
    };
    Ok(BriefOut {
        date: date_str,
        markdown: md,
        exists,
        notes: vec![],
    })
}

#[derive(Debug, Serialize)]
pub struct AlignmentSnapshot {
    pub computed_at: Option<String>,
    pub users: Vec<String>,
    pub total_atoms: u32,
    pub shared_viewed: u32,
    pub rate: f32,
    pub per_user_seen: BTreeMap<String, u32>,
}

#[derive(Debug, Serialize)]
pub struct AlignmentOut {
    pub latest: AlignmentSnapshot,
    pub history: Vec<AlignmentSnapshot>,
    pub notes: Vec<serde_json::Value>,
}

fn empty_snapshot() -> AlignmentSnapshot {
    AlignmentSnapshot {
        computed_at: None,
        users: vec![],
        total_atoms: 0,
        shared_viewed: 0,
        rate: 0.0,
        per_user_seen: BTreeMap::new(),
    }
}

fn parse_snapshot(v: &serde_json::Value) -> AlignmentSnapshot {
    let computed_at = v
        .get("computed_at")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let users = v
        .get("users")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let total_atoms = v
        .get("total_atoms")
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    let shared_viewed = v
        .get("shared_viewed")
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    let rate = v.get("rate").and_then(|x| x.as_f64()).unwrap_or(0.0) as f32;
    let mut per_user_seen: BTreeMap<String, u32> = BTreeMap::new();
    if let Some(map) = v.get("per_user_seen").and_then(|x| x.as_object()) {
        for (k, val) in map {
            if let Some(n) = val.as_u64() {
                per_user_seen.insert(k.clone(), n as u32);
            }
        }
    }
    AlignmentSnapshot {
        computed_at,
        users,
        total_atoms,
        shared_viewed,
        rate,
        per_user_seen,
    }
}

#[tauri::command]
pub async fn read_alignment() -> Result<AlignmentOut, AppError> {
    let root = memory_root()?;
    let p = alignment_path(&root);
    let raw = match std::fs::read_to_string(&p) {
        Ok(s) => s,
        Err(_) => {
            return Ok(AlignmentOut {
                latest: empty_snapshot(),
                history: vec![],
                notes: vec![],
            });
        }
    };
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(j) => j,
        Err(_) => {
            return Ok(AlignmentOut {
                latest: empty_snapshot(),
                history: vec![],
                notes: vec![],
            });
        }
    };
    let latest = v
        .get("latest")
        .map(parse_snapshot)
        .unwrap_or_else(empty_snapshot);
    let history: Vec<AlignmentSnapshot> = v
        .get("history")
        .and_then(|x| x.as_array())
        .map(|arr| arr.iter().map(parse_snapshot).collect())
        .unwrap_or_default();
    Ok(AlignmentOut {
        latest,
        history,
        notes: vec![],
    })
}

/// One inbox row parsed out of `briefs/pending.md`. The pending file is
/// markdown for human readability; we parse `## ` headers as alert blocks
/// and pull the metadata out of the bullet list under each header.
#[derive(Debug, Default, Serialize)]
pub struct PendingAlert {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub created_at: Option<String>,
    pub due_at: Option<String>,
    pub severity: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PendingAlertsOut {
    pub alerts: Vec<PendingAlert>,
    pub notes: Vec<serde_json::Value>,
}

fn parse_pending_md(text: &str) -> Vec<PendingAlert> {
    let mut out: Vec<PendingAlert> = vec![];
    let mut cur: Option<PendingAlert> = None;
    let mut body_lines: Vec<String> = vec![];
    for raw_line in text.lines() {
        let line = raw_line.trim_end();
        if let Some(rest) = line.strip_prefix("## ") {
            if let Some(mut a) = cur.take() {
                a.body = body_lines.join("\n").trim().to_string();
                if a.id.is_empty() {
                    a.id = format!("alert-{}", out.len() + 1);
                }
                out.push(a);
                body_lines.clear();
            }
            cur = Some(PendingAlert {
                title: rest.to_string(),
                ..Default::default()
            });
            continue;
        }
        if let Some(a) = cur.as_mut() {
            if let Some(rest) = line.strip_prefix("- ") {
                if let Some((k, v)) = rest.split_once(": ") {
                    let k = k.trim();
                    let v = v.trim();
                    match k {
                        "id" => a.id = v.to_string(),
                        "kind" => a.kind = v.to_string(),
                        "created_at" => a.created_at = Some(v.to_string()),
                        "due_at" | "review_by" => a.due_at = Some(v.to_string()),
                        "severity" => a.severity = Some(v.to_string()),
                        _ => body_lines.push(line.to_string()),
                    }
                    continue;
                }
            }
            // Skip pure blank-line gaps in body collection.
            if !line.is_empty() {
                body_lines.push(line.to_string());
            }
        }
    }
    if let Some(mut a) = cur.take() {
        a.body = body_lines.join("\n").trim().to_string();
        if a.id.is_empty() {
            a.id = format!("alert-{}", out.len() + 1);
        }
        out.push(a);
    }
    out
}

#[tauri::command]
pub async fn read_pending_alerts() -> Result<PendingAlertsOut, AppError> {
    let root = memory_root()?;
    let p = pending_alerts_path(&root);
    let raw = std::fs::read_to_string(&p).unwrap_or_default();
    let alerts = parse_pending_md(&raw);
    Ok(PendingAlertsOut {
        alerts,
        notes: vec![],
    })
}

// --------------------------------------------------------------------------
// Cursor writes — mark_atom_viewed / mark_atom_acked / mark_atom_opened.
//
// Format mirrors `src/tmi/cursors.py::Cursor.to_dict`. We never invent
// fields the Python side doesn't already carry; the React store reads the
// Python schema by way of these commands.

#[derive(Debug, Default, Serialize, Deserialize)]
struct CursorJson {
    user: String,
    last_opened_at: Option<String>,
    #[serde(default)]
    atoms_viewed: BTreeMap<String, String>,
    #[serde(default)]
    atoms_acked: BTreeMap<String, String>,
    #[serde(default)]
    atoms_deferred: BTreeMap<String, String>,
    #[serde(default)]
    thread_cursor: BTreeMap<String, String>,
    #[serde(default = "default_preferences")]
    preferences: serde_json::Value,
}

fn default_preferences() -> serde_json::Value {
    serde_json::json!({
        "brief_style": "default",
        "brief_time": "08:00",
        "notification_channels": ["os", "email"],
        "topics_of_interest": [],
        "topics_to_skip": [],
    })
}

fn load_cursor(root: &Path, user: &str) -> Result<CursorJson, AppError> {
    let path = cursor_file_path(root, user)?;
    if !path.exists() {
        return Ok(CursorJson {
            user: user.to_string(),
            last_opened_at: None,
            atoms_viewed: BTreeMap::new(),
            atoms_acked: BTreeMap::new(),
            atoms_deferred: BTreeMap::new(),
            thread_cursor: BTreeMap::new(),
            preferences: default_preferences(),
        });
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| AppError::internal("cursor_read", e.to_string()))?;
    let mut c: CursorJson = serde_json::from_str(&raw).unwrap_or(CursorJson {
        user: user.to_string(),
        last_opened_at: None,
        atoms_viewed: BTreeMap::new(),
        atoms_acked: BTreeMap::new(),
        atoms_deferred: BTreeMap::new(),
        thread_cursor: BTreeMap::new(),
        preferences: default_preferences(),
    });
    c.user = user.to_string();
    Ok(c)
}

fn save_cursor(root: &Path, c: &CursorJson) -> Result<(), AppError> {
    let path = cursor_file_path(root, &c.user)?;
    let body = serde_json::to_string_pretty(c)
        .map_err(|e| AppError::internal("cursor_write", e.to_string()))?;
    atomic_write(&path, &body)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn validate_atom_id(id: &str) -> Result<(), AppError> {
    // evt-YYYY-MM-DD-<hex>+ — same shape as the Python ATOM_ID_RE.
    if !id.starts_with("evt-") {
        return Err(AppError::user("bad_atom_id", format!("got {id:?}")));
    }
    let body = &id[4..];
    if body.len() < 12 {
        return Err(AppError::user("bad_atom_id", format!("got {id:?}")));
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct CursorOut {
    pub user: String,
    pub last_opened_at: Option<String>,
    pub atoms_viewed_count: u32,
    pub atoms_acked_count: u32,
}

fn cursor_summary(c: &CursorJson) -> CursorOut {
    CursorOut {
        user: c.user.clone(),
        last_opened_at: c.last_opened_at.clone(),
        atoms_viewed_count: c.atoms_viewed.len() as u32,
        atoms_acked_count: c.atoms_acked.len() as u32,
    }
}

#[tauri::command]
pub async fn mark_atom_viewed(user: String, atom_id: String) -> Result<CursorOut, AppError> {
    validate_atom_id(&atom_id)?;
    let root = memory_root()?;
    let mut c = load_cursor(&root, &user)?;
    c.atoms_viewed.entry(atom_id).or_insert_with(now_iso);
    save_cursor(&root, &c)?;
    Ok(cursor_summary(&c))
}

#[tauri::command]
pub async fn mark_atom_acked(user: String, atom_id: String) -> Result<CursorOut, AppError> {
    validate_atom_id(&atom_id)?;
    let root = memory_root()?;
    let mut c = load_cursor(&root, &user)?;
    let now = now_iso();
    c.atoms_acked.insert(atom_id.clone(), now.clone());
    c.atoms_viewed.entry(atom_id).or_insert(now);
    save_cursor(&root, &c)?;
    Ok(cursor_summary(&c))
}

#[tauri::command]
pub async fn mark_user_opened(user: String) -> Result<CursorOut, AppError> {
    let root = memory_root()?;
    let mut c = load_cursor(&root, &user)?;
    c.last_opened_at = Some(now_iso());
    save_cursor(&root, &c)?;
    Ok(cursor_summary(&c))
}

#[derive(Debug, Serialize)]
pub struct CursorReadOut {
    pub user: String,
    pub last_opened_at: Option<String>,
    pub viewed: Vec<String>,
    pub acked: Vec<String>,
    pub deferred: Vec<String>,
    pub preferences: serde_json::Value,
}

#[tauri::command]
pub async fn read_cursor(user: String) -> Result<CursorReadOut, AppError> {
    let root = memory_root()?;
    let c = load_cursor(&root, &user)?;
    Ok(CursorReadOut {
        user: c.user,
        last_opened_at: c.last_opened_at,
        viewed: c.atoms_viewed.into_keys().collect(),
        acked: c.atoms_acked.into_keys().collect(),
        deferred: c.atoms_deferred.into_keys().collect(),
        preferences: c.preferences,
    })
}

// --------------------------------------------------------------------------
// "What's new since you looked" diff.

#[derive(Debug, Serialize)]
pub struct WhatsNewOut {
    pub since: Option<String>,
    pub new_events: Vec<TimelineEvent>,
    pub count: u32,
    pub notes: Vec<serde_json::Value>,
}

/// Atoms newer than the cursor's `last_opened_at` AND not in `atoms_viewed`.
/// Drives the yellow "📌 N new atoms since you last looked" startup banner.
#[tauri::command]
pub async fn read_whats_new(user: String) -> Result<WhatsNewOut, AppError> {
    let root = memory_root()?;
    let c = load_cursor(&root, &user)?;
    let threshold = c.last_opened_at.clone();
    let viewed = c.atoms_viewed;
    let mut new_events: Vec<TimelineEvent> = load_all_events(&root)
        .into_iter()
        .filter(|ev| {
            if ev.sample {
                return false;
            }
            if viewed.contains_key(&ev.id) {
                return false;
            }
            if let Some(t) = threshold.as_deref() {
                if ev.ts.as_str() <= t {
                    return false;
                }
            }
            true
        })
        .collect();
    new_events.sort_by(|a, b| b.ts.cmp(&a.ts));
    let count = new_events.len() as u32;
    Ok(WhatsNewOut {
        since: threshold,
        new_events,
        count,
        notes: vec![],
    })
}

// --------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tg_views_{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(dir.join(".tangerine")).unwrap();
        fs::create_dir_all(dir.join("briefs")).unwrap();
        dir
    }

    fn write_index(root: &Path, events: &[serde_json::Value]) {
        let body = serde_json::json!({
            "version": 1,
            "events": events,
            "vector_store": { "type": "none", "dimensions": null, "model": null }
        });
        std::fs::write(
            root.join(".tangerine").join("timeline.json"),
            serde_json::to_string(&body).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn parses_pending_md_with_two_alerts() {
        let md = "## Stale decision: pricing\n- id: alert-1\n- kind: stale\n- created_at: 2026-04-22T10:00:00Z\n- due_at: 2026-04-25T10:00:00Z\n- severity: high\n\nthe pricing thread hasn't moved since the 22nd\n\n## Overdue: ship discord prototype\n- id: alert-2\n- kind: overdue\n- created_at: 2026-04-21T10:00:00Z\nbody describing the overdue work";
        let alerts = parse_pending_md(md);
        assert_eq!(alerts.len(), 2);
        assert_eq!(alerts[0].id, "alert-1");
        assert_eq!(alerts[0].kind, "stale");
        assert_eq!(alerts[0].title, "Stale decision: pricing");
        assert_eq!(alerts[0].severity.as_deref(), Some("high"));
        assert!(alerts[0].body.contains("hasn't moved"));
        assert_eq!(alerts[1].id, "alert-2");
        assert_eq!(alerts[1].kind, "overdue");
    }

    #[test]
    fn parses_pending_md_empty() {
        assert!(parse_pending_md("").is_empty());
        assert!(parse_pending_md("\n\n").is_empty());
    }

    #[test]
    fn alias_validation_accepts_lowercase_with_digits_and_underscore() {
        assert!(is_valid_alias("daizhe"));
        assert!(is_valid_alias("u123"));
        assert!(is_valid_alias("d_z"));
    }

    #[test]
    fn alias_validation_rejects_bad_inputs() {
        assert!(!is_valid_alias(""));
        assert!(!is_valid_alias("Daizhe"));
        assert!(!is_valid_alias("1user"));
        assert!(!is_valid_alias("d-z"));
        assert!(!is_valid_alias("../etc/passwd"));
    }

    #[test]
    fn validate_atom_id_accepts_real_shape() {
        assert!(validate_atom_id("evt-2026-04-25-aBc1234567").is_ok());
        assert!(validate_atom_id("evt-2026-04-25-fff0000000").is_ok());
    }

    #[test]
    fn validate_atom_id_rejects_garbage() {
        assert!(validate_atom_id("not-an-id").is_err());
        assert!(validate_atom_id("evt-").is_err());
        assert!(validate_atom_id("evt-2026-04").is_err());
    }

    #[test]
    fn brief_path_rejects_bad_date() {
        let root = tmp_root();
        assert!(brief_file_path(&root, "not-a-date").is_err());
        assert!(brief_file_path(&root, "2026-13-99").is_err());
        assert!(brief_file_path(&root, "2026-04-25").is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cursor_summary_returns_counts() {
        let mut c = CursorJson {
            user: "u1".into(),
            last_opened_at: Some("2026-04-25T10:00:00Z".into()),
            atoms_viewed: BTreeMap::new(),
            atoms_acked: BTreeMap::new(),
            atoms_deferred: BTreeMap::new(),
            thread_cursor: BTreeMap::new(),
            preferences: default_preferences(),
        };
        c.atoms_viewed.insert("evt-2026-04-25-1".into(), "ts".into());
        c.atoms_viewed.insert("evt-2026-04-25-2".into(), "ts".into());
        c.atoms_acked.insert("evt-2026-04-25-1".into(), "ts".into());
        let s = cursor_summary(&c);
        assert_eq!(s.user, "u1");
        assert_eq!(s.atoms_viewed_count, 2);
        assert_eq!(s.atoms_acked_count, 1);
    }

    #[test]
    fn empty_snapshot_has_zero_rate() {
        let s = empty_snapshot();
        assert_eq!(s.rate, 0.0);
        assert_eq!(s.total_atoms, 0);
        assert!(s.users.is_empty());
    }

    #[test]
    fn parse_snapshot_handles_full_payload() {
        let v = serde_json::json!({
            "computed_at": "2026-04-25T08:00:00Z",
            "users": ["daizhe", "eric"],
            "total_atoms": 100,
            "shared_viewed": 75,
            "rate": 0.75,
            "per_user_seen": { "daizhe": 90, "eric": 80 }
        });
        let s = parse_snapshot(&v);
        assert_eq!(s.users.len(), 2);
        assert_eq!(s.total_atoms, 100);
        assert_eq!(s.shared_viewed, 75);
        assert_eq!(s.rate, 0.75);
        assert_eq!(s.per_user_seen.get("daizhe").copied(), Some(90));
    }

    #[test]
    fn parse_snapshot_handles_missing_fields() {
        let v = serde_json::json!({});
        let s = parse_snapshot(&v);
        assert_eq!(s.rate, 0.0);
        assert_eq!(s.total_atoms, 0);
        assert!(s.users.is_empty());
    }

    #[test]
    fn collect_person_aliases_pulls_actor_actors_and_refs() {
        let ev: TimelineEvent = serde_json::from_value(serde_json::json!({
            "id": "evt-2026-04-25-aaa1112222",
            "ts": "2026-04-25T10:00:00Z",
            "source": "discord",
            "actor": "daizhe",
            "actors": ["daizhe", "eric"],
            "kind": "meeting_chunk",
            "refs": {"people": ["sarah"]},
            "status": "active"
        }))
        .unwrap();
        let mut s: BTreeSet<String> = BTreeSet::new();
        collect_person_aliases(&ev, &mut s);
        assert!(s.contains("daizhe"));
        assert!(s.contains("eric"));
        assert!(s.contains("sarah"));
        assert_eq!(s.len(), 3);
    }

    #[test]
    fn collect_project_slugs_and_threads_pull_from_refs() {
        let ev: TimelineEvent = serde_json::from_value(serde_json::json!({
            "id": "evt-2026-04-25-bbb1112222",
            "ts": "2026-04-25T10:00:00Z",
            "source": "github",
            "actor": "eric",
            "actors": [],
            "kind": "pr_event",
            "refs": {"projects": ["v1-launch", "rms"], "threads": ["pr-47"]},
            "status": "active"
        }))
        .unwrap();
        let mut p: BTreeSet<String> = BTreeSet::new();
        collect_project_slugs(&ev, &mut p);
        assert_eq!(p.len(), 2);
        let mut t: BTreeSet<String> = BTreeSet::new();
        collect_thread_topics(&ev, &mut t);
        assert!(t.contains("pr-47"));
    }

    #[tokio::test]
    async fn cursor_lifecycle_writes_and_reads() {
        let root = tmp_root();
        std::env::set_var("HOME", &root);
        std::env::set_var("USERPROFILE", &root);
        // Write a fresh cursor.
        let user = "u1".to_string();
        let mut c = CursorJson {
            user: user.clone(),
            last_opened_at: None,
            atoms_viewed: BTreeMap::new(),
            atoms_acked: BTreeMap::new(),
            atoms_deferred: BTreeMap::new(),
            thread_cursor: BTreeMap::new(),
            preferences: default_preferences(),
        };
        c.last_opened_at = Some(now_iso());
        save_cursor(&root, &c).unwrap();
        let loaded = load_cursor(&root, &user).unwrap();
        assert_eq!(loaded.user, user);
        assert!(loaded.last_opened_at.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn load_all_events_returns_empty_on_missing_file() {
        let root = tmp_root();
        let evs = load_all_events(&root);
        assert!(evs.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn load_all_events_returns_empty_on_garbage_json() {
        let root = tmp_root();
        std::fs::write(
            root.join(".tangerine").join("timeline.json"),
            "{not json",
        )
        .unwrap();
        let evs = load_all_events(&root);
        assert!(evs.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn load_all_events_parses_index_with_events() {
        let root = tmp_root();
        write_index(
            &root,
            &[serde_json::json!({
                "id": "evt-2026-04-25-a1b2c3d4e5",
                "ts": "2026-04-25T10:00:00Z",
                "source": "discord",
                "actor": "daizhe",
                "actors": ["daizhe"],
                "kind": "meeting_chunk",
                "refs": {},
                "status": "active",
                "file": "timeline/2026-04-25.md",
                "line": 1
            })],
        );
        let evs = load_all_events(&root);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].source, "discord");
        // Stage 2 hook defaults applied.
        assert_eq!(evs[0].confidence, 1.0);
        assert_eq!(evs[0].source_count, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn timeline_event_carries_stage2_hook_defaults() {
        let v = serde_json::json!({
            "id": "evt-2026-04-25-aaaaaaaaaa",
            "ts": "2026-04-25T10:00:00Z",
            "source": "discord",
            "actor": "daizhe",
            "kind": "meeting_chunk",
            "refs": {},
            "status": "active"
        });
        let ev: TimelineEvent = serde_json::from_value(v).unwrap();
        assert_eq!(ev.confidence, 1.0);
        assert_eq!(ev.source_count, 1);
        assert!(ev.concepts.is_empty());
        assert!(ev.alternatives.is_empty());
    }
}
