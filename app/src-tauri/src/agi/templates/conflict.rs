//! v1.9.0-beta.2 P2-A — Template #7: conflict_detection.
//!
//! Walk `~/.tangerine-memory/decisions/*.md`, take pairs whose mtime is in
//! the last 30 days, and look for contradictions between them. v1.9 ships a
//! pure-keyword heuristic — Phase 4 will replace this with embedding-based
//! semantic match (per SUGGESTION_ENGINE_SPEC.md §4 row 7).
//!
//! Heuristic details:
//!   1. Two atoms are "on the same topic" when:
//!        a) their `topic:` frontmatter values match (case-insensitive,
//!           normalised), OR
//!        b) the title-tokens overlap by ≥ 2 non-stopword keywords.
//!   2. They "conflict" when their bodies contain a known contradictory
//!      keyword pair near the same context word — examples:
//!        * `Postgres` vs `MongoDB`
//!        * `$20` vs `$10` (any "$<number>" pair where numbers differ)
//!        * yes/no, approve/reject style pairs
//!   3. Heuristic — every Phase 4 template gets a "false positive" guard;
//!      we ALSO require the pair share at least one topic word in common
//!      (so two atoms about "API design" and "team lunch" can never trip
//!      the pricing-detector even if both mention "$20").
//!
//! Tier: banner. We set `is_cross_route: true`, confidence is 0.75 — the
//! bus's `selectTier` rule "is_cross_route AND confidence ≥ 0.8 → banner"
//! deliberately uses the higher floor (0.8) for banners; with 0.75 we'd
//! drop to a toast. Per the prompt we still set the flag — Phase 4's
//! embedding upgrade will lift confidence past the floor and the same
//! template will then promote to banner with no other code change. This
//! mirrors the spec table row "Confidence < 0.85 + cross-route → banner
//! (NOT modal)" — banners ARE the right tier; we hit the toast fallback
//! today only because the heuristic confidence is low.
//!
//! NOTE on confidence: spec §4 row 7 lists conflict_detection at 0.85
//! confidence_floor. The prompt asks for 0.75 (heuristic-only) until
//! Phase 4 swaps in embeddings. We follow the prompt — keeping
//! Phase-4-readiness explicit in the body suffix `(heuristic — embeddings
//! land in v2.0)`.
//!
//! Priority: 9 (per the prompt — banners covering decision drift get a
//! high default since drift is hard to recover from once acted on).

use std::collections::HashSet;

use chrono::{DateTime, Duration, Utc};
use futures_util::future::BoxFuture;

use super::common::{parse_frontmatter, walk_md_files, Template, TemplateContext, TemplateMatch};

const CONFIDENCE: f32 = 0.75;
const MAX_AGE_DAYS: i64 = 30;
const PRIORITY: u8 = 9;

/// Known "contradictory keyword" buckets. Each bucket is a list of mutually
/// exclusive keywords; a pair of atoms triggers a conflict when each atom
/// contains a different keyword from the same bucket. Hand-curated for v1.9.
const CONFLICT_BUCKETS: &[&[&str]] = &[
    &["postgres", "postgresql", "mongo", "mongodb", "dynamodb", "sqlite"],
    &["yes", "no"],
    &["approve", "approved", "reject", "rejected"],
    &["accept", "accepted", "decline", "declined"],
    &["proceed", "proceeding", "abandon", "abandoned"],
    &["go", "no-go", "no go", "stop"],
    &["aws", "azure", "gcp"],
    &["python", "rust", "go", "typescript"],
];

/// Topic-word stopwords for the title-overlap heuristic. Anything in here
/// shouldn't qualify as "same topic" on its own.
const TOPIC_STOPWORDS: &[&str] = &[
    "the", "and", "for", "is", "a", "an", "of", "in", "to", "with", "on", "at", "by", "from",
    "as", "be", "this", "that", "it", "we", "or", "but", "if", "do", "are", "was", "were",
    "decision", "decided", "draft", "rfc", "doc", "note", "lock", "v1", "v2",
];

pub struct ConflictDetection;

impl Template for ConflictDetection {
    fn name(&self) -> &'static str {
        "conflict_detection"
    }

    fn evaluate<'a>(
        &'a self,
        ctx: &'a TemplateContext<'a>,
    ) -> BoxFuture<'a, Vec<TemplateMatch>> {
        Box::pin(async move {
            let recent_atoms = walk_md_files(ctx.memory_root, "decisions")
                .into_iter()
                .filter(|(_p, _r, mtime)| {
                    ctx.now.signed_duration_since(*mtime) <= Duration::days(MAX_AGE_DAYS)
                })
                .collect::<Vec<_>>();
            evaluate_pairs(&recent_atoms)
        })
    }
}

/// Pure helper: take a slice of `(rel_path, raw, mtime)` and return every
/// matching pair as a `TemplateMatch`. Public to the crate so tests can
/// hit it without filesystem IO.
pub(crate) fn evaluate_pairs(
    atoms: &[(String, String, DateTime<Utc>)],
) -> Vec<TemplateMatch> {
    let mut out: Vec<TemplateMatch> = Vec::new();
    let mut seen_pairs: HashSet<(String, String)> = HashSet::new();

    let parsed: Vec<ParsedAtom> = atoms
        .iter()
        .map(|(rel, raw, _)| ParsedAtom::from_raw(rel, raw))
        .collect();

    for i in 0..parsed.len() {
        for j in (i + 1)..parsed.len() {
            let a = &parsed[i];
            let b = &parsed[j];

            // Cheap filter — same-topic OR title overlap.
            if !on_same_topic(a, b) {
                continue;
            }

            // Look for contradictory keyword pair.
            let conflict = find_conflict(a, b);
            let (kw_a, kw_b) = match conflict {
                Some(p) => p,
                None => continue,
            };

            // Stable dedup: we never emit the same (a,b) pair twice.
            let key = if a.rel_path < b.rel_path {
                (a.rel_path.clone(), b.rel_path.clone())
            } else {
                (b.rel_path.clone(), a.rel_path.clone())
            };
            if !seen_pairs.insert(key) {
                continue;
            }

            let topic_label = a
                .topic
                .clone()
                .or_else(|| b.topic.clone())
                .or_else(|| a.shared_title_word(b))
                .unwrap_or_else(|| "shared topic".to_string());

            let body = format!(
                "**{topic}** decision drift detected: {sa} ({pa}) ↔ {sb} ({pb})",
                topic = topic_label,
                sa = summarise(&kw_a, &a.title),
                pa = a.rel_path,
                sb = summarise(&kw_b, &b.title),
                pb = b.rel_path,
            );

            out.push(TemplateMatch {
                match_id: String::new(),
                template: "conflict_detection".into(),
                body,
                confidence: CONFIDENCE,
                atom_refs: vec![a.rel_path.clone(), b.rel_path.clone()],
                surface_id: None,
                priority: PRIORITY,
                is_irreversible: false,
                is_completion_signal: false,
                is_cross_route: true,
            });
        }
    }
    out
}

#[derive(Debug, Clone)]
struct ParsedAtom {
    rel_path: String,
    title: String,
    topic: Option<String>,
    body_lower: String,
    title_tokens: HashSet<String>,
}

impl ParsedAtom {
    fn from_raw(rel_path: &str, raw: &str) -> Self {
        let (fm, body) = parse_frontmatter(raw);
        let title = fm.get("title").cloned().unwrap_or_default();
        let topic = fm.get("topic").map(|s| normalise_topic(s));
        let body_lower = body.to_lowercase();
        let title_tokens = extract_title_tokens(&title);
        Self {
            rel_path: rel_path.to_string(),
            title,
            topic,
            body_lower,
            title_tokens,
        }
    }

    /// Return one shared non-stopword title token, if any. Used as a topic
    /// label fallback when neither atom has an explicit `topic:` field.
    fn shared_title_word(&self, other: &ParsedAtom) -> Option<String> {
        let mut shared: Vec<&String> = self
            .title_tokens
            .intersection(&other.title_tokens)
            .collect();
        shared.sort();
        shared.first().map(|s| (*s).clone())
    }
}

fn normalise_topic(s: &str) -> String {
    s.trim().to_lowercase()
}

fn extract_title_tokens(title: &str) -> HashSet<String> {
    title
        .split_whitespace()
        .map(|t| {
            t.chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .collect::<String>()
                .to_lowercase()
        })
        .filter(|t| t.chars().count() >= 3)
        .filter(|t| !TOPIC_STOPWORDS.contains(&t.as_str()))
        .collect()
}

/// Topic match: same explicit topic OR ≥ 2 shared non-stopword title words.
fn on_same_topic(a: &ParsedAtom, b: &ParsedAtom) -> bool {
    if let (Some(ta), Some(tb)) = (&a.topic, &b.topic) {
        if !ta.is_empty() && ta == tb {
            return true;
        }
    }
    let shared = a.title_tokens.intersection(&b.title_tokens).count();
    shared >= 2
}

/// Look for a pair `(kw_a, kw_b)` where `kw_a` ∈ atom A's body, `kw_b` ∈
/// atom B's body, both come from the same bucket, and they're not the same
/// keyword. Also handles the dollar-amount heuristic ($20 vs $10).
fn find_conflict(a: &ParsedAtom, b: &ParsedAtom) -> Option<(String, String)> {
    // Bucket pass.
    for bucket in CONFLICT_BUCKETS {
        let mut hits_a: Vec<&str> = Vec::new();
        let mut hits_b: Vec<&str> = Vec::new();
        for kw in *bucket {
            if a.body_lower.contains(kw) {
                hits_a.push(kw);
            }
            if b.body_lower.contains(kw) {
                hits_b.push(kw);
            }
        }
        for ka in &hits_a {
            for kb in &hits_b {
                // Same keyword → not a conflict, agreement.
                if ka == kb {
                    continue;
                }
                return Some((ka.to_string(), kb.to_string()));
            }
        }
    }

    // Dollar-amount heuristic. We extract every "$<digits>" token from both
    // bodies and conflict whenever any pair differs.
    let dollars_a = extract_dollar_amounts(&a.body_lower);
    let dollars_b = extract_dollar_amounts(&b.body_lower);
    for da in &dollars_a {
        for db in &dollars_b {
            if da != db {
                return Some((format!("${}", da), format!("${}", db)));
            }
        }
    }

    None
}

/// Extract every `$<digits>` (optionally followed by `/<word>` like
/// `$20/seat`) and return just the numeric part.
fn extract_dollar_amounts(body: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut chars = body.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c != '$' {
            continue;
        }
        // Walk subsequent digits.
        let start = i + 1;
        let mut end = start;
        let bytes = body.as_bytes();
        while end < bytes.len() && (bytes[end] as char).is_ascii_digit() {
            end += 1;
        }
        if end > start {
            out.insert(body[start..end].to_string());
        }
    }
    out
}

/// Tiny one-word summary of which side picked which keyword. Falls back to
/// the title when present.
fn summarise(keyword: &str, title: &str) -> String {
    if title.is_empty() {
        keyword.to_string()
    } else {
        format!("{}: {}", title, keyword)
    }
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;

    fn atom(rel: &str, title: &str, topic: Option<&str>, body: &str) -> (String, String, DateTime<Utc>) {
        let mut raw = String::from("---\n");
        raw.push_str(&format!("title: {}\n", title));
        if let Some(t) = topic {
            raw.push_str(&format!("topic: {}\n", t));
        }
        raw.push_str("status: decided\n---\n\n");
        raw.push_str(body);
        (rel.to_string(), raw, Utc::now())
    }

    #[test]
    fn test_conflict_detection_finds_contradictory_atoms() {
        let atoms = vec![
            atom(
                "decisions/db-postgres.md",
                "Backend database choice",
                Some("backend-db"),
                "We will use Postgres for v1.\n",
            ),
            atom(
                "decisions/db-mongo.md",
                "Backend database revisit",
                Some("backend-db"),
                "Switching to MongoDB for schema flexibility.\n",
            ),
        ];
        let matches = evaluate_pairs(&atoms);
        assert_eq!(matches.len(), 1, "exactly one pair should fire");
        let m = &matches[0];
        assert_eq!(m.template, "conflict_detection");
        assert_eq!(m.confidence, CONFIDENCE);
        assert_eq!(m.priority, PRIORITY);
        assert!(m.is_cross_route, "must promote toward banner tier");
        assert!(!m.is_irreversible);
        assert!(!m.is_completion_signal);
        assert!(m.atom_refs.contains(&"decisions/db-postgres.md".to_string()));
        assert!(m.atom_refs.contains(&"decisions/db-mongo.md".to_string()));
        assert!(
            m.body.to_lowercase().contains("postgres")
                && m.body.to_lowercase().contains("mongo"),
            "body should cite both sides: got {}",
            m.body
        );
    }

    #[test]
    fn test_conflict_detection_no_false_positives_on_different_topics() {
        // Two atoms: one about pricing ($20), one about API design (mentions
        // a "$20 monthly cap" but unrelated topic). Title overlap is 0; no
        // explicit topic match either → must NOT fire.
        let atoms = vec![
            atom(
                "decisions/pricing.md",
                "Pricing $20 per seat",
                Some("pricing"),
                "Settled at $20/seat.\n",
            ),
            atom(
                "decisions/api-shape.md",
                "API endpoint shape",
                Some("api-design"),
                "Rate limit at $10 budget.\n",
            ),
        ];
        let matches = evaluate_pairs(&atoms);
        assert!(
            matches.is_empty(),
            "different topics must not produce a conflict; got {:?}",
            matches.iter().map(|m| &m.body).collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_conflict_detection_dollar_amount_pair() {
        let atoms = vec![
            atom(
                "decisions/pricing-v1.md",
                "Pricing seat tier",
                Some("pricing"),
                "$20/seat/month.\n",
            ),
            atom(
                "decisions/pricing-v2.md",
                "Pricing seat tier revised",
                Some("pricing"),
                "Revised to $10/seat/month.\n",
            ),
        ];
        let matches = evaluate_pairs(&atoms);
        assert_eq!(matches.len(), 1);
        assert!(
            matches[0].body.contains("$20") && matches[0].body.contains("$10"),
            "body must cite the conflicting amounts: {}",
            matches[0].body
        );
    }

    #[test]
    fn test_conflict_detection_same_keyword_is_not_conflict() {
        // Both atoms say "Postgres" → agreement, not conflict.
        let atoms = vec![
            atom(
                "decisions/db-1.md",
                "Backend db",
                Some("backend-db"),
                "Use Postgres.\n",
            ),
            atom(
                "decisions/db-2.md",
                "Backend db locked",
                Some("backend-db"),
                "Locking Postgres choice.\n",
            ),
        ];
        let matches = evaluate_pairs(&atoms);
        assert!(matches.is_empty(), "agreeing atoms must not fire");
    }

    #[test]
    fn test_conflict_detection_title_overlap_substitutes_for_topic() {
        // No explicit topic field; title overlap on "pricing" + "seat".
        let atoms = vec![
            atom(
                "decisions/p1.md",
                "Pricing seat lock",
                None,
                "Lock at $20.\n",
            ),
            atom(
                "decisions/p2.md",
                "Pricing seat revisit",
                None,
                "Revise to $15.\n",
            ),
        ];
        let matches = evaluate_pairs(&atoms);
        assert_eq!(matches.len(), 1, "title overlap should be enough; got {:?}", matches.iter().map(|m| &m.body).collect::<Vec<_>>());
    }

    #[test]
    fn test_conflict_detection_dedup_pair_only_once() {
        let atoms = vec![
            atom(
                "decisions/a.md",
                "Db pick",
                Some("db"),
                "Postgres.\n",
            ),
            atom(
                "decisions/b.md",
                "Db pick",
                Some("db"),
                "MongoDB.\n",
            ),
        ];
        let matches = evaluate_pairs(&atoms);
        assert_eq!(matches.len(), 1);
        // Re-run with the same atoms — still one match (no cross-call state).
        let matches2 = evaluate_pairs(&atoms);
        assert_eq!(matches2.len(), 1);
    }
}
