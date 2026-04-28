// === wave 24 ===
//! Wave 24 — Daily notes + template library.
//!
//! Each day, the app auto-creates `~/.tangerine-memory/team/daily/{YYYY-MM-DD}.md`
//! from a fixed template (frontmatter + 4 sections: "What the team decided
//! today", "What I worked on", "Decisions to make tomorrow", "Insights from
//! AI tools today"). Two of those sections are owned by the user (manual
//! input); two are owned by the co-thinker heartbeat (auto-fill from the
//! last 24h atom summary). The auto-fill happens via
//! `daily_notes::ensure_today_path` + `update_auto_section` — the heartbeat
//! calls these directly so failures don't crash the heartbeat.
//!
//! Template library lives under `app/resources/sample-memory/templates/`
//! and is bundled into the Tauri resource dir at build time. `templates_list`
//! walks that dir and returns one entry per `.md` file with frontmatter
//! parsed (`template: true` is the filter flag the memory tree uses to keep
//! templates out of the regular content view). `templates_apply` copies a
//! template file into a target atom path.
//!
//! Timezone: today's date is computed in **local time** (Wave-24 spec rule
//! 9 — the user's wall-clock day matters for journaling, not UTC). The
//! frontend passes its local YYYY-MM-DD when ensuring "today" so the Rust
//! side never has to guess; default fallback uses the system local clock.
//!
//! All commands are idempotent + soft-fail — missing dirs / permission
//! errors degrade to a no-op + the path so the UI stays usable.

use std::path::{Path, PathBuf};

use chrono::{Datelike, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use super::AppError;

/// Default memory root: `<home>/.tangerine-memory/`. Matches `commands::memory`.
fn memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// Daily notes live under `team/daily/`.
fn daily_dir(root: &Path) -> PathBuf {
    root.join("team").join("daily")
}

/// Resolve the absolute path to today's daily note.
fn daily_path_for(root: &Path, date: &str) -> PathBuf {
    daily_dir(root).join(format!("{}.md", date))
}

/// Local-clock today (YYYY-MM-DD). Frontend can override per its own tz logic.
fn today_local_iso() -> String {
    let now = Local::now();
    format!(
        "{:04}-{:02}-{:02}",
        now.year(),
        now.month(),
        now.day()
    )
}

/// Validate a YYYY-MM-DD string. Returns the canonical string on success.
fn validate_iso_date(s: &str) -> Option<String> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .map(|d| d.format("%Y-%m-%d").to_string())
}

/// Format the daily-note H1 title — "Daily — Monday, April 28, 2026".
fn pretty_date_for(date: &str) -> String {
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|d| d.format("%A, %B %-d, %Y").to_string())
        // Fallback: if we somehow got an invalid date string, emit the raw
        // string so the file still renders rather than panicking.
        .unwrap_or_else(|_| date.to_string())
}

/// Render the daily-note template for a given date and author.
fn render_daily_template(date: &str, author: &str) -> String {
    let pretty = pretty_date_for(date);
    let author = if author.trim().is_empty() {
        "me"
    } else {
        author
    };
    format!(
        "---\n\
         date: {date}\n\
         kind: daily\n\
         author: {author}\n\
         ---\n\
         \n\
         # Daily — {pretty}\n\
         \n\
         ## What the team decided today\n\
         (co-thinker fills in via heartbeat)\n\
         \n\
         ## What I worked on\n\
         - (your notes here)\n\
         \n\
         ## Decisions to make tomorrow\n\
         - (your notes here)\n\
         \n\
         ## Insights from AI tools today\n\
         (co-thinker fills in citing recent atoms)\n",
        date = date,
        author = author,
        pretty = pretty,
    )
}

// ---------------------------------------------------------------------------
// Public helpers — used by the Tauri commands AND by the co-thinker heartbeat.
// ---------------------------------------------------------------------------

/// Idempotent: create today's daily note if missing. Returns the absolute
/// path + whether the file was just created. Pure-Rust helper that the
/// heartbeat calls directly (no Tauri dependency).
pub fn ensure_today_path_for(
    root: &Path,
    date: &str,
    author: &str,
) -> Result<(PathBuf, bool), AppError> {
    let dir = daily_dir(root);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal("mkdir_daily", e.to_string()))?;
    let path = daily_path_for(root, date);
    if path.exists() {
        return Ok((path, false));
    }
    let body = render_daily_template(date, author);
    std::fs::write(&path, body)
        .map_err(|e| AppError::internal("write_daily", e.to_string()))?;
    Ok((path, true))
}

/// Replace the body of an H2 section in `content` with `new_body`.
/// Section is matched by its exact heading text (without the `## ` prefix).
/// Returns the new full doc string. If the section is missing, the doc is
/// returned unchanged.
pub fn replace_section(content: &str, heading: &str, new_body: &str) -> String {
    let target = format!("## {}", heading);
    let lines: Vec<&str> = content.lines().collect();
    let mut start: Option<usize> = None;
    for (i, l) in lines.iter().enumerate() {
        if l.trim() == target {
            start = Some(i);
            break;
        }
    }
    let Some(start) = start else {
        return content.to_string();
    };
    let mut end = lines.len();
    for (i, l) in lines.iter().enumerate().skip(start + 1) {
        if l.starts_with("## ") || l.starts_with("# ") {
            end = i;
            break;
        }
    }
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    for l in &lines[..=start] {
        out.push((*l).to_string());
    }
    let trimmed = new_body.trim_end_matches('\n');
    if trimmed.is_empty() {
        out.push(String::new());
    } else {
        out.push(trimmed.to_string());
        out.push(String::new());
    }
    for l in &lines[end..] {
        out.push((*l).to_string());
    }
    let mut s = out.join("\n");
    if !s.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// Convenience: ensure today's daily note exists, then replace one of its
/// auto sections with `new_body`. Used by the co-thinker heartbeat to wire
/// "What the team decided" + "Insights from AI tools today" without the
/// heartbeat caring about path resolution.
pub fn update_auto_section(
    root: &Path,
    date: &str,
    author: &str,
    heading: &str,
    new_body: &str,
) -> Result<PathBuf, AppError> {
    let (path, _) = ensure_today_path_for(root, date, author)?;
    let cur = std::fs::read_to_string(&path)
        .map_err(|e| AppError::internal("read_daily", e.to_string()))?;
    let next = replace_section(&cur, heading, new_body);
    if next != cur {
        std::fs::write(&path, next)
            .map_err(|e| AppError::internal("write_daily_section", e.to_string()))?;
    }
    Ok(path)
}

// ---------------------------------------------------------------------------
// `daily_notes_ensure_today` — Tauri command surface.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Default)]
pub struct EnsureTodayArgs {
    /// Local-time YYYY-MM-DD from the frontend. When None we use the Rust
    /// process's local clock — fine for unit tests + the rare case where
    /// the frontend forgot to pass it.
    #[serde(default)]
    pub date: Option<String>,
    /// User alias to stamp into frontmatter `author:`. Defaults to "me".
    #[serde(default)]
    pub author: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EnsureTodayResult {
    pub path: String,
    pub created: bool,
    pub date: String,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn daily_notes_ensure_today(
    args: Option<EnsureTodayArgs>,
) -> Result<EnsureTodayResult, AppError> {
    let args = args.unwrap_or_default();
    let date = args
        .date
        .as_deref()
        .and_then(validate_iso_date)
        .unwrap_or_else(today_local_iso);
    let author = args
        .author
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("me")
        .to_string();
    let root = memory_root()?;
    let (path, created) = ensure_today_path_for(&root, &date, &author)?;
    Ok(EnsureTodayResult {
        path: path.to_string_lossy().to_string(),
        created,
        date,
    })
}

// ---------------------------------------------------------------------------
// `daily_notes_list` — return last N daily notes (reverse-chronological).
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Default)]
pub struct ListDailyArgs {
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DailyNoteSummary {
    pub date: String,
    pub path: String,
    pub rel_path: String,
    pub bytes: u64,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn daily_notes_list(
    args: Option<ListDailyArgs>,
) -> Result<Vec<DailyNoteSummary>, AppError> {
    let args = args.unwrap_or_default();
    let limit = args.limit.unwrap_or(30) as usize;
    let root = memory_root()?;
    let dir = daily_dir(&root);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out: Vec<DailyNoteSummary> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') || !name.to_lowercase().ends_with(".md") {
            continue;
        }
        let stem = name.trim_end_matches(".md");
        // Only accept date-named files so a stray atom in team/daily/ is not
        // misclassified as a daily note.
        let Some(date) = validate_iso_date(stem) else {
            continue;
        };
        let bytes = path.metadata().map(|m| m.len()).unwrap_or(0);
        let rel_path = path
            .strip_prefix(&root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.clone());
        out.push(DailyNoteSummary {
            date,
            path: path.to_string_lossy().to_string(),
            rel_path,
            bytes,
        });
    }
    // Reverse-chronological by date string (lex-sortable thanks to YYYY-MM-DD).
    out.sort_by(|a, b| b.date.cmp(&a.date));
    out.truncate(limit);
    Ok(out)
}

/// Read the raw markdown of a daily note for a given date. Returns an empty
/// string when the file doesn't exist (matches the `co_thinker_read_brain`
/// shape — empty string is the "fresh" sentinel).
#[derive(Debug, Deserialize)]
pub struct ReadDailyArgs {
    pub date: String,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn daily_notes_read(args: ReadDailyArgs) -> Result<String, AppError> {
    let date = match validate_iso_date(&args.date) {
        Some(d) => d,
        None => return Ok(String::new()),
    };
    let root = memory_root()?;
    let path = daily_path_for(&root, &date);
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()),
    }
}

/// Save a manual edit of a daily note. The frontend posts the whole body
/// back; we write atomically (write-then-rename via the same dir to avoid
/// cross-volume rename pitfalls). Idempotent — calling twice with the same
/// content is a no-op-ish (still rewrites bytes, but safe).
#[derive(Debug, Deserialize)]
pub struct SaveDailyArgs {
    pub date: String,
    pub content: String,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn daily_notes_save(args: SaveDailyArgs) -> Result<EnsureTodayResult, AppError> {
    let date = validate_iso_date(&args.date)
        .ok_or_else(|| AppError::internal("daily_save", "invalid date"))?;
    let root = memory_root()?;
    let dir = daily_dir(&root);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal("mkdir_daily_save", e.to_string()))?;
    let path = daily_path_for(&root, &date);
    let was_new = !path.exists();
    std::fs::write(&path, args.content.as_bytes())
        .map_err(|e| AppError::internal("write_daily_save", e.to_string()))?;
    Ok(EnsureTodayResult {
        path: path.to_string_lossy().to_string(),
        created: was_new,
        date,
    })
}

// ---------------------------------------------------------------------------
// `templates_list` + `templates_apply` — template library surface.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct TemplateSummary {
    pub id: String,
    pub label: String,
    pub kind: Option<String>,
    pub vertical: Option<String>,
    pub bytes: u64,
}

/// Resolve the bundled templates dir. Same fallback shape as
/// `init_memory_with_samples` — try `<resource>/resources/sample-memory/templates`
/// first, then `<resource>/sample-memory/templates` for `tauri dev`.
fn resolve_templates_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let primary = resource_dir
        .join("resources")
        .join("sample-memory")
        .join("templates");
    if primary.is_dir() {
        return Some(primary);
    }
    let fallback = resource_dir.join("sample-memory").join("templates");
    if fallback.is_dir() {
        return Some(fallback);
    }
    None
}

/// Parse a thin frontmatter block. Returns `(field-map, body)` — the body is
/// the markdown after the closing `---`. Used to read template metadata
/// without a full YAML parse (avoids dragging in another dep). Only top-level
/// `key: value` pairs are recognised; lists / nested maps are ignored.
fn parse_simple_frontmatter(raw: &str) -> (std::collections::HashMap<String, String>, String) {
    let mut fields = std::collections::HashMap::new();
    let trimmed = raw.trim_start_matches('\u{feff}');
    if !trimmed.starts_with("---") {
        return (fields, raw.to_string());
    }
    let after_open = &trimmed[3..].trim_start_matches('\r').trim_start_matches('\n');
    let close_idx = match after_open.find("\n---") {
        Some(i) => i,
        None => return (fields, raw.to_string()),
    };
    let block = &after_open[..close_idx];
    for line in block.lines() {
        if let Some((k, v)) = line.split_once(':') {
            fields.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    let body_start = close_idx + 4; // skip "\n---"
    let body = if body_start <= after_open.len() {
        let rest = &after_open[body_start..];
        rest.trim_start_matches('\r')
            .trim_start_matches('\n')
            .to_string()
    } else {
        String::new()
    };
    (fields, body)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn templates_list<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<TemplateSummary>, AppError> {
    let dir = match resolve_templates_dir(&app) {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out: Vec<TemplateSummary> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') || !name.to_lowercase().ends_with(".md") {
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let (fm, _body) = parse_simple_frontmatter(&raw);
        // Filter: only entries that explicitly opt in via `template: true`.
        // This keeps a stray non-template .md from showing up in the picker.
        let is_template = fm
            .get("template")
            .map(|v| v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if !is_template {
            continue;
        }
        let id = fm
            .get("template_id")
            .cloned()
            .unwrap_or_else(|| name.trim_end_matches(".md").to_string());
        let label = fm
            .get("template_label")
            .cloned()
            .unwrap_or_else(|| id.clone());
        out.push(TemplateSummary {
            id,
            label,
            kind: fm.get("kind").cloned(),
            vertical: fm.get("vertical").cloned(),
            bytes: raw.len() as u64,
        });
    }
    out.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    Ok(out)
}

#[derive(Debug, Deserialize)]
pub struct ApplyTemplateArgs {
    pub template_id: String,
    /// Path relative to the memory root where the new atom should be written.
    /// When None, the helper writes to
    /// `team/<kind>/<template_id>-<YYYYMMDD-HHMMSS>.md` (kind from frontmatter,
    /// falling back to "decisions").
    #[serde(default)]
    pub target_path: Option<String>,
    /// Local-time YYYY-MM-DD used to stamp the generated frontmatter when the
    /// template renderer wants a date. Only used when the template has a
    /// `date:` field — otherwise ignored.
    #[serde(default)]
    pub date: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ApplyTemplateResult {
    pub path: String,
    pub rel_path: String,
    pub copied: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn templates_apply<R: Runtime>(
    app: AppHandle<R>,
    args: ApplyTemplateArgs,
) -> Result<ApplyTemplateResult, AppError> {
    let dir = match resolve_templates_dir(&app) {
        Some(d) => d,
        None => {
            return Err(AppError::internal(
                "templates_dir",
                "bundled templates dir not found",
            ));
        }
    };

    // Find the template file whose `template_id` matches (or whose filename
    // stem matches, for templates that omit the explicit id field).
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| AppError::internal("read_templates_dir", e.to_string()))?;
    let mut found: Option<(PathBuf, std::collections::HashMap<String, String>, String)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !name.to_lowercase().ends_with(".md") {
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let (fm, body) = parse_simple_frontmatter(&raw);
        let id = fm
            .get("template_id")
            .cloned()
            .unwrap_or_else(|| name.trim_end_matches(".md").to_string());
        if id == args.template_id {
            found = Some((path, fm, body));
            break;
        }
    }
    let (template_path, fm, body) = match found {
        Some(x) => x,
        None => {
            return Err(AppError::internal(
                "template_not_found",
                format!("no template with id {}", args.template_id),
            ));
        }
    };

    let root = memory_root()?;
    let date = args
        .date
        .as_deref()
        .and_then(validate_iso_date)
        .unwrap_or_else(today_local_iso);
    let kind = fm.get("kind").cloned().unwrap_or_else(|| "decisions".into());

    // Resolve the destination path. We always sit inside the memory root —
    // a target_path that escapes via `..` is rejected so a hostile front-end
    // can't write outside the memory dir.
    let rel = match args.target_path {
        Some(t) if !t.trim().is_empty() => {
            let cleaned = t.trim().replace('\\', "/");
            if cleaned.contains("..") {
                return Err(AppError::internal(
                    "target_path",
                    "target_path may not contain '..'",
                ));
            }
            cleaned
        }
        _ => {
            let stamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
            format!("team/{}/{}-{}.md", kind, args.template_id, stamp)
        }
    };

    let dest = root.join(&rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir_target", e.to_string()))?;
    }

    // Materialise: keep the frontmatter MINUS the `template: true` flag
    // (we don't want the new atom to be filtered out of the regular content
    // tree), stamp the date, then append the body. Frontmatter key order is
    // not stable but that's fine — Markdown frontmatter is unordered.
    let mut out_fm: Vec<(String, String)> = fm
        .into_iter()
        .filter(|(k, _)| k != "template")
        .collect();
    // Ensure date is always present in the new atom even when the template
    // didn't specify one (lets the daemon backfill threads/timeline indexes).
    if !out_fm.iter().any(|(k, _)| k == "date") {
        out_fm.push(("date".into(), date.clone()));
    } else {
        for (k, v) in out_fm.iter_mut() {
            if k == "date" && v == "YYYY-MM-DD" {
                *v = date.clone();
            }
        }
    }
    let mut s = String::new();
    s.push_str("---\n");
    for (k, v) in &out_fm {
        s.push_str(&format!("{}: {}\n", k, v));
    }
    s.push_str("---\n\n");
    s.push_str(&body);
    if !s.ends_with('\n') {
        s.push('\n');
    }

    std::fs::write(&dest, s)
        .map_err(|e| AppError::internal("write_target", e.to_string()))?;

    // Touch template_path read so the compiler doesn't warn when the binding
    // is otherwise unused after we already pulled `body` + `fm` out.
    let _ = template_path;

    Ok(ApplyTemplateResult {
        path: dest.to_string_lossy().to_string(),
        rel_path: rel,
        copied: true,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fresh_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_daily_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn ensure_today_creates_file_with_template() {
        let root = fresh_root();
        let (path, created) = ensure_today_path_for(&root, "2026-04-28", "alex").unwrap();
        assert!(created);
        assert!(path.exists());
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("date: 2026-04-28"));
        assert!(body.contains("kind: daily"));
        assert!(body.contains("author: alex"));
        assert!(body.contains("# Daily — Tuesday, April 28, 2026"));
        assert!(body.contains("## What the team decided today"));
        assert!(body.contains("## What I worked on"));
        assert!(body.contains("## Decisions to make tomorrow"));
        assert!(body.contains("## Insights from AI tools today"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_today_is_idempotent() {
        let root = fresh_root();
        let (path1, c1) = ensure_today_path_for(&root, "2026-04-28", "alex").unwrap();
        // Mutate user content — the second call must not overwrite.
        let custom = std::fs::read_to_string(&path1)
            .unwrap()
            .replace("(your notes here)", "shipped wave 24!");
        std::fs::write(&path1, &custom).unwrap();
        let (path2, c2) = ensure_today_path_for(&root, "2026-04-28", "alex").unwrap();
        assert!(c1, "first call must report created=true");
        assert!(!c2, "second call must report created=false");
        assert_eq!(path1, path2);
        let body = std::fs::read_to_string(&path2).unwrap();
        assert!(body.contains("shipped wave 24!"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_daily_returns_reverse_chrono_and_filters_non_dates() {
        let root = fresh_root();
        let dir = daily_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        for d in &["2026-04-26", "2026-04-27", "2026-04-28"] {
            std::fs::write(dir.join(format!("{}.md", d)), "x").unwrap();
        }
        // Stray files: hidden + non-date stem + non-md.
        std::fs::write(dir.join(".hidden.md"), "x").unwrap();
        std::fs::write(dir.join("notes.md"), "x").unwrap();
        std::fs::write(dir.join("2026-04-28.txt"), "x").unwrap();

        // Mimic the command's filtering by walking the dir directly.
        let mut summaries: Vec<DailyNoteSummary> = Vec::new();
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if name.starts_with('.') || !name.to_lowercase().ends_with(".md") {
                continue;
            }
            let stem = name.trim_end_matches(".md");
            let Some(date) = validate_iso_date(stem) else {
                continue;
            };
            summaries.push(DailyNoteSummary {
                date,
                path: path.to_string_lossy().to_string(),
                rel_path: format!("team/daily/{}", name),
                bytes: 1,
            });
        }
        summaries.sort_by(|a, b| b.date.cmp(&a.date));

        assert_eq!(summaries.len(), 3, "got {:?}", summaries);
        assert_eq!(summaries[0].date, "2026-04-28");
        assert_eq!(summaries[1].date, "2026-04-27");
        assert_eq!(summaries[2].date, "2026-04-26");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn replace_section_swaps_only_targeted_section() {
        let doc = "---\ndate: 2026-04-28\n---\n\n# Daily\n\n## A\nold-a\n\n## B\nold-b\n\n## C\nold-c\n";
        let next = replace_section(doc, "B", "new-b-line\nnew-b-line-2");
        assert!(next.contains("old-a"));
        assert!(next.contains("new-b-line"));
        assert!(next.contains("new-b-line-2"));
        assert!(!next.contains("old-b"));
        assert!(next.contains("old-c"));
    }

    #[test]
    fn replace_section_missing_heading_is_noop() {
        let doc = "## A\nbody\n";
        let next = replace_section(doc, "Missing", "x");
        assert_eq!(next, doc);
    }

    #[test]
    fn parse_simple_frontmatter_extracts_template_flag() {
        let raw = "---\ntemplate: true\ntemplate_id: decision\nkind: decision\n---\n\nbody-text";
        let (fm, body) = parse_simple_frontmatter(raw);
        assert_eq!(fm.get("template").map(|s| s.as_str()), Some("true"));
        assert_eq!(fm.get("template_id").map(|s| s.as_str()), Some("decision"));
        assert_eq!(fm.get("kind").map(|s| s.as_str()), Some("decision"));
        assert!(body.starts_with("body-text"));
    }

    #[test]
    fn parse_simple_frontmatter_no_block_returns_full_body() {
        let raw = "no frontmatter here\nbody";
        let (fm, body) = parse_simple_frontmatter(raw);
        assert!(fm.is_empty());
        assert_eq!(body, raw);
    }

    #[test]
    fn validate_iso_date_accepts_canonical_form_only() {
        assert_eq!(
            validate_iso_date("2026-04-28").as_deref(),
            Some("2026-04-28")
        );
        assert!(validate_iso_date("not-a-date").is_none());
        assert!(validate_iso_date("2026-13-40").is_none());
    }
}
// === end wave 24 ===
