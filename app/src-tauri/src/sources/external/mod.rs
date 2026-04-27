//! v3.0 — Layer 6 external world capture.
//!
//! "Every external thing the user reads, we write into memory." Each submodule
//! ingests one source kind (RSS, podcast, YouTube, generic article) and
//! writes atoms under
//! `<memory_root>/personal/<user>/threads/external/<source-type>/`.
//!
//! Layout mirrors the v1.8 `sources/` writeback adapters:
//!
//!   * `rss.rs`     — RSS / Atom feed reader (uses `feed-rs`)
//!   * `podcast.rs` — podcast RSS + optional Whisper transcription
//!   * `youtube.rs` — paste-to-capture YouTube transcript
//!   * `article.rs` — paste-to-capture generic web article (Readability)
//!
//! Design notes
//! ============
//!
//! * **Atom shape**. Frontmatter at minimum:
//!   `source: <source-type>`, `source_url`, `consumed_at`, `summary`,
//!   `topic_keys: []` plus per-source extras (feed_url, channel, etc.).
//!   Body is markdown — readable as plain text by any reader, indexable by
//!   `memory_search`, and graphable by the co-thinker.
//!
//! * **Personal scope**. v3.0 §5.2 mandates the personal vault never leaves
//!   the device. Writers route through
//!   `memory_paths::resolve_atom_dir(.., AtomScope::Personal, ..)`.
//!
//! * **Opt-in defaults**. Per v3.0 §5.1, every source is off until the user
//!   adds a feed URL / pastes a video URL / saves an article. The daemon
//!   tick is a no-op when no feeds are configured (zero overhead on a fresh
//!   install).
//!
//! * **Test scaffolding**. None of the readers fetch the network in tests:
//!   each parser exposes a pure `parse_*` function the test suite drives
//!   with sample bytes.
//!
//! * **Crate choices**. `feed-rs` for RSS / Atom (one parser handles both).
//!   Generic article uses a hand-rolled HTML stripper rather than a heavy
//!   `readability` crate dep — the tree is already large and the tag
//!   filtering is small. Whisper reuse goes through the existing
//!   `voice_notes` Python pipeline; podcast / YouTube modules call into it
//!   instead of adding a new transcription dep.

pub mod article;
pub mod podcast;
pub mod rss;
pub mod youtube;

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::memory_paths::{resolve_atom_dir, AtomScope};

/// Atom kinds shared across the four external sources. Matches the dir
/// segment under `external/`: `rss`, `podcast`, `youtube`, `article`.
pub const EXTERNAL_KINDS: &[&str] = &["rss", "podcast", "youtube", "article"];

/// Resolve the on-disk directory for one external source kind under the
/// current user's personal vault. Pure path math — caller is responsible for
/// `create_dir_all`.
pub fn resolve_external_dir(memory_root: &Path, current_user: &str, kind: &str) -> PathBuf {
    // The `threads` kind argument routes the user vault under
    // `personal/<user>/threads/`; we then append `external/<kind>/` for the
    // Layer 6 namespace.
    let threads = resolve_atom_dir(memory_root, AtomScope::Personal, current_user, "threads");
    threads.join("external").join(kind)
}

/// Stripped-down result of one tick. Returned by every poll function so the
/// daemon and the manual "fetch now" command can both use the same shape.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExternalFetchResult {
    /// Number of new atoms written this tick.
    pub atoms_written: u32,
    /// Number of items examined (regardless of whether they produced an
    /// atom — dedup means most reruns write 0 atoms).
    pub items_seen: u32,
    /// Per-source label — `rss`, `podcast`, `youtube`, `article`.
    pub kind: String,
    /// Soft errors. The daemon records these; a tick that produced atoms
    /// AND surfaced errors is still considered a success.
    pub errors: Vec<String>,
}

impl ExternalFetchResult {
    pub fn new(kind: impl Into<String>) -> Self {
        Self {
            atoms_written: 0,
            items_seen: 0,
            kind: kind.into(),
            errors: Vec::new(),
        }
    }
}

/// Slugify a free-form title or URL fragment for use as a filename. Same
/// rules as the email source: ASCII alphanumeric + non-ASCII letters, `-`
/// for everything else, capped at 60 chars to keep Windows paths short.
pub fn slugify_external(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_dash = true;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if c.is_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        return "untitled".to_string();
    }
    let mut buf = String::new();
    let mut count = 0usize;
    for c in trimmed.chars() {
        if count >= 60 {
            break;
        }
        buf.push(c);
        count += 1;
    }
    buf.trim_end_matches('-').to_string()
}

/// YAML-quote a scalar value safely. Re-implemented per-module to avoid a
/// shared yaml utility crate; the shape is small and the input is
/// constrained to titles + URLs + ids that we already normalise.
pub(crate) fn yaml_scalar(s: &str) -> String {
    let needs_quote = s.is_empty()
        || s.contains(':')
        || s.contains('#')
        || s.contains('\n')
        || s.starts_with('-')
        || s.starts_with(' ')
        || s.ends_with(' ');
    if needs_quote {
        let escaped = s
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n");
        format!("\"{}\"", escaped)
    } else {
        s.to_string()
    }
}

/// Strip HTML tags + decode the small set of named entities we care about.
/// Drops the inner content of `<script>` / `<style>` blocks so analytics
/// payloads and CSS rules don't leak into our markdown atoms.
pub(crate) fn strip_html(html: &str) -> String {
    // First pass — remove `<script>...</script>` and `<style>...</style>`
    // blocks wholesale. We do this with a regex-free scan: find an opening
    // tag, find its matching closing tag, drop the slice. Case-insensitive
    // match via lowercased index.
    let cleaned = strip_block(html, "script");
    let cleaned = strip_block(&cleaned, "style");

    // Second pass — drop remaining tags + collapse whitespace.
    let mut out = String::with_capacity(cleaned.len());
    let mut in_tag = false;
    let mut tag_buf = String::new();
    let mut last_was_space = false;
    for c in cleaned.chars() {
        if in_tag {
            if c == '>' {
                in_tag = false;
                let lower = tag_buf.to_ascii_lowercase();
                let lower = lower.trim_start_matches('/').trim();
                if matches!(lower, "p" | "br" | "div" | "h1" | "h2" | "h3" | "h4" | "li") {
                    if !out.ends_with('\n') {
                        out.push('\n');
                    }
                    last_was_space = true;
                }
                tag_buf.clear();
                continue;
            }
            tag_buf.push(c);
            continue;
        }
        if c == '<' {
            in_tag = true;
            continue;
        }
        if c.is_whitespace() {
            if !last_was_space {
                out.push(' ');
                last_was_space = true;
            }
            continue;
        }
        out.push(c);
        last_was_space = false;
    }
    decode_named_entities(&out).trim().to_string()
}

fn strip_block(html: &str, tag: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let open_needle = format!("<{tag}");
    let close_needle = format!("</{tag}>");
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0usize;
    while let Some(rel) = lower[cursor..].find(&open_needle) {
        let block_start = cursor + rel;
        out.push_str(&html[cursor..block_start]);
        // Skip the opening tag.
        let Some(open_close_rel) = html[block_start..].find('>') else {
            // Malformed — drop the rest.
            return out;
        };
        let body_start = block_start + open_close_rel + 1;
        // Find the matching closing tag.
        if let Some(close_rel) = lower[body_start..].find(&close_needle) {
            cursor = body_start + close_rel + close_needle.len();
        } else {
            // No closing tag — drop the rest.
            return out;
        }
    }
    out.push_str(&html[cursor..]);
    out
}

fn decode_named_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
        .replace("&hellip;", "…")
}

/// Format a `chrono::DateTime<Utc>` as RFC 3339 string. Convenience wrapper
/// so the source modules don't all import chrono::SecondsFormat.
pub(crate) fn rfc3339(dt: &DateTime<Utc>) -> String {
    dt.to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_keeps_non_ascii() {
        assert_eq!(slugify_external("中文 标题"), "中文-标题");
    }

    #[test]
    fn slug_caps_at_60() {
        let long = "a".repeat(200);
        let s = slugify_external(&long);
        assert!(s.len() <= 60);
    }

    #[test]
    fn slug_falls_back_on_empty() {
        assert_eq!(slugify_external("   ---  "), "untitled");
    }

    #[test]
    fn yaml_scalar_quotes_urls_with_colons() {
        let out = yaml_scalar("https://example.com/x");
        assert!(out.starts_with('"') && out.ends_with('"'));
    }

    #[test]
    fn strip_html_removes_tags() {
        let raw = "<p>Hello <b>world</b>!</p><script>evil()</script>";
        let out = strip_html(raw);
        assert!(out.contains("Hello"));
        assert!(out.contains("world"));
        assert!(!out.contains("<"));
        assert!(!out.to_lowercase().contains("evil"));
    }

    #[test]
    fn strip_html_decodes_entities() {
        let out = strip_html("Tom &amp; Jerry &mdash; classics");
        assert!(out.contains("Tom & Jerry"));
        assert!(out.contains("—"));
    }

    #[test]
    fn resolve_external_dir_routes_under_personal_threads_external() {
        let p = resolve_external_dir(Path::new("/tmp/m"), "alice", "rss");
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("personal/alice/threads/external/rss"), "got {s}");
    }

    #[test]
    fn external_kinds_are_canonical() {
        for k in EXTERNAL_KINDS {
            // Sanity: kinds are url-safe ascii, no spaces.
            assert!(k.chars().all(|c| c.is_ascii_alphanumeric()));
        }
    }
}
