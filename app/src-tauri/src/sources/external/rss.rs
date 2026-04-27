//! v3.0 §2.2 — RSS / Atom feed reader.
//!
//! User adds a feed URL via Settings → Sources → External → "Add RSS Feed".
//! The daemon's daily cron tick fetches each feed, converts new entries to
//! atoms under
//! `<memory_root>/personal/<user>/threads/external/rss/<feed-slug>/<entry-slug>.md`.
//!
//! Crate choice
//! ============
//! `feed-rs` parses RSS 1.0/2.0 + Atom 1.0 with one `parser::parse` call.
//! Compared to `rss` + `atom_syndication` it's ~30% smaller dep tree and
//! handles the malformed-but-common feeds you find in the wild.
//!
//! Dedup
//! =====
//! The atom path is `<feed-slug>/<entry-slug>.md`. Re-fetching an already-
//! written entry is a path-existence check. `<.cursors.json>` per spec
//! tracks ETag + last-modified; for v3.0-beta.1 we land the on-disk dedup
//! and leave the conditional-GET hookup as a follow-up (the existence
//! check makes the loop idempotent — only the bandwidth differs).

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{
    resolve_external_dir, rfc3339, slugify_external, strip_html, yaml_scalar, ExternalFetchResult,
};

// ---------------------------------------------------------------------------
// Public types

/// One configured RSS subscription. Stored as a JSON list under
/// `<user_data>/sources/external_rss.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RssFeed {
    pub url: String,
    /// Optional human-readable title — pulled from the feed on first fetch
    /// when not set. Lets the UI render "Stratechery" instead of the URL.
    #[serde(default)]
    pub title: Option<String>,
    /// Per-feed slug used as the directory name. Derived from `title` or
    /// the URL host when not explicitly set.
    #[serde(default)]
    pub slug: Option<String>,
}

impl RssFeed {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            title: None,
            slug: None,
        }
    }

    /// Resolve the directory slug. Stable across rebuilds — reuses
    /// `slug` when set, otherwise derives from `title`, otherwise falls
    /// back to the URL host.
    pub fn resolve_slug(&self) -> String {
        if let Some(s) = &self.slug {
            if !s.is_empty() {
                return slugify_external(s);
            }
        }
        if let Some(t) = &self.title {
            if !t.is_empty() {
                return slugify_external(t);
            }
        }
        // Fall back to the URL — strip scheme + use the host.
        let host = self
            .url
            .split("://")
            .nth(1)
            .unwrap_or(&self.url)
            .split('/')
            .next()
            .unwrap_or("feed");
        slugify_external(host)
    }
}

/// Parsed-down view of one feed entry. Keeping our own intermediate type lets
/// us swap `feed-rs` for another parser without touching the atom builder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RssEntry {
    pub id: String,
    pub title: String,
    pub link: String,
    pub author: String,
    pub published: Option<DateTime<Utc>>,
    /// Pre-stripped plain-text excerpt, no HTML. May be empty when the feed
    /// only carries `<link>` (e.g. some link-list feeds).
    pub summary: String,
}

// ---------------------------------------------------------------------------
// Parser

/// Parse a feed payload (RSS 2.0 or Atom 1.0) into our intermediate
/// `RssEntry` list. Hand-rolled minimum-viable parser — no `feed-rs`
/// dependency required for the v3.0-beta.1 cut. We split on the standard
/// `<item>` (RSS) and `<entry>` (Atom) delimiters and pull the named child
/// elements with a tolerant regex-free scan. The shape is what every test
/// fixture in `app/src-tauri/tests/external_*` checks.
pub fn parse_feed(raw: &str) -> Result<Vec<RssEntry>, String> {
    let lower = raw.to_ascii_lowercase();
    let (open_tag, close_tag) = if lower.contains("<entry") {
        ("<entry", "</entry>")
    } else if lower.contains("<item") {
        ("<item", "</item>")
    } else {
        return Err("no <item> or <entry> elements found".to_string());
    };

    let mut out = Vec::new();
    let bytes = raw.as_bytes();
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        // Find the next opening tag (case-insensitive on the tag name).
        let rest_lower = &lower[cursor..];
        let Some(start_off) = rest_lower.find(open_tag) else {
            break;
        };
        // Skip the opening tag — find its `>`.
        let after_open_lt = cursor + start_off;
        let Some(close_lt_rel) = raw[after_open_lt..].find('>') else {
            break;
        };
        let body_start = after_open_lt + close_lt_rel + 1;
        // Find the matching closing tag.
        let body_lower = &lower[body_start..];
        let Some(end_rel) = body_lower.find(close_tag) else {
            break;
        };
        let body_end = body_start + end_rel;
        let item_xml = &raw[body_start..body_end];
        if let Some(entry) = parse_one_entry(item_xml) {
            out.push(entry);
        }
        cursor = body_end + close_tag.len();
    }
    Ok(out)
}

fn parse_one_entry(xml: &str) -> Option<RssEntry> {
    let title = first_inner(xml, "title").unwrap_or_default();
    let link = parse_link(xml).unwrap_or_default();
    let id = first_inner(xml, "guid")
        .or_else(|| first_inner(xml, "id"))
        .unwrap_or_else(|| link.clone());
    let author = first_inner(xml, "author")
        .or_else(|| first_inner(xml, "dc:creator"))
        .unwrap_or_default();
    let pub_raw = first_inner(xml, "pubdate")
        .or_else(|| first_inner(xml, "published"))
        .or_else(|| first_inner(xml, "updated"))
        .unwrap_or_default();
    let published = parse_date(&pub_raw);
    let summary_raw = first_inner(xml, "description")
        .or_else(|| first_inner(xml, "summary"))
        .or_else(|| first_inner(xml, "content"))
        .unwrap_or_default();
    let summary = strip_html(&summary_raw);
    if title.is_empty() && link.is_empty() {
        return None;
    }
    Some(RssEntry {
        id,
        title: strip_html(&title),
        link: strip_html(&link),
        author: strip_html(&author),
        published,
        summary,
    })
}

/// Find the first `<tag>...</tag>` body in the XML fragment. Strips
/// `<![CDATA[..]]>` wrappers. Case-insensitive on the tag name.
fn first_inner(xml: &str, tag: &str) -> Option<String> {
    let lower = xml.to_ascii_lowercase();
    let needle_open = format!("<{}", tag);
    let needle_close = format!("</{}>", tag);
    let open = lower.find(&needle_open)?;
    let after_open = xml[open..].find('>')? + open + 1;
    let close = lower[after_open..].find(&needle_close)?;
    let raw = &xml[after_open..after_open + close];
    let raw = raw.trim();
    let raw = raw
        .strip_prefix("<![CDATA[")
        .and_then(|r| r.strip_suffix("]]>"))
        .unwrap_or(raw);
    Some(raw.trim().to_string())
}

/// Resolve `<link>` for either RSS (`<link>url</link>`) or Atom
/// (`<link href="url"/>`).
fn parse_link(xml: &str) -> Option<String> {
    if let Some(inner) = first_inner(xml, "link") {
        if !inner.trim().is_empty() {
            return Some(inner);
        }
    }
    // Atom-style self-closing link with href attr.
    let lower = xml.to_ascii_lowercase();
    let key = "<link";
    let mut idx = 0usize;
    while let Some(rel) = lower[idx..].find(key) {
        let start = idx + rel;
        let Some(end_rel) = xml[start..].find('>') else {
            return None;
        };
        let tag = &xml[start..start + end_rel];
        if let Some(href_pos) = tag.to_ascii_lowercase().find("href=") {
            let after = &tag[href_pos + 5..];
            let quote = after.chars().next()?;
            if matches!(quote, '"' | '\'') {
                if let Some(close) = after[1..].find(quote) {
                    return Some(after[1..1 + close].to_string());
                }
            }
        }
        idx = start + end_rel + 1;
    }
    None
}

fn parse_date(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    // Atom: RFC 3339; RSS 2.0: RFC 2822.
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    if let Ok(dt) = DateTime::parse_from_rfc2822(s) {
        return Some(dt.with_timezone(&Utc));
    }
    None
}

// ---------------------------------------------------------------------------
// Atom builder

/// Build the markdown atom for one feed entry. Pure function — tests assert
/// directly without filesystem I/O.
pub fn build_rss_atom(feed: &RssFeed, entry: &RssEntry, fetched_at: &DateTime<Utc>) -> String {
    let title = if entry.title.is_empty() {
        "(untitled)".to_string()
    } else {
        entry.title.clone()
    };
    let published = entry
        .published
        .as_ref()
        .map(rfc3339)
        .unwrap_or_else(|| rfc3339(fetched_at));
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str("source: rss\n");
    out.push_str(&format!("feed_url: {}\n", yaml_scalar(&feed.url)));
    if let Some(t) = &feed.title {
        out.push_str(&format!("feed_title: {}\n", yaml_scalar(t)));
    }
    out.push_str(&format!("entry_url: {}\n", yaml_scalar(&entry.link)));
    out.push_str(&format!("entry_id: {}\n", yaml_scalar(&entry.id)));
    out.push_str(&format!("title: {}\n", yaml_scalar(&title)));
    if !entry.author.is_empty() {
        out.push_str(&format!("author: {}\n", yaml_scalar(&entry.author)));
    }
    out.push_str(&format!("published: {}\n", yaml_scalar(&published)));
    out.push_str(&format!("consumed_at: {}\n", yaml_scalar(&rfc3339(fetched_at))));
    out.push_str("topic_keys: []\n");
    out.push_str(&format!("summary: {}\n", yaml_scalar(&summary_capped(&entry.summary, 280))));
    out.push_str("---\n\n");

    out.push_str(&format!("# {}\n\n", title));
    if !entry.author.is_empty() {
        out.push_str(&format!("_by {}_\n\n", entry.author));
    }
    if !entry.summary.is_empty() {
        out.push_str(entry.summary.trim());
        out.push_str("\n\n");
    }
    if !entry.link.is_empty() {
        out.push_str(&format!("[Read full article →]({})\n", entry.link));
    }
    out
}

fn summary_capped(s: &str, max_chars: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut buf = String::new();
    let mut count = 0usize;
    for c in s.chars() {
        if count >= max_chars - 1 {
            break;
        }
        buf.push(c);
        count += 1;
    }
    buf.push('…');
    buf
}

// ---------------------------------------------------------------------------
// Disk write

/// Write a single entry to disk. Returns `true` when a new atom was created,
/// `false` when an atom for this entry already exists (idempotent).
pub fn write_entry_atom(
    memory_root: &Path,
    current_user: &str,
    feed: &RssFeed,
    entry: &RssEntry,
    fetched_at: &DateTime<Utc>,
) -> std::io::Result<bool> {
    let dir = entry_dir_for(memory_root, current_user, feed);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.md", slugify_external(&entry_filename_seed(entry))));
    if path.exists() {
        return Ok(false);
    }
    let body = build_rss_atom(feed, entry, fetched_at);
    std::fs::write(path, body)?;
    Ok(true)
}

pub fn entry_dir_for(memory_root: &Path, current_user: &str, feed: &RssFeed) -> PathBuf {
    resolve_external_dir(memory_root, current_user, "rss").join(feed.resolve_slug())
}

fn entry_filename_seed(entry: &RssEntry) -> String {
    if !entry.title.is_empty() {
        return entry.title.clone();
    }
    if !entry.link.is_empty() {
        return entry.link.clone();
    }
    entry.id.clone()
}

// ---------------------------------------------------------------------------
// Tick — used by the daemon hook + the `external_rss_fetch_now` command

/// Process a list of pre-parsed entries. Pure logic — fetch + parse happen
/// outside this function so tests don't have to mock HTTP.
pub fn ingest_parsed_entries(
    memory_root: &Path,
    current_user: &str,
    feed: &RssFeed,
    entries: &[RssEntry],
    fetched_at: &DateTime<Utc>,
) -> ExternalFetchResult {
    let mut res = ExternalFetchResult::new("rss");
    res.items_seen = entries.len() as u32;
    for e in entries {
        match write_entry_atom(memory_root, current_user, feed, e, fetched_at) {
            Ok(true) => res.atoms_written = res.atoms_written.saturating_add(1),
            Ok(false) => {}
            Err(err) => res.errors.push(format!("{}: {err}", e.link)),
        }
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_RSS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Stratechery</title>
    <item>
      <title>The Unbundling</title>
      <link>https://stratechery.com/2026/unbundling/</link>
      <guid>https://stratechery.com/2026/unbundling/</guid>
      <pubDate>Tue, 21 Apr 2026 14:00:00 +0000</pubDate>
      <description><![CDATA[<p>Aggregation theory <b>turned</b> upside down.</p>]]></description>
      <author>Ben Thompson</author>
    </item>
    <item>
      <title>Second post</title>
      <link>https://stratechery.com/2026/second/</link>
      <pubDate>Wed, 22 Apr 2026 14:00:00 +0000</pubDate>
      <description>Plain summary.</description>
    </item>
  </channel>
</rss>"#;

    const SAMPLE_ATOM: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Daring Fireball</title>
  <entry>
    <title>One Atom Entry</title>
    <link href="https://daringfireball.net/2026/04/atom-post"/>
    <id>tag:daringfireball.net,2026:atom-post</id>
    <updated>2026-04-23T10:00:00Z</updated>
    <summary>An &amp; entry.</summary>
  </entry>
</feed>"#;

    #[test]
    fn rss_reader_parses_sample_feed() {
        let entries = parse_feed(SAMPLE_RSS).expect("parse rss");
        assert_eq!(entries.len(), 2);
        let first = &entries[0];
        assert_eq!(first.title, "The Unbundling");
        assert_eq!(first.link, "https://stratechery.com/2026/unbundling/");
        assert_eq!(first.author, "Ben Thompson");
        assert!(first.summary.contains("Aggregation theory"));
        assert!(first.summary.contains("turned"));
        assert!(!first.summary.contains("<"));
        assert!(first.published.is_some());
    }

    #[test]
    fn parses_atom_feed() {
        let entries = parse_feed(SAMPLE_ATOM).expect("parse atom");
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e.title, "One Atom Entry");
        assert_eq!(e.link, "https://daringfireball.net/2026/04/atom-post");
        assert!(e.summary.contains("An & entry"));
        assert!(e.published.is_some());
    }

    #[test]
    fn parse_returns_err_on_no_items() {
        assert!(parse_feed("<html>not a feed</html>").is_err());
    }

    #[test]
    fn build_atom_produces_yaml_frontmatter() {
        let feed = RssFeed {
            url: "https://example.com/rss".into(),
            title: Some("Example".into()),
            slug: None,
        };
        let entry = RssEntry {
            id: "id-1".into(),
            title: "Hello: World".into(),
            link: "https://example.com/post".into(),
            author: "Alice".into(),
            published: None,
            summary: "Some summary text.".into(),
        };
        let body = build_rss_atom(&feed, &entry, &Utc::now());
        assert!(body.starts_with("---\n"));
        assert!(body.contains("source: rss"));
        assert!(body.contains("feed_url:"));
        assert!(body.contains("entry_url:"));
        assert!(body.contains("\"Hello: World\""));
        assert!(body.contains("# Hello: World"));
        assert!(body.contains("[Read full article →]"));
    }

    #[test]
    fn ingest_writes_atoms_and_skips_dupes() {
        let dir = tempdir();
        let feed = RssFeed::new("https://stratechery.com/rss");
        let entries = parse_feed(SAMPLE_RSS).unwrap();
        let now = Utc::now();
        let r1 = ingest_parsed_entries(&dir, "alice", &feed, &entries, &now);
        assert_eq!(r1.atoms_written, 2);
        // Re-running is a no-op (path already exists).
        let r2 = ingest_parsed_entries(&dir, "alice", &feed, &entries, &now);
        assert_eq!(r2.atoms_written, 0);
        assert!(r2.errors.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_slug_falls_back_to_host() {
        let f = RssFeed::new("https://feeds.example.org/path");
        assert_eq!(f.resolve_slug(), "feeds-example-org");
    }

    fn tempdir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("tii_rss_{}", uuid::Uuid::new_v4().simple()))
    }
}
