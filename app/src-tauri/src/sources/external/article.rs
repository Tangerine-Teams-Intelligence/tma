//! v3.0 §2.5 — Generic article ingester.
//!
//! User pastes any URL. We fetch the HTML, strip nav / footer / script /
//! style noise, run a Readability-style block extraction over the remaining
//! tree, and write a markdown atom under
//! `<memory_root>/personal/<user>/threads/external/article/<slug>.md`.
//!
//! Why hand-rolled instead of `readability`?
//! =========================================
//! The Rust ecosystem has two ports — `readability` (1MB+ tree of regex
//! crates) and `readable-readability` (dead). Both pull `html5ever` plus a
//! few helpers we don't need elsewhere. Our requirements are simpler: strip
//! tags, keep paragraph + heading structure, fall back gracefully when the
//! page is JS-only. We pair the shared `super::strip_html` with a small
//! block extractor here. Result is a single-file dep, easy to test against
//! sample HTML strings.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{
    resolve_external_dir, rfc3339, slugify_external, strip_html, yaml_scalar, ExternalFetchResult,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArticleCaptureRequest {
    pub url: String,
    /// Optional override for the slug. When set, the file lives at
    /// `external/article/<slug>.md` regardless of the URL's structure.
    #[serde(default)]
    pub slug: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArticleAtomInput<'a> {
    pub url: &'a str,
    pub title: &'a str,
    pub author: &'a str,
    pub markdown: &'a str,
    pub fetched_at: DateTime<Utc>,
}

/// Extract `<title>` from raw HTML. Returns the inner text (HTML-stripped),
/// or empty when no `<title>` is present.
pub fn extract_title(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(open) = lower.find("<title") else {
        return String::new();
    };
    let after = &html[open..];
    let Some(close_lt) = after.find('>') else {
        return String::new();
    };
    let body_start = open + close_lt + 1;
    let body_lower = &lower[body_start..];
    let Some(end) = body_lower.find("</title>") else {
        return String::new();
    };
    strip_html(&html[body_start..body_start + end]).trim().to_string()
}

/// Extract author from common meta tags. Returns empty when none found.
pub fn extract_author(html: &str) -> String {
    for key in [
        "name=\"author\"",
        "property=\"article:author\"",
        "name=\"twitter:creator\"",
    ] {
        if let Some(v) = first_meta_content(html, key) {
            if !v.trim().is_empty() {
                return v.trim().to_string();
            }
        }
    }
    String::new()
}

fn first_meta_content(html: &str, attr_match: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let attr_lower = attr_match.to_ascii_lowercase();
    let mut cursor = 0usize;
    while let Some(rel) = lower[cursor..].find("<meta") {
        let start = cursor + rel;
        let Some(end_rel) = html[start..].find('>') else {
            return None;
        };
        let tag = &html[start..start + end_rel];
        if tag.to_ascii_lowercase().contains(&attr_lower) {
            // Pull `content="..."` off the tag.
            if let Some(c) = tag.to_ascii_lowercase().find("content=") {
                let after = &tag[c + 8..];
                let quote = after.chars().next()?;
                if matches!(quote, '"' | '\'') {
                    let close = after[1..].find(quote)?;
                    return Some(after[1..1 + close].to_string());
                }
            }
        }
        cursor = start + end_rel + 1;
    }
    None
}

/// Reduce raw HTML to markdown-ish plain text. We isolate the `<article>` /
/// `<main>` block when present, otherwise fall back to the whole `<body>`.
/// Then we run `super::strip_html` for tag/entity removal and re-emit
/// paragraph breaks as blank lines.
pub fn html_to_markdown(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let candidate_starts = ["<article", "<main", "<div id=\"content\""];
    let mut best: Option<(usize, &str)> = None;
    for s in &candidate_starts {
        if let Some(off) = lower.find(s) {
            best = Some((off, *s));
            break;
        }
    }
    let region = if let Some((off, opener)) = best {
        let close_pat = match opener {
            "<article" => "</article>",
            "<main" => "</main>",
            _ => "</div>",
        };
        if let Some(end_rel) = lower[off..].find(close_pat) {
            &html[off..off + end_rel + close_pat.len()]
        } else {
            html
        }
    } else {
        html
    };

    let stripped = strip_html(region);
    // Collapse repeated blank lines down to one paragraph break.
    let mut out = String::new();
    let mut prev_blank = false;
    for line in stripped.lines() {
        let t = line.trim_end();
        if t.is_empty() {
            if !prev_blank && !out.is_empty() {
                out.push('\n');
                prev_blank = true;
            }
        } else {
            if prev_blank {
                out.push('\n');
            }
            out.push_str(t);
            out.push('\n');
            prev_blank = false;
        }
    }
    out.trim().to_string()
}

pub fn build_article_atom(input: &ArticleAtomInput) -> String {
    let title = if input.title.is_empty() { "(untitled)".to_string() } else { input.title.to_string() };
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str("source: article\n");
    out.push_str(&format!("url: {}\n", yaml_scalar(input.url)));
    out.push_str(&format!("title: {}\n", yaml_scalar(&title)));
    if !input.author.is_empty() {
        out.push_str(&format!("author: {}\n", yaml_scalar(input.author)));
    }
    out.push_str(&format!("fetched_at: {}\n", yaml_scalar(&rfc3339(&input.fetched_at))));
    out.push_str(&format!(
        "consumed_at: {}\n",
        yaml_scalar(&rfc3339(&input.fetched_at))
    ));
    out.push_str("topic_keys: []\n");
    out.push_str(&format!(
        "summary: {}\n",
        yaml_scalar(&summary_capped(input.markdown, 280))
    ));
    out.push_str("---\n\n");
    out.push_str(&format!("# {}\n\n", title));
    if !input.author.is_empty() {
        out.push_str(&format!("_by {}_\n\n", input.author));
    }
    if !input.markdown.trim().is_empty() {
        out.push_str(input.markdown.trim());
        out.push_str("\n\n");
    }
    out.push_str(&format!("[Source →]({})\n", input.url));
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

pub fn article_dir(memory_root: &Path, current_user: &str) -> PathBuf {
    resolve_external_dir(memory_root, current_user, "article")
}

pub fn article_slug_from_url(url: &str) -> String {
    // Prefer the path's last segment; fall back to the host.
    let stripped = url.trim_start_matches("http://").trim_start_matches("https://");
    let mut segments: Vec<&str> = stripped.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return slugify_external(url);
    }
    let host = segments.remove(0);
    let last = segments.into_iter().rev().find(|s| !s.is_empty()).unwrap_or("");
    if last.is_empty() {
        slugify_external(host)
    } else {
        slugify_external(&format!("{host}-{last}"))
    }
}

pub fn write_article_atom(
    memory_root: &Path,
    current_user: &str,
    input: &ArticleAtomInput,
    explicit_slug: Option<&str>,
) -> std::io::Result<(PathBuf, bool)> {
    let dir = article_dir(memory_root, current_user);
    std::fs::create_dir_all(&dir)?;
    let slug_seed = explicit_slug
        .map(|s| s.to_string())
        .unwrap_or_else(|| article_slug_from_url(input.url));
    let path = dir.join(format!("{}.md", slugify_external(&slug_seed)));
    if path.exists() {
        return Ok((path, false));
    }
    std::fs::write(&path, build_article_atom(input))?;
    Ok((path, true))
}

pub fn ingest_article(
    memory_root: &Path,
    current_user: &str,
    input: &ArticleAtomInput,
    explicit_slug: Option<&str>,
) -> ExternalFetchResult {
    let mut res = ExternalFetchResult::new("article");
    res.items_seen = 1;
    match write_article_atom(memory_root, current_user, input, explicit_slug) {
        Ok((_, true)) => res.atoms_written = 1,
        Ok((_, false)) => {}
        Err(e) => res.errors.push(format!("{}: {}", input.url, e)),
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_HTML: &str = r#"<!doctype html>
<html><head>
<title>The Bitter Lesson</title>
<meta name="author" content="Rich Sutton">
<style>body { color: red; }</style>
</head><body>
<nav>Skip me</nav>
<article>
<h1>The Bitter Lesson</h1>
<p>The biggest lesson that can be read from <b>70 years</b> of AI research is...</p>
<p>...search and learning.</p>
<script>tracking()</script>
</article>
<footer>Footer noise</footer>
</body></html>"#;

    #[test]
    fn article_reader_strips_html_noise() {
        let title = extract_title(SAMPLE_HTML);
        let author = extract_author(SAMPLE_HTML);
        let body = html_to_markdown(SAMPLE_HTML);
        assert_eq!(title, "The Bitter Lesson");
        assert_eq!(author, "Rich Sutton");
        assert!(body.contains("biggest lesson"));
        assert!(body.contains("search and learning"));
        assert!(!body.to_lowercase().contains("tracking()"));
        assert!(!body.contains("color: red"));
        // Nav / footer should not be in the article-region extract.
        assert!(!body.contains("Skip me"));
        assert!(!body.contains("Footer noise"));
    }

    #[test]
    fn build_atom_has_url_and_title() {
        let input = ArticleAtomInput {
            url: "https://incompleteideas.net/IncIdeas/BitterLesson.html",
            title: "The Bitter Lesson",
            author: "Rich Sutton",
            markdown: "Sample body.",
            fetched_at: Utc::now(),
        };
        let body = build_article_atom(&input);
        assert!(body.contains("source: article"));
        assert!(body.contains("url:"));
        assert!(body.contains("# The Bitter Lesson"));
        assert!(body.contains("[Source →]"));
    }

    #[test]
    fn slug_from_url_uses_path_tail() {
        let s = article_slug_from_url("https://incompleteideas.net/IncIdeas/BitterLesson.html");
        assert!(s.contains("incompleteideas-net"));
        assert!(s.contains("bitterlesson-html"));
    }

    #[test]
    fn ingest_writes_atom_idempotent() {
        let dir = std::env::temp_dir().join(format!("tii_art_{}", uuid::Uuid::new_v4().simple()));
        let now = Utc::now();
        let input = ArticleAtomInput {
            url: "https://example.com/post",
            title: "Hello",
            author: "",
            markdown: "Body.",
            fetched_at: now,
        };
        let r1 = ingest_article(&dir, "alice", &input, None);
        assert_eq!(r1.atoms_written, 1);
        let r2 = ingest_article(&dir, "alice", &input, None);
        assert_eq!(r2.atoms_written, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
