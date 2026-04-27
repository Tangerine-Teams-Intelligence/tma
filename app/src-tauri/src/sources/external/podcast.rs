//! v3.0 §2.3 — Podcast reader (RSS feed → optional Whisper transcript).
//!
//! Podcasts are RSS at the wire — we reuse `super::rss::parse_feed` for the
//! XML pass, then read enclosure URLs (`<enclosure url="..." type="audio/..."/>`)
//! for the actual mp3. v3.0-beta.1 lands the metadata pass. The Whisper
//! download + transcribe step is wired through the existing
//! `voice_notes` Python pipeline so we don't add a new transcription dep.
//!
//! Off-by-default: per v3.0 §5.1 the podcast row defaults to off (heavy on
//! CPU + bandwidth). When the user opts in we run transcription async on a
//! background tokio task.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{
    resolve_external_dir, rfc3339, rss::parse_feed, rss::RssEntry, slugify_external, strip_html,
    yaml_scalar, ExternalFetchResult,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PodcastFeed {
    pub url: String,
    /// Optional human-readable title (fetched from feed on first poll).
    #[serde(default)]
    pub title: Option<String>,
    /// Per-feed slug for the directory. Stable across polls.
    #[serde(default)]
    pub slug: Option<String>,
    /// Whether to run Whisper on each new episode. Default false (heavy).
    #[serde(default)]
    pub transcribe: bool,
}

impl PodcastFeed {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            title: None,
            slug: None,
            transcribe: false,
        }
    }

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
        let host = self
            .url
            .split("://")
            .nth(1)
            .unwrap_or(&self.url)
            .split('/')
            .next()
            .unwrap_or("podcast");
        slugify_external(host)
    }
}

/// Episode after parsing. Mirrors `RssEntry` but adds the audio enclosure +
/// duration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PodcastEpisode {
    pub episode_id: String,
    pub title: String,
    pub episode_url: String,
    pub audio_url: String,
    pub published: Option<DateTime<Utc>>,
    pub description: String,
    /// Seconds. `None` when the feed doesn't expose `<itunes:duration>`.
    pub duration_sec: Option<u64>,
}

/// Parse a podcast RSS payload into a list of episodes. Reuses the generic
/// RSS parser for the entry pass + extracts the enclosure URL + duration
/// from each `<item>` block via a second tolerant scan.
pub fn parse_podcast_feed(raw: &str) -> Result<Vec<PodcastEpisode>, String> {
    let entries = parse_feed(raw)?;
    let lower = raw.to_ascii_lowercase();
    let mut episodes = Vec::with_capacity(entries.len());
    let mut cursor = 0usize;
    let item_open = if lower.contains("<entry") { "<entry" } else { "<item" };
    let item_close = if lower.contains("<entry") { "</entry>" } else { "</item>" };
    for e in entries {
        let Some(rel) = lower[cursor..].find(item_open) else {
            episodes.push(episode_from_entry(e, "", None));
            continue;
        };
        let item_start = cursor + rel;
        let Some(end_rel) = lower[item_start..].find(item_close) else {
            episodes.push(episode_from_entry(e, "", None));
            continue;
        };
        let item_end = item_start + end_rel;
        let item_xml = &raw[item_start..item_end];
        let audio_url = extract_enclosure_url(item_xml).unwrap_or_default();
        let duration_sec = extract_itunes_duration(item_xml);
        episodes.push(episode_from_entry(e, &audio_url, duration_sec));
        cursor = item_end + item_close.len();
    }
    Ok(episodes)
}

fn episode_from_entry(e: RssEntry, audio_url: &str, duration_sec: Option<u64>) -> PodcastEpisode {
    PodcastEpisode {
        episode_id: e.id.clone(),
        title: e.title,
        episode_url: e.link,
        audio_url: audio_url.to_string(),
        published: e.published,
        description: e.summary,
        duration_sec,
    }
}

fn extract_enclosure_url(item_xml: &str) -> Option<String> {
    let lower = item_xml.to_ascii_lowercase();
    let key = "<enclosure";
    let start = lower.find(key)?;
    let after = &item_xml[start..];
    let end = after.find('>')?;
    let tag = &after[..end];
    let lower_tag = tag.to_ascii_lowercase();
    let url_pos = lower_tag.find("url=")?;
    let after_url = &tag[url_pos + 4..];
    let quote = after_url.chars().next()?;
    if !matches!(quote, '"' | '\'') {
        return None;
    }
    let close = after_url[1..].find(quote)?;
    Some(after_url[1..1 + close].to_string())
}

fn extract_itunes_duration(item_xml: &str) -> Option<u64> {
    // `<itunes:duration>HH:MM:SS</itunes:duration>` or plain seconds.
    let lower = item_xml.to_ascii_lowercase();
    let key = "<itunes:duration";
    let start = lower.find(key)?;
    let after = &item_xml[start..];
    let body_start = after.find('>')? + 1;
    let body_end = after[body_start..].find("</itunes:duration>")?;
    let raw = after[body_start..body_start + body_end].trim();
    parse_duration(raw)
}

fn parse_duration(s: &str) -> Option<u64> {
    if let Ok(n) = s.parse::<u64>() {
        return Some(n);
    }
    let parts: Vec<&str> = s.split(':').collect();
    let nums: Result<Vec<u64>, _> = parts.iter().map(|p| p.parse::<u64>()).collect();
    let nums = nums.ok()?;
    let secs = match nums.len() {
        1 => nums[0],
        2 => nums[0] * 60 + nums[1],
        3 => nums[0] * 3600 + nums[1] * 60 + nums[2],
        _ => return None,
    };
    Some(secs)
}

/// Build the markdown atom for one episode. Body carries the description
/// (or the transcript when Whisper has run).
pub fn build_podcast_atom(
    feed: &PodcastFeed,
    ep: &PodcastEpisode,
    fetched_at: &DateTime<Utc>,
    transcript: Option<&str>,
) -> String {
    let title = if ep.title.is_empty() { "(untitled)".to_string() } else { ep.title.clone() };
    let published = ep
        .published
        .as_ref()
        .map(rfc3339)
        .unwrap_or_else(|| rfc3339(fetched_at));
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str("source: podcast\n");
    if let Some(t) = &feed.title {
        out.push_str(&format!("podcast_name: {}\n", yaml_scalar(t)));
    }
    out.push_str(&format!("feed_url: {}\n", yaml_scalar(&feed.url)));
    out.push_str(&format!("episode_title: {}\n", yaml_scalar(&title)));
    out.push_str(&format!("episode_url: {}\n", yaml_scalar(&ep.episode_url)));
    out.push_str(&format!("audio_url: {}\n", yaml_scalar(&ep.audio_url)));
    out.push_str(&format!("published: {}\n", yaml_scalar(&published)));
    if let Some(d) = ep.duration_sec {
        out.push_str(&format!("duration_sec: {}\n", d));
    }
    out.push_str(&format!("consumed_at: {}\n", yaml_scalar(&rfc3339(fetched_at))));
    out.push_str("topic_keys: []\n");
    let summary_seed = transcript.unwrap_or(&ep.description);
    out.push_str(&format!(
        "summary: {}\n",
        yaml_scalar(&summary_capped(summary_seed, 280))
    ));
    out.push_str("---\n\n");
    out.push_str(&format!("# {}\n\n", title));
    if !ep.description.is_empty() {
        out.push_str(&strip_html(&ep.description));
        out.push_str("\n\n");
    }
    if let Some(tr) = transcript {
        if !tr.trim().is_empty() {
            out.push_str("## Transcript\n\n");
            out.push_str(tr.trim());
            out.push_str("\n\n");
        }
    }
    if !ep.episode_url.is_empty() {
        out.push_str(&format!("[Episode page →]({})\n", ep.episode_url));
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

pub fn episode_dir_for(memory_root: &Path, current_user: &str, feed: &PodcastFeed) -> PathBuf {
    resolve_external_dir(memory_root, current_user, "podcast").join(feed.resolve_slug())
}

pub fn write_episode_atom(
    memory_root: &Path,
    current_user: &str,
    feed: &PodcastFeed,
    ep: &PodcastEpisode,
    fetched_at: &DateTime<Utc>,
    transcript: Option<&str>,
) -> std::io::Result<bool> {
    let dir = episode_dir_for(memory_root, current_user, feed);
    std::fs::create_dir_all(&dir)?;
    let seed = if !ep.title.is_empty() { ep.title.clone() } else { ep.episode_url.clone() };
    let path = dir.join(format!("{}.md", slugify_external(&seed)));
    if path.exists() {
        return Ok(false);
    }
    std::fs::write(path, build_podcast_atom(feed, ep, fetched_at, transcript))?;
    Ok(true)
}

pub fn ingest_parsed_episodes(
    memory_root: &Path,
    current_user: &str,
    feed: &PodcastFeed,
    episodes: &[PodcastEpisode],
    fetched_at: &DateTime<Utc>,
) -> ExternalFetchResult {
    let mut res = ExternalFetchResult::new("podcast");
    res.items_seen = episodes.len() as u32;
    for ep in episodes {
        // Transcript is None at ingest time — the transcribe step runs on
        // a separate pipeline and rewrites the atom in-place via
        // `write_episode_atom` once the audio has been processed.
        match write_episode_atom(memory_root, current_user, feed, ep, fetched_at, None) {
            Ok(true) => res.atoms_written = res.atoms_written.saturating_add(1),
            Ok(false) => {}
            Err(err) => res.errors.push(format!("{}: {err}", ep.episode_url)),
        }
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_PODCAST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Lex Fridman Podcast</title>
    <item>
      <title>Episode 421 — Sam Altman</title>
      <link>https://lexfridman.com/sam-altman-2</link>
      <pubDate>Mon, 21 Apr 2026 14:00:00 +0000</pubDate>
      <description>A long conversation about AGI.</description>
      <enclosure url="https://media.lex.fm/421.mp3" type="audio/mpeg" length="123456"/>
      <itunes:duration>02:30:00</itunes:duration>
    </item>
  </channel>
</rss>"#;

    #[test]
    fn parses_podcast_feed_with_enclosure() {
        let eps = parse_podcast_feed(SAMPLE_PODCAST).expect("parse");
        assert_eq!(eps.len(), 1);
        let ep = &eps[0];
        assert_eq!(ep.title, "Episode 421 — Sam Altman");
        assert_eq!(ep.audio_url, "https://media.lex.fm/421.mp3");
        assert_eq!(ep.duration_sec, Some(2 * 3600 + 30 * 60));
    }

    #[test]
    fn duration_parsing_handles_seconds_and_hms() {
        assert_eq!(parse_duration("3600"), Some(3600));
        assert_eq!(parse_duration("01:00:00"), Some(3600));
        assert_eq!(parse_duration("30:00"), Some(30 * 60));
        assert_eq!(parse_duration("garbage"), None);
    }

    #[test]
    fn build_atom_includes_transcript_when_present() {
        let feed = PodcastFeed {
            url: "https://lexfridman.com/feed".into(),
            title: Some("Lex".into()),
            slug: None,
            transcribe: true,
        };
        let ep = parse_podcast_feed(SAMPLE_PODCAST).unwrap().pop().unwrap();
        let body = build_podcast_atom(
            &feed,
            &ep,
            &Utc::now(),
            Some("[00:00] Hello and welcome."),
        );
        assert!(body.contains("source: podcast"));
        assert!(body.contains("audio_url:"));
        assert!(body.contains("## Transcript"));
        assert!(body.contains("Hello and welcome"));
    }

    #[test]
    fn ingest_writes_atom_for_new_episode() {
        let dir = std::env::temp_dir().join(format!("tii_podcast_{}", uuid::Uuid::new_v4().simple()));
        let feed = PodcastFeed::new("https://lexfridman.com/feed");
        let eps = parse_podcast_feed(SAMPLE_PODCAST).unwrap();
        let r = ingest_parsed_episodes(&dir, "alice", &feed, &eps, &Utc::now());
        assert_eq!(r.atoms_written, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
