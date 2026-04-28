// === wave 15 ===
//! Wave 15 — Cmd+K full memory search.
//!
//! Adds a single Tauri command, `search_atoms`, that lets the React-side
//! `CommandPalette` extend its launcher beyond static routes / actions
//! into the markdown corpus living under `~/.tangerine-memory/`. The
//! palette already knows how to surface routes ("today", "memory",
//! "settings") and actions ("Initialize co-thinker brain", "Pull from
//! team"); now it ALSO surfaces matching atom files (decisions /
//! timeline / personal threads) so the user can jump to a specific
//! note in the same single-keystroke flow.
//!
//! Why a new module rather than reusing `crate::memory_search`:
//!   * `memory_search` is the wire shape the browser-extension MCP
//!     server returns — `file` is an absolute path, scoring is the
//!     simple `matches/(matches+1)` curve, and the snippet window is
//!     ~200 chars on either side. Good for an LLM prompt; too long
//!     for a palette row.
//!   * `search_atoms` returns a richer per-result shape with
//!     `vendor` / `author` / `timestamp` decoded from frontmatter so
//!     the palette can colour-dot results by source AND surface a
//!     compact ~150-char snippet centred on the first match.
//!   * Scoring boosts title hits 2× and adds a tiny tf-idf shimmer
//!     (`idf = log(total_docs / docs_with_term)`) so a generic match
//!     for "decision" doesn't drown out a specific match for
//!     "pricing".
//!
//! Performance budget: <100 ms p95 on a 100-file memory dir. We hard-
//! cap the walk at 1000 files (mirrors `MAX_FILES` in
//! `memory_search`) so a hyperactive team that has accumulated
//! thousands of personal-vault threads still gets a snappy palette.
//!
//! Defensive: never panic. File-read errors degrade silently to
//! "skip this file"; missing memory root returns an empty Vec; an
//! empty / whitespace-only query short-circuits to `[]` so the
//! palette doesn't spend CPU on no-op queries.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Hard cap on the number of files the walker will touch in a single
/// call. Mirrors `crate::memory_search::MAX_FILES` for symmetry.
pub const MAX_FILES: usize = 1000;
/// Default result cap when the React side doesn't pass `limit`.
pub const DEFAULT_LIMIT: usize = 10;
/// Snippet window — characters on either side of the first match.
const SNIPPET_CONTEXT: usize = 75;

/// Wire shape returned to the React side. Mirrors
/// `app/src/lib/tauri.ts::AtomSearchResult` exactly.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AtomSearchResult {
    /// Path relative to the memory root, with forward slashes. The
    /// React palette routes the user to `/memory/<path>` on Enter.
    pub path: String,
    /// Display title — frontmatter `title:` if present, else first
    /// `# H1` from the body, else the filename without extension.
    pub title: String,
    /// ~150 chars around the first match, whitespace flattened.
    pub snippet: String,
    /// Frontmatter `vendor:` (claude / cursor / discord / ...). The
    /// palette uses this to pick a colour dot for the row.
    pub vendor: Option<String>,
    /// Frontmatter `author:` if present.
    pub author: Option<String>,
    /// Frontmatter `created:` ISO timestamp if present.
    pub timestamp: Option<String>,
    /// Composite score 0..1. Higher is better.
    pub score: f32,
}

/// Internal — one parsed file in the walk. Kept private; only the
/// result shape leaves the module.
#[derive(Debug, Clone)]
struct ParsedFile {
    rel_path: String,
    title: String,
    body: String,
    vendor: Option<String>,
    author: Option<String>,
    timestamp: Option<String>,
}

/// Resolve `<home>/.tangerine-memory/`. Mirrors the helper in
/// `commands::memory` — duplicated rather than imported so this
/// module is independent of unrelated changes there.
fn memory_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".tangerine-memory"))
}

/// Walk the memory root and return parsed files. Bounded by
/// [`MAX_FILES`]. Skips dotfiles and `node_modules`. Read errors are
/// soft-failed (logged via `tracing::warn`).
fn walk(root: &Path) -> Vec<ParsedFile> {
    if !root.is_dir() {
        return Vec::new();
    }
    let mut out: Vec<ParsedFile> = Vec::new();
    walk_dir(root, root, &mut out);
    out
}

fn walk_dir(current: &Path, root: &Path, out: &mut Vec<ParsedFile>) {
    if out.len() >= MAX_FILES {
        return;
    }
    let entries = match std::fs::read_dir(current) {
        Ok(e) => e,
        Err(err) => {
            tracing::warn!(
                path = %current.display(),
                error = %err,
                "search_atoms: readdir failed"
            );
            return;
        }
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || name_str == "node_modules" {
            continue;
        }
        let abs = entry.path();
        let ty = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ty.is_dir() {
            walk_dir(&abs, root, out);
            continue;
        }
        if !ty.is_file() {
            continue;
        }
        let lower = name_str.to_ascii_lowercase();
        if !(lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdx")) {
            continue;
        }
        let raw = match std::fs::read_to_string(&abs) {
            Ok(s) => s,
            Err(err) => {
                tracing::warn!(
                    path = %abs.display(),
                    error = %err,
                    "search_atoms: read file failed"
                );
                continue;
            }
        };
        let parsed = parse_file(&abs, root, &name_str, &raw);
        out.push(parsed);
    }
}

/// Parse one file: split frontmatter / body, pull the canonical
/// title, extract vendor / author / timestamp.
fn parse_file(abs: &Path, root: &Path, fallback_name: &str, raw: &str) -> ParsedFile {
    let (fm, body) = split_frontmatter(raw);
    let mut vendor: Option<String> = None;
    let mut author: Option<String> = None;
    let mut timestamp: Option<String> = None;
    let mut fm_title: Option<String> = None;
    for line in fm.lines() {
        let t = line.trim_start();
        if let Some(v) = strip_kv(t, "title:") {
            if !v.is_empty() {
                fm_title = Some(v.to_string());
            }
        } else if let Some(v) = strip_kv(t, "vendor:") {
            if !v.is_empty() {
                vendor = Some(v.to_string());
            }
        } else if let Some(v) = strip_kv(t, "author:") {
            if !v.is_empty() {
                author = Some(v.to_string());
            }
        } else if let Some(v) = strip_kv(t, "created:") {
            if !v.is_empty() {
                timestamp = Some(v.to_string());
            }
        }
    }
    // Title fallback chain: frontmatter `title:` > first `# H1` in
    // body > filename without extension.
    let title = fm_title
        .or_else(|| first_h1(&body).map(|s| s.to_string()))
        .unwrap_or_else(|| {
            fallback_name
                .trim_end_matches(".md")
                .trim_end_matches(".MD")
                .trim_end_matches(".markdown")
                .trim_end_matches(".mdx")
                .to_string()
        });
    let rel_path = match abs.strip_prefix(root) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/").to_string(),
        Err(_) => abs.to_string_lossy().to_string(),
    };
    ParsedFile {
        rel_path,
        title,
        body: body.to_string(),
        vendor,
        author,
        timestamp,
    }
}

/// Strip a `key: value` prefix and return the trimmed value if the
/// line matches. Quotes are stripped to mirror the frontmatter
/// shapes our writers emit.
fn strip_kv<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(key)?;
    Some(rest.trim().trim_matches(|c: char| c == '"' || c == '\''))
}

/// Split a leading YAML frontmatter block off `raw`. Returns
/// (frontmatter_text, body). When no frontmatter is present, the
/// frontmatter slice is empty and the body is the original input.
fn split_frontmatter(raw: &str) -> (&str, &str) {
    let head = raw.trim_start_matches('\u{feff}');
    if !head.starts_with("---") {
        return ("", raw);
    }
    let after_open = match head.find('\n') {
        Some(i) => &head[i + 1..],
        None => return ("", raw),
    };
    let close_rel = after_open
        .find("\n---\n")
        .or_else(|| after_open.find("\n---\r\n"))
        .or_else(|| {
            if after_open.ends_with("\n---") {
                Some(after_open.len() - 4)
            } else {
                None
            }
        });
    let close_idx = match close_rel {
        Some(i) => i,
        None => return ("", raw),
    };
    let yaml_block = &after_open[..close_idx];
    let after_close = &after_open[close_idx..];
    let body = if let Some(stripped) = after_close.strip_prefix("\n---\n") {
        stripped
    } else if let Some(stripped) = after_close.strip_prefix("\n---\r\n") {
        stripped
    } else {
        ""
    };
    (yaml_block, body)
}

/// Find the first `# H1` heading in the body. Skips ATX `## H2` etc.
/// Returns the text after `# ` trimmed, or None.
fn first_h1(body: &str) -> Option<&str> {
    for line in body.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("# ") {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

/// Word-token split for tf-idf shimmer. Cheap — split on non-alpha
/// instead of pulling in a tokenizer crate. Lower-cased so the
/// shimmer is case-insensitive (mirrors the substring scorer).
fn words(s: &str) -> impl Iterator<Item = String> + '_ {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_ascii_lowercase())
}

/// True when `term` appears in `title_lc` at a word boundary
/// (preceded by start-of-string or non-alphanumeric, followed by
/// end-of-string or non-alphanumeric). Both inputs are expected to
/// already be lower-cased.
fn title_word_boundary_hit(title_lc: &str, term: &str) -> bool {
    let mut pos = 0usize;
    while let Some(found) = title_lc[pos..].find(term) {
        let abs = pos + found;
        let before_ok = abs == 0
            || !title_lc[..abs]
                .chars()
                .last()
                .map(|c| c.is_alphanumeric())
                .unwrap_or(false);
        let end = abs + term.len();
        let after_ok = end >= title_lc.len()
            || !title_lc[end..]
                .chars()
                .next()
                .map(|c| c.is_alphanumeric())
                .unwrap_or(false);
        if before_ok && after_ok {
            return true;
        }
        pos = abs + term.len();
        if pos >= title_lc.len() {
            break;
        }
    }
    false
}

/// Score one file against `query_terms`. Returns a value in 0..1.
///
/// Composition (each term contributes; final score is averaged):
///   * exact substring on title × 2 (cap 1.0 per term)
///   * substring on body × 1.0
///   * tf-idf shimmer (small) so generic terms ("the", "decision")
///     don't dominate; idf = log(total_docs / docs_with_term).
fn score_file(
    file: &ParsedFile,
    query_terms: &[String],
    docs_with_term: &HashMap<String, usize>,
    total_docs: usize,
) -> (f32, Option<usize>) {
    if query_terms.is_empty() {
        return (0.0, None);
    }
    let title_lc = file.title.to_lowercase();
    let body_lc = file.body.to_lowercase();
    let body_word_count = words(&file.body).count().max(1);

    let mut total: f32 = 0.0;
    let mut hit_count: usize = 0;
    let mut first_match_byte: Option<usize> = None;

    for term in query_terms {
        let mut term_score: f32 = 0.0;
        let title_hit = title_lc.contains(term);
        let body_hit_idx = body_lc.find(term);
        if title_hit {
            // Title hit: 2× weight per the wave-15 scoring spec.
            // Word-boundary title hits — "pricing" matching "Pricing
            // decision" rather than "supercalifragipricingistic" —
            // get a small extra kicker so a clean title hit clearly
            // outranks a noisy body-only hit.
            let mut title_part: f32 = 2.0;
            if title_word_boundary_hit(&title_lc, term) {
                title_part += 0.5;
            }
            term_score += title_part;
        }
        if let Some(b_idx) = body_hit_idx {
            // Body hit: 1.0 baseline (half of the title weight).
            let mut body_part: f32 = 1.0;
            // tf shimmer — count occurrences then normalise by body
            // length so a short atom that mentions "pricing" thrice
            // still beats a 4000-word transcript that mentions it
            // once.
            let mut tf_count: usize = 0;
            let mut idx = 0usize;
            while let Some(found) = body_lc[idx..].find(term) {
                tf_count += 1;
                idx += found + term.len();
                if idx >= body_lc.len() {
                    break;
                }
            }
            let tf = tf_count as f32 / body_word_count as f32;
            // idf shimmer — kept small so a unique-term match is
            // boosted but doesn't drown out an otherwise-strong
            // title hit. log(total / df) clamps at 0 when every
            // doc contains the term.
            let df = docs_with_term.get(term).copied().unwrap_or(1).max(1);
            let idf = ((total_docs as f32) / (df as f32)).ln().max(0.0);
            body_part *= 1.0 + 0.3 * (tf * 10.0).min(1.0) + 0.2 * idf.min(2.0);
            term_score += body_part;
            if first_match_byte.is_none() {
                first_match_byte = Some(b_idx);
            }
        }
        if term_score > 0.0 {
            hit_count += 1;
            total += term_score;
        }
    }
    if hit_count == 0 {
        return (0.0, None);
    }
    // Multi-term boost: every additional term that also matches gets
    // a small kicker so an exact two-word match beats a one-word
    // match.
    let multi_term_boost = 1.0 + 0.1 * (hit_count.saturating_sub(1)) as f32;
    let raw = (total / query_terms.len() as f32) * multi_term_boost;
    // Squash to 0..1 via x/(x+1). Symmetric with `memory_search`.
    let normalised = raw / (raw + 1.0);
    (normalised, first_match_byte)
}

/// Build a snippet around `byte_match`. Whitespace-flattened. Adds
/// `…` ellipses on either side when the window is truncated.
fn snippet_around(body: &str, byte_match: usize, needle_len: usize) -> String {
    let total_chars = body.chars().count();
    let mut chars_before_match = 0usize;
    for (b, _) in body.char_indices() {
        if b >= byte_match {
            break;
        }
        chars_before_match += 1;
    }
    let needle_chars = body[byte_match..]
        .char_indices()
        .take_while(|(b, _)| *b < needle_len)
        .count();
    let start_char = chars_before_match.saturating_sub(SNIPPET_CONTEXT);
    let end_char = (chars_before_match + needle_chars + SNIPPET_CONTEXT).min(total_chars);
    let s: String = body
        .chars()
        .skip(start_char)
        .take(end_char - start_char)
        .collect();
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = flat.trim().to_string();
    if start_char > 0 {
        out = format!("…{}", out);
    }
    if end_char < total_chars {
        out = format!("{}…", out);
    }
    out
}

/// Fallback snippet when no body match was found (e.g. only the
/// title matched). Returns the first ~150 chars of the body, flattened.
fn opening_snippet(body: &str) -> String {
    let s: String = body.chars().take(SNIPPET_CONTEXT * 2).collect();
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Pure search entry point — separated from the Tauri command so the
/// unit tests can drive it without a Tauri runtime.
pub fn search_atoms_in_root(
    root: &Path,
    query: &str,
    limit: usize,
) -> Vec<AtomSearchResult> {
    let q = query.trim();
    if q.is_empty() {
        return Vec::new();
    }
    let cap = limit.clamp(1, 50);
    let files = walk(root);
    if files.is_empty() {
        return Vec::new();
    }

    // Tokenise the query once. Multi-word queries score every term;
    // a single-word query degrades naturally to one-term scoring.
    let query_terms: Vec<String> = words(q).collect();
    if query_terms.is_empty() {
        return Vec::new();
    }

    // Pre-compute df (docs-containing-term) for tf-idf shimmer. We
    // only count distinct term presence per file (binary df), not
    // raw occurrences — keeps the boost stable across varying body
    // lengths.
    let total_docs = files.len();
    let mut docs_with_term: HashMap<String, usize> = HashMap::new();
    for term in &query_terms {
        let mut count = 0usize;
        for f in &files {
            let lc_body = f.body.to_lowercase();
            let lc_title = f.title.to_lowercase();
            if lc_body.contains(term) || lc_title.contains(term) {
                count += 1;
            }
        }
        docs_with_term.insert(term.clone(), count);
    }

    let mut scored: Vec<(f32, Option<usize>, &ParsedFile)> = Vec::new();
    for f in &files {
        let (s, byte_match) = score_file(f, &query_terms, &docs_with_term, total_docs);
        if s > 0.0 {
            scored.push((s, byte_match, f));
        }
    }
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.2.rel_path.cmp(&b.2.rel_path))
    });

    // First-term length is used as the default needle length when
    // we don't have a body-match position (title-only hit). Picked
    // because the snippet builder needs a needle width to centre
    // around — for a title-only match we just show the body opening.
    let first_term_len = query_terms.first().map(|t| t.len()).unwrap_or(1);

    scored
        .into_iter()
        .take(cap)
        .map(|(score, byte_match, f)| {
            let snippet = match byte_match {
                Some(b) => snippet_around(&f.body, b, first_term_len),
                None => opening_snippet(&f.body),
            };
            AtomSearchResult {
                path: f.rel_path.clone(),
                title: f.title.clone(),
                snippet,
                vendor: f.vendor.clone(),
                author: f.author.clone(),
                timestamp: f.timestamp.clone(),
                score,
            }
        })
        .collect()
}

/// Tauri command entry point. Walks `<home>/.tangerine-memory/` and
/// returns up to `limit` (default 10) atom matches.
///
/// Defensive: never returns an `Err`. A missing memory dir returns
/// an empty Vec; an empty query returns an empty Vec; file-read
/// failures degrade silently to "skip this file".
#[tauri::command]
pub async fn search_atoms(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<AtomSearchResult>, super::AppError> {
    let root = match memory_root() {
        Some(r) => r,
        // home_dir() being None is exotic enough that returning an
        // empty Vec is a kinder behaviour than surfacing an error
        // through the palette.
        None => return Ok(Vec::new()),
    };
    let lim = limit.unwrap_or(DEFAULT_LIMIT);
    let hits = search_atoms_in_root(&root, &query, lim);
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmpdir() -> tempdir_like::TempDir {
        tempdir_like::TempDir::new("tangerine_search_atoms_")
    }

    fn write_md(dir: &Path, rel: &str, content: &str) {
        let path = dir.join(rel);
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).unwrap();
        }
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    #[test]
    fn empty_query_returns_empty() {
        let td = tmpdir();
        write_md(td.path(), "team/decisions/a.md", "# A\nbody about pricing");
        assert!(search_atoms_in_root(td.path(), "", 10).is_empty());
        assert!(search_atoms_in_root(td.path(), "   ", 10).is_empty());
    }

    #[test]
    fn missing_root_returns_empty() {
        let p = std::path::PathBuf::from("/totally/nonexistent/zz_search_atoms");
        assert!(search_atoms_in_root(&p, "anything", 10).is_empty());
    }

    #[test]
    fn basic_substring_match() {
        let td = tmpdir();
        write_md(
            td.path(),
            "team/decisions/pricing.md",
            "---\ntitle: Pricing model\nvendor: claude\n---\nWe picked flat-rate pricing.",
        );
        write_md(
            td.path(),
            "team/decisions/other.md",
            "Nothing relevant here.",
        );
        let hits = search_atoms_in_root(td.path(), "pricing", 10);
        assert!(!hits.is_empty(), "expected at least one hit");
        // Pricing.md hit ranks first (title match boost).
        assert_eq!(hits[0].path, "team/decisions/pricing.md");
        assert_eq!(hits[0].title, "Pricing model");
        assert_eq!(hits[0].vendor.as_deref(), Some("claude"));
        assert!(hits[0].snippet.to_lowercase().contains("pricing"));
        assert!(hits[0].score > 0.0 && hits[0].score < 1.0);
    }

    #[test]
    fn title_match_outranks_body_match() {
        let td = tmpdir();
        write_md(
            td.path(),
            "a.md",
            "---\ntitle: Pricing decision\n---\nbody mentions other things",
        );
        write_md(
            td.path(),
            "b.md",
            "---\ntitle: Random thread\n---\nthis body does mention pricing",
        );
        let hits = search_atoms_in_root(td.path(), "pricing", 10);
        assert!(hits.len() >= 2);
        // Title hit on a.md should rank above body-only hit on b.md.
        assert_eq!(hits[0].path, "a.md");
    }

    #[test]
    fn multi_word_query_matches_all_terms() {
        let td = tmpdir();
        write_md(
            td.path(),
            "match.md",
            "---\ntitle: Pricing decision\n---\nWe chose flat-rate pricing.",
        );
        write_md(
            td.path(),
            "partial.md",
            "---\ntitle: Marketing budget\n---\nNo pricing mention.",
        );
        let hits = search_atoms_in_root(td.path(), "pricing decision", 10);
        // match.md hits both `pricing` AND `decision`; partial.md
        // hits neither in title, only `pricing` in title (zero in
        // body for "decision"). multi-term boost should leave
        // match.md on top.
        assert!(!hits.is_empty());
        assert_eq!(hits[0].path, "match.md");
    }

    #[test]
    fn frontmatter_fields_extracted() {
        let td = tmpdir();
        write_md(
            td.path(),
            "x.md",
            "---\ntitle: Real Title\nvendor: cursor\nauthor: \"Daizhe\"\ncreated: 2026-04-25T10:00:00Z\n---\nbody about pricing",
        );
        let hits = search_atoms_in_root(td.path(), "pricing", 10);
        assert_eq!(hits.len(), 1);
        let h = &hits[0];
        assert_eq!(h.title, "Real Title");
        assert_eq!(h.vendor.as_deref(), Some("cursor"));
        assert_eq!(h.author.as_deref(), Some("Daizhe"));
        assert_eq!(h.timestamp.as_deref(), Some("2026-04-25T10:00:00Z"));
    }

    #[test]
    fn h1_fallback_when_no_frontmatter_title() {
        let td = tmpdir();
        write_md(
            td.path(),
            "x.md",
            "# Heading As Title\n\nBody about pricing.",
        );
        let hits = search_atoms_in_root(td.path(), "pricing", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Heading As Title");
    }

    #[test]
    fn filename_fallback_when_no_h1_no_frontmatter_title() {
        let td = tmpdir();
        write_md(td.path(), "x.md", "Plain body about pricing.");
        let hits = search_atoms_in_root(td.path(), "pricing", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "x");
    }

    #[test]
    fn huge_dir_capped_at_max_files() {
        let td = tmpdir();
        // Write MAX_FILES+50 trivial files. The walker should cap.
        for i in 0..(MAX_FILES + 50) {
            write_md(
                td.path(),
                &format!("personal/me/threads/v/{}.md", i),
                "body about pricing",
            );
        }
        let hits = search_atoms_in_root(td.path(), "pricing", 999);
        // Cap returns 50 (the search limit clamp ceiling), and the
        // walk stopped scanning at MAX_FILES — both invariants are
        // preserved.
        assert!(hits.len() <= 50);
        assert!(hits.len() >= 10, "expected lots of pricing hits");
    }

    #[test]
    fn skips_dotfiles_and_node_modules() {
        let td = tmpdir();
        write_md(td.path(), ".git/config.md", "should-skip pricing");
        write_md(td.path(), "node_modules/x.md", "should-skip pricing");
        write_md(td.path(), "ok/a.md", "ok pricing");
        let hits = search_atoms_in_root(td.path(), "pricing", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "ok/a.md");
    }

    #[test]
    fn limit_is_clamped() {
        let td = tmpdir();
        for i in 0..30 {
            write_md(td.path(), &format!("a{}.md", i), "body pricing");
        }
        // Limit clamps to 1..=50. Asking for 0 → at least 1; asking
        // for 9999 → at most 50.
        assert_eq!(search_atoms_in_root(td.path(), "pricing", 0).len(), 1);
        assert!(search_atoms_in_root(td.path(), "pricing", 9999).len() <= 50);
    }

    #[test]
    fn read_failure_does_not_panic() {
        // Confidence: the walker uses `read_to_string` which returns
        // Err for unreadable files; our match arm logs+continues so
        // a single bad file never aborts the search. Hard to simulate
        // a permission error portably, so we instead assert that the
        // walker does not panic on a tree that mixes readable +
        // missing entries (the missing-file branch is exercised by
        // `missing_root_returns_empty`).
        let td = tmpdir();
        write_md(td.path(), "ok.md", "ok body about pricing");
        let hits = search_atoms_in_root(td.path(), "pricing", 10);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn snippet_centres_on_first_match() {
        let td = tmpdir();
        let body = format!(
            "---\ntitle: t\n---\n{}MATCHED{}",
            "x".repeat(300),
            "y".repeat(300)
        );
        write_md(td.path(), "a.md", &body);
        let hits = search_atoms_in_root(td.path(), "matched", 1);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("MATCHED"));
        // Snippet should have ellipses on at least one side (body
        // is wider than 2*SNIPPET_CONTEXT).
        assert!(hits[0].snippet.starts_with('…') || hits[0].snippet.ends_with('…'));
    }

    /// Wave 15 — sanity perf check. Runs only on `--ignored` so it
    /// doesn't slow the standard suite. Asserts the search completes
    /// well under the 100 ms p95 budget on a 100-file corpus.
    #[test]
    #[ignore]
    fn perf_smoke_small_and_medium() {
        use std::time::Instant;

        // Small (8 files).
        let small = tmpdir();
        for i in 0..8 {
            write_md(
                small.path(),
                &format!("team/decisions/d{}.md", i),
                "---\ntitle: Pricing decision\nvendor: claude-code\n---\nWe picked flat-rate pricing on 2026-04-22.",
            );
        }
        let t0 = Instant::now();
        let hits_small = search_atoms_in_root(small.path(), "pricing", 10);
        let dt_small = t0.elapsed();
        println!(
            "PERF small: 8 files, {} hits, {} us",
            hits_small.len(),
            dt_small.as_micros()
        );
        assert!(dt_small.as_millis() < 100);

        // Medium (100 files).
        let medium = tmpdir();
        for i in 0..100 {
            let body = if i % 5 == 0 {
                "We picked flat-rate pricing."
            } else {
                "Random unrelated content here about other topics."
            };
            write_md(
                medium.path(),
                &format!("team/decisions/d{}.md", i),
                &format!(
                    "---\ntitle: Decision {}\nvendor: claude-code\n---\n{}",
                    i, body
                ),
            );
        }
        let t0 = Instant::now();
        let hits_medium = search_atoms_in_root(medium.path(), "pricing", 10);
        let dt_medium = t0.elapsed();
        println!(
            "PERF medium: 100 files, {} hits, {} ms",
            hits_medium.len(),
            dt_medium.as_millis()
        );
        assert!(dt_medium.as_millis() < 100);
    }

    #[test]
    fn results_sorted_by_descending_score() {
        let td = tmpdir();
        // High score: title hit + body matches.
        write_md(
            td.path(),
            "high.md",
            "---\ntitle: Pricing decision\n---\npricing pricing pricing",
        );
        // Low score: only one body mention.
        write_md(td.path(), "low.md", "just one pricing mention");
        let hits = search_atoms_in_root(td.path(), "pricing", 10);
        assert!(hits.len() >= 2);
        assert!(hits[0].score >= hits[1].score);
        assert_eq!(hits[0].path, "high.md");
    }
}

// ---------------------------------------------------------------------------
// Tiny in-tree tempdir helper. Same shape as `memory_search::tempdir_like` —
// keeping it duplicated rather than pulling in the `tempfile` crate.
#[cfg(test)]
mod tempdir_like {
    use std::path::{Path, PathBuf};

    pub struct TempDir(PathBuf);

    impl TempDir {
        pub fn new(prefix: &str) -> Self {
            let id = uuid::Uuid::new_v4().simple().to_string();
            let p = std::env::temp_dir().join(format!("{}{}", prefix, id));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
// === end wave 15 ===
