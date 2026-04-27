//! v1.9.0-beta.2 P2-A — Template #4: pattern_recurrence.
//!
//! "You mentioned 'pricing' 7× this week — lock as a project / decision?"
//!
//! Reads the 7-day telemetry window from `crate::agi::telemetry` (loaded once
//! by the heartbeat caller via `read_events_window(memory_root, 168)`),
//! tokenises each event's text-bearing payload field, drops stopwords, and
//! finds keywords that occur ≥ 5 times across `search` + `open_atom` +
//! `edit_atom` events. Each qualifying keyword fires one `TemplateMatch`.
//!
//! Tier: chip. We always populate `surface_id` with the most recent atom
//! path the keyword appeared in, so the bus's `selectTier` lands on chip
//! per the §3.5 rule "surface_id provided → chip".
//!
//! Confidence: 0.7 + 0.05 × (mentions − 5), capped at 0.95. So 5 mentions
//! → 0.7, 10 → 0.95, anything more → 0.95. Above the bus's MIN_CONFIDENCE
//! floor by design.
//!
//! Priority: 5 (default banner-tier mid; chips don't really compete for
//! slots but the bus reads `priority` for telemetry).

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use futures_util::future::BoxFuture;

use super::common::{Template, TemplateContext, TemplateMatch};
use crate::agi::telemetry::TelemetryEvent;

/// Below 5 mentions / week we don't fire — still in the noise band.
const MIN_MENTIONS: u32 = 5;

/// Lower confidence bound (5 mentions). Each additional mention adds 0.05
/// up to the cap at 10 mentions.
const BASE_CONFIDENCE: f32 = 0.7;
const PER_EXTRA_CONFIDENCE: f32 = 0.05;
const MAX_CONFIDENCE: f32 = 0.95;

const CHIP_PRIORITY: u8 = 5;

/// Stopwords dropped during tokenisation. Kept tiny + hard-coded to avoid
/// pulling in a corpus crate; the spec asks for "simple stopword list".
/// All entries are already lowercased.
const STOPWORDS: &[&str] = &[
    "the", "and", "for", "is", "a", "an", "of", "in", "to", "with", "on", "at", "by", "from",
    "as", "be", "this", "that", "it", "i", "we", "you", "he", "she", "they", "or", "but", "if",
    "do", "are", "was", "were", "have", "has", "had", "will", "would", "should", "could", "can",
    "not", "no", "so", "my", "our", "your", "their", "what", "which", "who", "when", "where",
    "why", "how", "any", "some", "all", "more", "most", "other", "into", "than", "then", "out",
    "up", "down", "about", "over", "after", "before", "while", "until", "very",
];

pub struct PatternRecurrence;

impl Template for PatternRecurrence {
    fn name(&self) -> &'static str {
        "pattern_recurrence"
    }

    fn evaluate<'a>(
        &'a self,
        ctx: &'a TemplateContext<'a>,
    ) -> BoxFuture<'a, Vec<TemplateMatch>> {
        Box::pin(async move { evaluate_window(&ctx.recent_telemetry) })
    }
}

/// Pure helper. Public to the crate so the unit tests can hit it directly
/// with a hand-built `Vec<TelemetryEvent>` rather than spinning up a real
/// telemetry dir.
pub(crate) fn evaluate_window(events: &[TelemetryEvent]) -> Vec<TemplateMatch> {
    if events.is_empty() {
        return Vec::new();
    }

    // Per-keyword aggregate: count + most-recent atom path + most-recent ts.
    // We pick the most-recent atom path so the chip anchors near the
    // freshest evidence (richer affordance for "lock this as a project").
    struct Agg {
        count: u32,
        last_ts: DateTime<Utc>,
        last_atom: Option<String>,
    }
    let mut agg: HashMap<String, Agg> = HashMap::new();

    for ev in events {
        // Restrict to the three event classes the spec calls out.
        if !matches!(
            ev.event.as_str(),
            "search" | "open_atom" | "edit_atom"
        ) {
            continue;
        }
        let ts = match DateTime::parse_from_rfc3339(&ev.ts) {
            Ok(dt) => dt.with_timezone(&Utc),
            Err(_) => continue, // Skip malformed; never panic on telemetry.
        };

        // Pull the text candidate from the payload — we tokenise across
        // every string-valued field so a `search` event's `query` and an
        // `open_atom`'s `atom_path` both contribute.
        let mut texts: Vec<String> = Vec::new();
        let atom_path_for_anchor = extract_atom_path(&ev.payload);
        if let Some(obj) = ev.payload.as_object() {
            for (_k, v) in obj {
                if let Some(s) = v.as_str() {
                    texts.push(s.to_string());
                }
            }
        }

        for text in &texts {
            for token in tokenise(text) {
                let entry = agg.entry(token.clone()).or_insert(Agg {
                    count: 0,
                    last_ts: ts,
                    last_atom: atom_path_for_anchor.clone(),
                });
                entry.count = entry.count.saturating_add(1);
                if ts >= entry.last_ts {
                    entry.last_ts = ts;
                    if let Some(p) = atom_path_for_anchor.clone() {
                        entry.last_atom = Some(p);
                    }
                }
            }
        }
    }

    let mut out: Vec<TemplateMatch> = Vec::new();
    let mut keys: Vec<&String> = agg.keys().collect();
    keys.sort(); // Deterministic emit order.
    for k in keys {
        let a = &agg[k];
        if a.count < MIN_MENTIONS {
            continue;
        }
        let extra = a.count.saturating_sub(MIN_MENTIONS);
        let confidence = (BASE_CONFIDENCE + PER_EXTRA_CONFIDENCE * extra as f32).min(MAX_CONFIDENCE);

        let body = format!(
            "You mentioned \"{kw}\" {n} times this week. Lock as a project / decision?",
            kw = k,
            n = a.count,
        );

        let surface_id = a
            .last_atom
            .clone()
            .unwrap_or_else(|| format!("pattern:{}", k));

        let atom_refs = a.last_atom.clone().map(|p| vec![p]).unwrap_or_default();

        out.push(TemplateMatch {
            match_id: String::new(),
            template: "pattern_recurrence".into(),
            body,
            confidence,
            atom_refs,
            surface_id: Some(surface_id),
            priority: CHIP_PRIORITY,
            is_irreversible: false,
            is_completion_signal: false,
            is_cross_route: false,
        });
    }

    out
}

/// Pull `payload.atom_path` if present (open_atom + edit_atom both expose
/// it; search does not). Returns the string with forward-slash form.
fn extract_atom_path(payload: &serde_json::Value) -> Option<String> {
    payload
        .as_object()?
        .get("atom_path")
        .and_then(|v| v.as_str())
        .map(|s| s.replace('\\', "/"))
}

/// Tokenise via `split_whitespace`, then split each whitespace-token on
/// path separators (`/`, `\`) and dot-extension (`.`) so an atom path like
/// `decisions/pricing-lock.md` decomposes into `decisions`, `pricing-lock`,
/// `md`. Lowercase, strip remaining punctuation, drop stopwords + tokens
/// shorter than 3 chars + numeric-only tokens.
fn tokenise(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for ws_tok in s.split_whitespace() {
        // Split each whitespace-token on `/`, `\`, `.`, `,` so paths +
        // sentence punctuation each yield their inner words.
        for sub in ws_tok.split(|c: char| matches!(c, '/' | '\\' | '.' | ',' | ';' | ':' | '!' | '?')) {
            let clean: String = sub
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .collect::<String>()
                .to_lowercase();
            if clean.is_empty() {
                continue;
            }
            if clean.chars().count() < 3 {
                continue;
            }
            if STOPWORDS.contains(&clean.as_str()) {
                continue;
            }
            // Numeric-only tokens ("2026", "20") are noise — skip.
            if clean.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            out.push(clean);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(name: &str, payload: serde_json::Value, hours_ago: i64) -> TelemetryEvent {
        TelemetryEvent {
            event: name.to_string(),
            ts: (Utc::now() - chrono::Duration::hours(hours_ago)).to_rfc3339(),
            user: "daizhe".to_string(),
            payload,
        }
    }

    #[test]
    fn test_pattern_recurrence_counts_correctly() {
        // 6 search events all touching "pricing" → should fire with 6 mentions.
        let mut events = Vec::new();
        for i in 0..6 {
            events.push(ev(
                "search",
                serde_json::json!({ "query": "pricing question" }),
                i,
            ));
        }
        let matches = evaluate_window(&events);
        // "pricing" hits, "question" also hits 6× → both qualify.
        assert!(
            matches.iter().any(|m| m.body.contains("\"pricing\" 6 times")),
            "pricing must fire with count=6"
        );
        let pricing = matches
            .iter()
            .find(|m| m.body.contains("\"pricing\" 6"))
            .unwrap();
        assert_eq!(pricing.template, "pattern_recurrence");
        // confidence: 0.7 + 0.05 × (6−5) = 0.75
        assert!((pricing.confidence - 0.75).abs() < 1e-6, "got {}", pricing.confidence);
        assert!(pricing.surface_id.is_some(), "chip needs a surface anchor");
        assert_eq!(pricing.priority, CHIP_PRIORITY);
    }

    #[test]
    fn test_pattern_recurrence_skips_stopwords() {
        // 10 events all containing "the" — should NOT fire, "the" is a
        // stopword.
        let mut events = Vec::new();
        for i in 0..10 {
            events.push(ev(
                "search",
                serde_json::json!({ "query": "the" }),
                i,
            ));
        }
        let matches = evaluate_window(&events);
        assert!(
            matches.is_empty(),
            "stopwords must not produce matches — got {:?}",
            matches.iter().map(|m| &m.body).collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_pattern_recurrence_below_threshold_no_fire() {
        // 4 mentions of "pricing" — below MIN_MENTIONS=5 → silent.
        let events = vec![
            ev("search", serde_json::json!({ "query": "pricing chat" }), 0),
            ev("search", serde_json::json!({ "query": "pricing notes" }), 1),
            ev("search", serde_json::json!({ "query": "pricing draft" }), 2),
            ev("search", serde_json::json!({ "query": "pricing memo" }), 3),
        ];
        let matches = evaluate_window(&events);
        assert!(
            matches.iter().all(|m| !m.body.contains("\"pricing\"")),
            "4 mentions must not fire pricing"
        );
    }

    #[test]
    fn test_pattern_recurrence_uses_open_atom_path_as_anchor() {
        // 5 open_atom events on the same path; the surface_id should be the
        // atom path (so the chip anchors near it).
        let events: Vec<_> = (0..5)
            .map(|i| {
                ev(
                    "open_atom",
                    serde_json::json!({ "atom_path": "decisions/pricing-lock.md" }),
                    i,
                )
            })
            .collect();
        let matches = evaluate_window(&events);
        let pricing = matches
            .iter()
            .find(|m| m.body.contains("\"pricing-lock\""))
            .or_else(|| matches.iter().find(|m| m.body.contains("\"pricing\"")))
            .or_else(|| matches.iter().find(|m| m.body.contains("\"decisions\"")))
            .expect("at least one keyword from the path must fire");
        // The path must be in atom_refs, and surface_id must be set.
        assert_eq!(
            pricing.surface_id.as_deref(),
            Some("decisions/pricing-lock.md")
        );
        assert!(pricing
            .atom_refs
            .iter()
            .any(|p| p == "decisions/pricing-lock.md"));
    }

    #[test]
    fn test_pattern_recurrence_confidence_caps_at_max() {
        // 20 mentions → 0.7 + 0.05 × 15 = 1.45 → capped at 0.95.
        let events: Vec<_> = (0..20)
            .map(|i| {
                ev(
                    "search",
                    serde_json::json!({ "query": "pricing" }),
                    i % 24,
                )
            })
            .collect();
        let matches = evaluate_window(&events);
        let pricing = matches
            .iter()
            .find(|m| m.body.contains("\"pricing\""))
            .unwrap();
        assert!(
            (pricing.confidence - MAX_CONFIDENCE).abs() < 1e-6,
            "confidence must cap at {}, got {}",
            MAX_CONFIDENCE,
            pricing.confidence
        );
    }

    #[test]
    fn test_pattern_recurrence_ignores_non_relevant_events() {
        // navigate_route events are not in the relevant set — even with 10
        // hits they must not fire.
        let events: Vec<_> = (0..10)
            .map(|i| {
                ev(
                    "navigate_route",
                    serde_json::json!({ "from": "/today", "to": "/memory" }),
                    i,
                )
            })
            .collect();
        let matches = evaluate_window(&events);
        // "memory" / "today" appear in non-relevant events → must not count.
        assert!(
            matches.is_empty(),
            "navigate_route events must not contribute to recurrence"
        );
    }

    #[test]
    fn test_tokenise_drops_punctuation_and_short_tokens() {
        let toks = tokenise("Should we use Postgres? It's faster than MongoDB.");
        // "should", "we", "use", "it's", "than" → stopwords or short
        assert!(toks.contains(&"postgres".to_string()));
        assert!(toks.contains(&"mongodb".to_string()));
        assert!(toks.contains(&"faster".to_string()));
        assert!(!toks.iter().any(|t| t == "we" || t == "the" || t == "is"));
    }
}
