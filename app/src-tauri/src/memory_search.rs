//! Pure-Rust port of `mcp-server/src/memory.ts` so the in-process ws server
//! can serve the browser extension without depending on a global `npx`.
//!
//! Behaviour mirrors the TypeScript original for shape compatibility:
//!   * Recursive walk over `<root>/**/*.md` (skip dotfiles + node_modules)
//!   * YAML frontmatter parsed if present (`---\n…\n---`) → title pulled
//!     from `frontmatter.title` else falls back to filename without `.md`.
//!   * Case-insensitive substring search across the body (after frontmatter
//!     strip), sorted by descending match count then path ascending.
//!   * Snippet = ~200 chars centred on the first match, whitespace flattened,
//!     `...` ellipses on either end.
//!   * Preview = first 4000 chars of the body (CONTENT_PREVIEW_CHARS).
//!   * Hard cap MAX_FILES = 1000 to bound walk cost.
//!
//! Logging goes through `tracing::warn` rather than stderr (the desktop app
//! has no JSONRPC stdout convention to protect, unlike mcp-server).

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Max files we'll touch in a single walk. Mirrors mcp-server.
pub const MAX_FILES: usize = 1000;
/// Max body bytes returned in a single payload. Mirrors mcp-server.
pub const CONTENT_PREVIEW_CHARS: usize = 4000;
/// Snippet window characters either side of the matched substring.
const SNIPPET_CONTEXT: usize = 120;

/// One memory file as we cache it during a walk. Public so the integration
/// tests can poke at the parsed shape without going through the search path.
#[derive(Debug, Clone)]
pub struct MemoryFile {
    /// Path relative to the memory root, with forward slashes.
    pub rel_path: String,
    /// Absolute path on disk.
    pub abs_path: PathBuf,
    /// Body of the file with frontmatter stripped.
    pub body: String,
    /// Title from frontmatter or filename without `.md`.
    pub title: String,
}

/// Wire-protocol shape served back to the browser extension. Field names match
/// `browser-ext/src/shared/types.ts::MemoryResult` exactly so we can
/// serialise straight to JSON without an adapter layer.
///
/// The `file` field is the **absolute** path (not the rel_path) because the
/// extension's "open in editor" affordance needs to round-trip through the
/// `op: file` request and that path is then handed to the OS shell.
#[derive(Debug, Serialize, Clone)]
pub struct SearchHit {
    /// Absolute path to the source memory file.
    pub file: String,
    /// Display title (frontmatter `title` else filename).
    pub title: String,
    /// Short matched snippet (~200 chars).
    pub snippet: String,
    /// Longer preview pasted into the AI prompt (~CONTENT_PREVIEW_CHARS).
    pub preview: String,
    /// Relevance score 0..1. Higher is better. Currently `matches/(matches+1)`
    /// so a 1-match file scores 0.5 and a 9-match file scores 0.9 — purely so
    /// the extension can sort by descending score the same way the
    /// MCP path does.
    pub score: f32,
}

/// Walk `root` (recursively) and return every `.md` file, parsed.
///
/// Returns an empty Vec when `root` doesn't exist — callers treat that as
/// "no memory yet, return zero results" rather than an error condition.
pub fn walk_memory_root(root: &Path) -> Vec<MemoryFile> {
    if !root.is_dir() {
        return Vec::new();
    }
    let mut out: Vec<MemoryFile> = Vec::new();
    walk_dir(root, root, &mut out);
    out
}

fn walk_dir(current: &Path, root: &Path, out: &mut Vec<MemoryFile>) {
    if out.len() >= MAX_FILES {
        return;
    }
    let entries = match std::fs::read_dir(current) {
        Ok(e) => e,
        Err(err) => {
            tracing::warn!(
                path = %current.display(),
                error = %err,
                "memory_search: readdir failed"
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
        // Skip dotfiles + the usual JS noise. Mirrors mcp-server.
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
        } else if ty.is_file() && name_str.to_ascii_lowercase().ends_with(".md") {
            match std::fs::read_to_string(&abs) {
                Ok(raw) => {
                    let (frontmatter_title, body) = parse_frontmatter(&raw);
                    let title = frontmatter_title.unwrap_or_else(|| {
                        name_str.trim_end_matches(".md")
                            .trim_end_matches(".MD")
                            .to_string()
                    });
                    let rel_path = match abs.strip_prefix(root) {
                        Ok(rel) => rel
                            .to_string_lossy()
                            .replace('\\', "/")
                            .to_string(),
                        Err(_) => abs.to_string_lossy().to_string(),
                    };
                    out.push(MemoryFile {
                        rel_path,
                        abs_path: abs.clone(),
                        body,
                        title,
                    });
                }
                Err(err) => {
                    tracing::warn!(
                        path = %abs.display(),
                        error = %err,
                        "memory_search: read file failed"
                    );
                }
            }
        }
    }
}

/// Strip a leading `---\n…\n---` YAML block. Returns (title from
/// frontmatter, body). We deliberately do a manual parse rather than pull in
/// `serde_yaml` for this tiny task — frontmatter blocks are short, line
/// boundaries are simple, and we only care about the `title:` field.
fn parse_frontmatter(raw: &str) -> (Option<String>, String) {
    // Fast path: no frontmatter sentinel.
    let head = raw.trim_start_matches('\u{feff}'); // BOM
    if !head.starts_with("---") {
        return (None, raw.to_string());
    }
    // Frontmatter must end with a `\n---\n` (or `\r\n---\r\n`) line.
    // Find the closing `---` anchored to its own line, after the first `\n`.
    let after_open = match head.find('\n') {
        Some(i) => &head[i + 1..],
        None => return (None, raw.to_string()),
    };
    // Look for `\n---\n` or `\n---\r\n` or `\n---` at EOF.
    let close_rel = after_open
        .find("\n---\n")
        .or_else(|| after_open.find("\n---\r\n"))
        .or_else(|| {
            // Allow a trailing `\n---` with no further newline (last line).
            if after_open.ends_with("\n---") {
                Some(after_open.len() - 4)
            } else {
                None
            }
        });
    let close_idx = match close_rel {
        Some(i) => i,
        None => return (None, raw.to_string()),
    };
    let yaml_block = &after_open[..close_idx];
    // Body starts after the closing fence + newline.
    let after_close = &after_open[close_idx..];
    let body_start = if let Some(stripped) = after_close.strip_prefix("\n---\n") {
        // standard `\n---\n` → body is whatever follows
        stripped
    } else if let Some(stripped) = after_close.strip_prefix("\n---\r\n") {
        stripped
    } else {
        // Trailing `\n---` only — body is empty.
        ""
    };
    // Pull `title:` out of the YAML block. Cheap line-based scan; we don't
    // need full YAML semantics.
    let mut title: Option<String> = None;
    for line in yaml_block.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("title:") {
            let value = rest
                .trim()
                .trim_matches(|c: char| c == '"' || c == '\'')
                .trim();
            if !value.is_empty() {
                title = Some(value.to_string());
                break;
            }
        }
    }
    (title, body_start.to_string())
}

/// Case-insensitive substring search across `files`. Returns top `limit`
/// hits sorted by descending match count, ties broken by path ascending.
///
/// `limit` is clamped to 1..=20 to mirror mcp-server's contract.
pub fn search_memory(files: &[MemoryFile], query: &str, limit: usize) -> Vec<SearchHit> {
    let q = query.trim();
    if q.is_empty() {
        return Vec::new();
    }
    let needle = q.to_lowercase();
    let cap = limit.clamp(1, 20);

    // Score each file: count of needle occurrences. Skip files with zero.
    let mut scored: Vec<(usize, &MemoryFile, usize)> = Vec::new();
    for f in files {
        let haystack = f.body.to_lowercase();
        let mut count = 0usize;
        let mut idx = 0usize;
        let first_match = haystack.find(&needle);
        if first_match.is_none() {
            continue;
        }
        // Count all matches for ranking.
        while let Some(found) = haystack[idx..].find(&needle) {
            count += 1;
            idx += found + needle.len();
            if idx >= haystack.len() {
                break;
            }
        }
        scored.push((count, f, first_match.unwrap()));
    }

    scored.sort_by(|a, b| {
        // descending count, ascending rel_path (stable, deterministic)
        b.0.cmp(&a.0).then_with(|| a.1.rel_path.cmp(&b.1.rel_path))
    });

    scored
        .into_iter()
        .take(cap)
        .map(|(matches, f, first)| {
            let snippet = snippet_around(&f.body, first, needle.len());
            let preview = take_chars(&f.body, CONTENT_PREVIEW_CHARS);
            SearchHit {
                file: f.abs_path.to_string_lossy().to_string(),
                title: f.title.clone(),
                snippet,
                preview,
                // matches / (matches + 1) → 0.5 for 1, 0.667 for 2, 0.9 for 9.
                // Same monotonic ordering as `matches`, just normalised so the
                // browser ext can show a 0..1 score without surprise.
                score: matches as f32 / (matches as f32 + 1.0),
            }
        })
        .collect()
}

/// Char-aware slice that won't panic on multi-byte boundaries (the lowercase
/// + body string is UTF-8; matches found by byte-index `find` are byte-safe
/// for ASCII queries but Chinese tags like `决策` would not be — so we work
/// in chars for the snippet window).
fn snippet_around(body: &str, byte_match: usize, needle_byte_len: usize) -> String {
    // Convert byte positions to char positions for SNIPPET_CONTEXT chars
    // either side. We round to char boundaries by walking from start.
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
        .take_while(|(b, _)| *b < needle_byte_len)
        .count();
    let start_char = chars_before_match.saturating_sub(SNIPPET_CONTEXT);
    let end_char = (chars_before_match + needle_chars + SNIPPET_CONTEXT).min(total_chars);
    let mut s: String = body
        .chars()
        .skip(start_char)
        .take(end_char - start_char)
        .collect();
    // Flatten whitespace runs to single spaces.
    s = s
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    if start_char > 0 {
        s = format!("...{}", s);
    }
    if end_char < total_chars {
        s = format!("{}...", s);
    }
    s
}

/// Take the first `n` chars of `body` without panicking on UTF-8 boundaries.
fn take_chars(body: &str, n: usize) -> String {
    body.chars().take(n).collect()
}

/// Read a single memory file by path relative to `root`. Returns None if the
/// resolved absolute path is outside the root (defends against `../` escapes
/// from the ws client) or the file doesn't exist.
pub fn read_memory_file(root: &Path, rel_path: &str) -> Option<(PathBuf, String)> {
    let safe_rel = rel_path.trim_start_matches(['/', '\\']);
    let abs = root.join(safe_rel);
    let canon_root = std::fs::canonicalize(root).ok()?;
    let canon_abs = std::fs::canonicalize(&abs).ok()?;
    if !canon_abs.starts_with(&canon_root) {
        return None;
    }
    let raw = std::fs::read_to_string(&canon_abs).ok()?;
    Some((canon_abs, raw))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmpdir() -> tempdir_like::TempDir {
        tempdir_like::TempDir::new("tangerine_memsearch_")
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
    fn empty_root_returns_empty() {
        let td = tmpdir();
        let files = walk_memory_root(td.path());
        assert!(files.is_empty());
    }

    #[test]
    fn missing_root_is_not_an_error() {
        let files = walk_memory_root(Path::new("/totally/not/a/real/path/zzz"));
        assert!(files.is_empty());
    }

    #[test]
    fn walks_subfolders_skips_dotfiles_and_nodemodules() {
        let td = tmpdir();
        write_md(td.path(), "people/alice.md", "# Alice\nalice notes");
        write_md(td.path(), "decisions/d1.md", "# D1\nshipping postgres");
        write_md(td.path(), ".git/config.md", "should-skip");
        write_md(
            td.path(),
            "node_modules/foo/readme.md",
            "should-skip",
        );
        let files = walk_memory_root(td.path());
        let names: Vec<_> = files.iter().map(|f| f.rel_path.clone()).collect();
        assert_eq!(names.len(), 2);
        assert!(names.contains(&"people/alice.md".to_string()));
        assert!(names.contains(&"decisions/d1.md".to_string()));
    }

    #[test]
    fn frontmatter_title_takes_precedence_over_filename() {
        let td = tmpdir();
        write_md(
            td.path(),
            "x.md",
            "---\ntitle: Real Title\nfoo: bar\n---\nbody text",
        );
        let files = walk_memory_root(td.path());
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].title, "Real Title");
        assert_eq!(files[0].body, "body text");
    }

    #[test]
    fn no_frontmatter_falls_back_to_filename() {
        let td = tmpdir();
        write_md(td.path(), "no-fm.md", "just a body");
        let files = walk_memory_root(td.path());
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].title, "no-fm");
        assert_eq!(files[0].body, "just a body");
    }

    #[test]
    fn search_is_case_insensitive_substring() {
        let td = tmpdir();
        write_md(
            td.path(),
            "a.md",
            "We chose Postgres for the team.",
        );
        write_md(td.path(), "b.md", "no match here");
        write_md(td.path(), "c.md", "POSTGRES POSTGRES POSTGRES");
        let files = walk_memory_root(td.path());
        let hits = search_memory(&files, "postgres", 5);
        assert_eq!(hits.len(), 2);
        // c.md has 3 matches → ranks first.
        assert!(hits[0].file.ends_with("c.md"));
        assert!(hits[1].file.ends_with("a.md"));
    }

    #[test]
    fn empty_query_returns_no_results() {
        let td = tmpdir();
        write_md(td.path(), "a.md", "anything");
        let files = walk_memory_root(td.path());
        assert!(search_memory(&files, "", 5).is_empty());
        assert!(search_memory(&files, "   ", 5).is_empty());
    }

    #[test]
    fn snippet_includes_context_around_match() {
        let td = tmpdir();
        let body = format!("{}MATCHED{}", "x".repeat(300), "y".repeat(300));
        write_md(td.path(), "a.md", &body);
        let files = walk_memory_root(td.path());
        let hits = search_memory(&files, "matched", 1);
        assert_eq!(hits.len(), 1);
        // Snippet should start with `...`, contain MATCHED, end with `...`.
        assert!(hits[0].snippet.starts_with("..."));
        assert!(hits[0].snippet.contains("MATCHED"));
        assert!(hits[0].snippet.ends_with("..."));
    }

    #[test]
    fn read_memory_file_blocks_path_escape() {
        let td = tmpdir();
        write_md(td.path(), "ok.md", "ok body");
        // Escape attempt — should return None.
        assert!(read_memory_file(td.path(), "../../../etc/passwd").is_none());
        // Legit lookup works.
        let res = read_memory_file(td.path(), "ok.md");
        assert!(res.is_some());
        let (_p, content) = res.unwrap();
        assert_eq!(content, "ok body");
    }
}

// ---------------------------------------------------------------------------
// Tiny in-tree tempdir helper. We don't depend on the `tempfile` crate just
// for tests — std::env::temp_dir + a UUID is enough and keeps the dep tree
// lean (the deployment iron rules call out keeping deps minimal).
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
