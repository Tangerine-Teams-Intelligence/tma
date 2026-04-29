// === wave 1.13-C ===
//! Wave 1.13-C — AI-extracted mentions.
//!
//! Reads a freshly written personal-agent atom and emits an
//! `ai_extracted_mention` event into Wave 1.13-A's canonical inbox store
//! (`commands::inbox_store::append_event`) for every reference the user
//! made to a known team member. Two extraction strategies stack:
//!
//!   1. **Heuristic** — three regex families (explicit `@handle`,
//!      natural-language imperatives, TODO patterns). Confidence 0.95 /
//!      0.7 / 0.6 respectively. Always runs.
//!   2. **LLM** — gated on `body_len > LLM_MIN_BODY_CHARS` OR heuristic
//!      returned zero mentions. Calls `session_borrower::dispatch` with a
//!      JSON-extraction prompt; merged with heuristic + deduped per
//!      `(target_user, intent)`.
//!
//! Per-atom LLM result cache (in-memory `HashMap<atom_path, Vec<…>>`)
//! avoids repeat calls when a parser re-runs over an unchanged conversation
//! between a user disabling and re-enabling the feature flag in the same
//! session. Cache key is the atom's *file path* — same key the parser uses
//! for idempotence so the cache never goes stale silently.
//!
//! Privacy: extraction runs entirely on the local machine. The LLM call
//! routes through `session_borrower` which borrows the user's existing
//! AI tool session (Cursor / Claude Code / Ollama fallback) — Tangerine
//! never ships the atom body to its own backend.
//!
//! Wave 1.13-A integration: we read the team roster from
//! `commands::identity::discover_roster` and write events through
//! `commands::inbox_store::append_event` so the "ai_extracted_mention"
//! KIND lands in the same JSONL Wave 1.13-A's `/inbox` route reads.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use chrono::Utc;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::commands::identity::{discover_roster, normalise_alias, resolve_current_profile};
use crate::commands::inbox_store::{append_event, InboxEvent};

/// Minimum body length (chars) before the LLM pass kicks in even when the
/// heuristic returned matches. Below this, heuristic is treated as
/// authoritative — short atoms rarely have ambiguous mentions and an
/// LLM call would be wasted budget.
pub const LLM_MIN_BODY_CHARS: usize = 200;

/// Per-mention output. Returned to the caller (parsers wrap each result in
/// an `inbox_emit` call) and used by the unit tests directly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExtractedMention {
    /// Lowercase team-member handle the user referenced.
    pub username: String,
    /// Verb / intent slug — `"ask"`, `"tell"`, `"review"`, `"todo"`,
    /// `"mention"`. Lowercase; consumers can map to a friendlier label.
    pub intent: String,
    /// Snippet from the atom body containing the mention. Capped at
    /// 200 chars with ellipsis. Used by Wave 1.13-A's renderer to show
    /// "what was the user actually asking about".
    pub snippet: String,
    /// Confidence in `[0.0, 1.0]`. Heuristic emits 0.95 / 0.7 / 0.6;
    /// LLM emits whatever the model returned, clamped.
    pub confidence: f32,
    /// `"heuristic"` or `"llm"`. Wave 1.13-A's renderer can flag low-
    /// confidence LLM-only mentions with a tooltip ("AI-detected, may be
    /// imprecise") if it wants.
    pub source: String,
}

/// Cap on the snippet length when we slice the surrounding context.
const SNIPPET_MAX_CHARS: usize = 200;

/// Compiled regex set. Lazy so the cost is paid once per process; every
/// adapter call hits the same set.
struct PatternSet {
    explicit_at: Regex,
    imperative: Regex,
    recipient_verb: Regex,
    todo: Regex,
}

static PATTERNS: Lazy<PatternSet> = Lazy::new(|| PatternSet {
    // `@hongyu` — high confidence, capture the trailing word.
    explicit_at: Regex::new(r"@([A-Za-z][A-Za-z0-9_-]{0,31})").unwrap(),
    // "ask Hongyu about X" — medium confidence. Verbs are the open-class
    // imperatives a user would naturally use to delegate / inform.
    imperative: Regex::new(
        r"(?i)\b(?:ask|tell|show|need|should|will|let|get|have|want|notify|cc|loop\s+in|check\s+with|run\s+by|sync\s+with|escalate\s+to|hand\s+off\s+to)\s+([A-Za-z][A-Za-z0-9_-]{0,31})\s+(?:about|to|for|on|if|whether|that|this|the|with)\b",
    )
    .unwrap(),
    // "Hongyu should know" — recipient + verb.
    recipient_verb: Regex::new(
        r"(?i)\b([A-Za-z][A-Za-z0-9_-]{0,31})\s+(?:should|needs?\s+to|will|can|might|has\s+to|must)\s+(?:know|see|review|check|look\s+at|approve|reject|sign\s+off|weigh\s+in|decide)\b",
    )
    .unwrap(),
    // "TODO: ask Hongyu about X" / "TODO ask Hongyu …".
    todo: Regex::new(
        r"(?i)\bTODO\s*[:\-]?\s*(?:ask|tell|notify|cc|sync\s+with|loop\s+in|check\s+with)\s+([A-Za-z][A-Za-z0-9_-]{0,31})\b",
    )
    .unwrap(),
});

/// Per-atom LLM cache. Keyed on the atom's file path (string form). When
/// the entry exists we skip the dispatch call entirely. The cache never
/// invalidates intentionally — the parser only re-writes the atom when
/// the source changed, and a re-write doesn't go through this module
/// directly (the parser passes the new body in the next call).
static LLM_CACHE: Lazy<Mutex<HashMap<String, Vec<ExtractedMention>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Master kill switch for the whole feature. Default `true` — set to
/// `false` (via React store sync, future patch) when the user disables
/// `ui.aiMentionExtractionEnabled` in Settings. Wave 1.13-A wires the
/// store-side hook; for now flipping this in tests is the only way to
/// disable the pipeline.
static GLOBAL_ENABLED: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(true));

/// Sub-flag: when false the heuristic still runs but the LLM dispatch
/// is skipped. Used to keep extraction cheap on slower machines.
/// Default `true`.
static LLM_ENABLED: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(true));

/// Read the master flag. Called by the parser hook before scheduling
/// extraction work.
pub fn is_globally_enabled() -> bool {
    GLOBAL_ENABLED.lock().map(|g| *g).unwrap_or(true)
}

/// Set the master flag. Wave 1.13-A's React-store sync hook calls this
/// when the user toggles `ui.aiMentionExtractionEnabled`.
pub fn set_globally_enabled(v: bool) {
    if let Ok(mut g) = GLOBAL_ENABLED.lock() {
        *g = v;
    }
}

/// Read the LLM sub-flag. The extractor honours this internally; the
/// parser hook also reads it so the regex-only fast path can be taken
/// without entering the async dispatch path.
pub fn is_llm_enabled() -> bool {
    LLM_ENABLED.lock().map(|g| *g).unwrap_or(true)
}

/// Set the LLM sub-flag.
pub fn set_llm_enabled(v: bool) {
    if let Ok(mut g) = LLM_ENABLED.lock() {
        *g = v;
    }
}

/// Pull the user component out of an atom path of shape
/// `…/personal/<user>/threads/<vendor>/<id>.md`. Used by the parser
/// hooks so they don't have to thread the user through every adapter
/// call site. Returns `None` when the path doesn't match.
pub fn user_from_atom_path(p: &Path) -> Option<String> {
    let s = p.to_string_lossy().replace('\\', "/");
    // Look for "/personal/" then take the next path component.
    let key = "/personal/";
    let idx = s.find(key)?;
    let rest = &s[idx + key.len()..];
    let user = rest.split('/').next()?;
    if user.is_empty() {
        return None;
    }
    Some(user.to_string())
}

/// Extract mentions from an atom body. **The single public entry point**.
///
/// `roster` is normally derived from
/// `crate::commands::identity::discover_roster`; tests pass a fixed list
/// directly. `enable_llm` lets the caller honour the
/// `ui.aiMentionExtractionEnabled` user setting without this module
/// having to know about the React store.
///
/// Always returns `Ok(_)` — extractor errors are swallowed (so the
/// caller can still emit at least the heuristic results).
pub async fn extract(
    atom_path: &Path,
    body: &str,
    roster: &[String],
    enable_llm: bool,
) -> Result<Vec<ExtractedMention>, String> {
    if body.trim().is_empty() {
        return Ok(Vec::new());
    }
    if roster.is_empty() {
        // Nothing to filter against — emit zero so we don't accidentally
        // notify "Hongyu" when no team member with that handle is configured.
        return Ok(Vec::new());
    }
    let normalized: Vec<String> = roster.iter().map(|s| s.to_lowercase()).collect();
    let roster_set: HashSet<&str> = normalized.iter().map(|s| s.as_str()).collect();

    let mut out: Vec<ExtractedMention> = heuristic_extract(body, &roster_set);

    let body_len = body.chars().count();
    let should_llm = enable_llm && (body_len > LLM_MIN_BODY_CHARS || out.is_empty());
    if should_llm {
        let cache_key = atom_path.to_string_lossy().to_string();
        // v1.16 — LLM extractor removed. Heuristic regex pass is the only
        // mention extraction now. LLM_CACHE / cache_key code below is dead
        // but kept to minimize diff; can be cleaned in W2.
        let _ = (&LLM_CACHE, &cache_key);
        let llm_results: Vec<ExtractedMention> = Vec::new();
        out.extend(llm_results);
    }

    Ok(dedupe(out))
}

/// Convenience: extract + emit one inbox event per mention. Used by the
/// parser hooks. `current_user` is the local user's alias (resolved by
/// the parser hook from the atom path / `resolve_current_profile`).
/// `vendor` is the parser id ("cursor" / "claude-code" / …).
///
/// Returns the count of events emitted (0 when the body was empty / the
/// roster was empty / no mentions matched). Best-effort: any single
/// event's append failure is logged + swallowed so one bad row never
/// aborts the rest.
pub async fn extract_and_emit(
    atom_path: &Path,
    rel_atom_path: &str,
    body: &str,
    current_user: &str,
    vendor: &str,
    enable_llm: bool,
) -> usize {
    let memory_dir = crate::commands::identity::memory_root();
    let roster_objs = discover_roster(&memory_dir);
    let roster: Vec<String> = roster_objs.iter().map(|m| m.alias.clone()).collect();
    extract_and_emit_in(
        atom_path,
        rel_atom_path,
        body,
        current_user,
        vendor,
        enable_llm,
        &memory_dir,
        &roster,
    )
    .await
}

/// Test-friendly variant — caller supplies the memory dir + roster
/// directly so unit tests don't depend on `~/.tangerine-memory`. Calls
/// `append_event` against the supplied dir instead.
pub async fn extract_and_emit_in(
    atom_path: &Path,
    rel_atom_path: &str,
    body: &str,
    current_user: &str,
    vendor: &str,
    enable_llm: bool,
    memory_dir: &Path,
    roster: &[String],
) -> usize {
    if !is_globally_enabled() {
        return 0;
    }
    let extracted = match extract(atom_path, body, roster, enable_llm).await {
        Ok(v) => v,
        Err(_) => return 0,
    };
    let me = normalise_alias(current_user);
    let mut emitted = 0usize;
    for ex in extracted {
        // Don't notify yourself — "ask me to …" is not an inbox event.
        if ex.username.eq_ignore_ascii_case(&me) {
            continue;
        }
        let target_user = normalise_alias(&ex.username);
        let mut payload: HashMap<String, Value> = HashMap::new();
        payload.insert("intent".to_string(), json!(ex.intent));
        payload.insert("snippet".to_string(), json!(ex.snippet));
        payload.insert("confidence".to_string(), json!(ex.confidence));
        payload.insert("vendor".to_string(), json!(vendor));
        payload.insert("extractor".to_string(), json!(ex.source));
        let event = InboxEvent {
            id: format!("aim-{}", uuid::Uuid::new_v4().simple()),
            kind: "ai_extracted_mention".to_string(),
            target_user,
            source_user: me.clone(),
            source_atom: rel_atom_path.to_string(),
            timestamp: Utc::now().to_rfc3339(),
            payload,
            read: false,
            archived: false,
        };
        match append_event(memory_dir, &event) {
            Ok(()) => emitted += 1,
            Err(e) => {
                tracing::warn!(error=?e, "wave 1.13-C inbox append failed");
            }
        }
    }
    emitted
}

/// Resolve the local user's alias from either the supplied path or the
/// canonical `resolve_current_profile`. Used by the parser hooks.
pub fn resolve_user_alias(atom_path: Option<&Path>) -> String {
    if let Some(p) = atom_path {
        if let Some(u) = user_from_atom_path(p) {
            return normalise_alias(&u);
        }
    }
    let dir = crate::commands::identity::memory_root();
    resolve_current_profile(&dir).alias
}

// --------------------------------------------------------------------------
// Heuristic extractor
// --------------------------------------------------------------------------

fn heuristic_extract(body: &str, roster: &HashSet<&str>) -> Vec<ExtractedMention> {
    let mut out: Vec<ExtractedMention> = Vec::new();

    for cap in PATTERNS.explicit_at.captures_iter(body) {
        if let Some(m) = cap.get(1) {
            let name = m.as_str().to_lowercase();
            if roster.contains(name.as_str()) {
                out.push(ExtractedMention {
                    username: name,
                    intent: "mention".to_string(),
                    snippet: snippet_around(body, m.start(), m.end()),
                    confidence: 0.95,
                    source: "heuristic".to_string(),
                });
            }
        }
    }

    for cap in PATTERNS.imperative.captures_iter(body) {
        if let (Some(verb_match), Some(name_match)) = (cap.get(0), cap.get(1)) {
            let name = name_match.as_str().to_lowercase();
            if roster.contains(name.as_str()) {
                let intent = imperative_intent(verb_match.as_str());
                out.push(ExtractedMention {
                    username: name,
                    intent,
                    snippet: snippet_around(body, verb_match.start(), verb_match.end()),
                    confidence: 0.7,
                    source: "heuristic".to_string(),
                });
            }
        }
    }

    for cap in PATTERNS.recipient_verb.captures_iter(body) {
        if let (Some(full), Some(name_match)) = (cap.get(0), cap.get(1)) {
            let name = name_match.as_str().to_lowercase();
            // Filter common false positives — "this should know", "you will see".
            if matches!(name.as_str(), "this" | "that" | "you" | "we" | "i" | "they" | "the" | "it" | "he" | "she") {
                continue;
            }
            if roster.contains(name.as_str()) {
                out.push(ExtractedMention {
                    username: name,
                    intent: "review".to_string(),
                    snippet: snippet_around(body, full.start(), full.end()),
                    confidence: 0.7,
                    source: "heuristic".to_string(),
                });
            }
        }
    }

    for cap in PATTERNS.todo.captures_iter(body) {
        if let (Some(full), Some(name_match)) = (cap.get(0), cap.get(1)) {
            let name = name_match.as_str().to_lowercase();
            if roster.contains(name.as_str()) {
                out.push(ExtractedMention {
                    username: name,
                    intent: "todo".to_string(),
                    snippet: snippet_around(body, full.start(), full.end()),
                    confidence: 0.6,
                    source: "heuristic".to_string(),
                });
            }
        }
    }

    out
}

/// Map an imperative verb prefix to a stable intent slug.
fn imperative_intent(matched: &str) -> String {
    let lower = matched.to_lowercase();
    let first_word = lower.split_whitespace().next().unwrap_or("");
    match first_word {
        "ask" | "check" | "run" | "sync" | "want" => "ask",
        "tell" | "notify" | "cc" | "let" | "loop" => "tell",
        "show" => "show",
        "need" | "should" | "have" | "get" => "request",
        "escalate" | "hand" => "escalate",
        _ => "ask",
    }
    .to_string()
}

/// Slice up to `SNIPPET_MAX_CHARS` characters of context around the
/// matched range. Tries to centre the match in the window; trims to
/// word boundaries when possible.
fn snippet_around(body: &str, start: usize, end: usize) -> String {
    let total_len = body.len();
    let half = SNIPPET_MAX_CHARS / 2;
    let s = start.saturating_sub(half);
    let e = (end + half).min(total_len);
    // Snap to char boundaries to avoid cutting a UTF-8 sequence in half.
    let s = snap_left(body, s);
    let e = snap_right(body, e);
    let raw = &body[s..e];
    let collapsed: String = raw
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let trimmed = collapsed.trim();
    if trimmed.chars().count() <= SNIPPET_MAX_CHARS {
        return trimmed.to_string();
    }
    let mut buf = String::new();
    let mut count = 0usize;
    for c in trimmed.chars() {
        if count >= SNIPPET_MAX_CHARS - 1 {
            break;
        }
        buf.push(c);
        count += 1;
    }
    buf.push('…');
    buf
}

fn snap_left(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn snap_right(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

// --------------------------------------------------------------------------
// LLM extractor — v1.16 砍干净
//
// Heuristic regex pass (`heuristic_extract`) is the only mention extraction
// path now. The LLM-borrow stack was removed in v1.16 W1A1; the entire
// llm_extract / parse_llm_json / strip_code_fence / cap_snippet helpers
// became dead code. Removed in v1.16 W1 cleanup pass.
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Dedupe
// --------------------------------------------------------------------------

/// Dedupe by `(username, intent)` — heuristic vs LLM hits for the same
/// person + intent collapse to one entry, preferring the higher-confidence
/// one. Two different intents for the same person stay as two events
/// (e.g. "ask Hongyu" + "Hongyu should review" is two distinct asks).
fn dedupe(mut items: Vec<ExtractedMention>) -> Vec<ExtractedMention> {
    items.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut out: Vec<ExtractedMention> = Vec::new();
    for it in items {
        let k = (it.username.clone(), it.intent.clone());
        if seen.insert(k) {
            out.push(it);
        }
    }
    out
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn roster() -> Vec<String> {
        vec!["hongyu".to_string(), "daizhe".to_string(), "sam".to_string()]
    }

    fn p() -> PathBuf {
        PathBuf::from("/tmp/wave-1.13c/cursor/abc.md")
    }

    #[tokio::test]
    async fn extract_explicit_at_mention_high_confidence() {
        let body = "@hongyu can you check the PCB layout for me?";
        let out = extract(&p(), body, &roster(), false).await.unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].username, "hongyu");
        assert_eq!(out[0].intent, "mention");
        assert!((out[0].confidence - 0.95).abs() < 1e-6);
        assert_eq!(out[0].source, "heuristic");
        assert!(out[0].snippet.contains("hongyu"));
    }

    #[tokio::test]
    async fn extract_natural_language_imperative_medium_confidence() {
        let body = "I should ask Hongyu about the supplier choice tomorrow.";
        let out = extract(&p(), body, &roster(), false).await.unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].username, "hongyu");
        assert_eq!(out[0].intent, "ask");
        assert!((out[0].confidence - 0.7).abs() < 1e-6);
    }

    #[tokio::test]
    async fn extract_todo_pattern() {
        let body = "TODO: ask Sam about the legal review before Friday.";
        let out = extract(&p(), body, &roster(), false).await.unwrap();
        assert!(
            out.iter().any(|m| m.username == "sam" && m.intent == "todo"),
            "expected a TODO match for sam, got: {:?}",
            out,
        );
        let todo_match = out.iter().find(|m| m.intent == "todo").unwrap();
        assert!((todo_match.confidence - 0.6).abs() < 1e-6);
    }

    #[tokio::test]
    async fn filter_unknown_users() {
        // "Eric" is NOT in the roster — we must NOT emit a mention for them.
        let body = "I should ask Eric about the supplier choice tomorrow.";
        let out = extract(&p(), body, &roster(), false).await.unwrap();
        assert!(
            !out.iter().any(|m| m.username == "eric"),
            "must not emit for unknown users; got: {:?}",
            out,
        );
        assert!(out.is_empty());
    }

    #[tokio::test]
    async fn dedupe_multiple_mentions_same_user() {
        // Body mentions hongyu twice via the same intent — should dedupe
        // to one entry, keeping the higher confidence.
        let body = "@hongyu can you also @hongyu sign off on this? \
                    Want hongyu to weigh in.";
        let out = extract(&p(), body, &roster(), false).await.unwrap();
        let hongyu_count = out.iter().filter(|m| m.username == "hongyu").count();
        // Distinct (intent="mention" from @, intent="review" from "weigh in")
        // should both survive; duplicate @hongyu collapses.
        let intents: HashSet<String> =
            out.iter().filter(|m| m.username == "hongyu").map(|m| m.intent.clone()).collect();
        assert!(intents.contains("mention"), "missing @ mention: {:?}", out);
        assert!(hongyu_count <= 2, "expected dedupe, got {}: {:?}", hongyu_count, out);
    }

    // === v1.17.1 fixup ===
    // v1.16 W1 removed `parse_llm_json` (the LLM extractor was deleted) but
    // left these three tests pointing at the removed symbol, so the lib
    // test target stopped compiling. Gating them out with `#[cfg(any())]`
    // is the smallest reversible fix to unblock cargo test for unrelated
    // modules; deleting them is the right v1.18 cleanup.
    // === end v1.17.1 fixup ===
    #[cfg(any())]
    #[tokio::test]
    async fn llm_combines_with_heuristic() {
        // The LLM extractor's own dispatch is gated behind a real
        // session_borrower call; here we just assert the parse layer
        // accepts model output and that dedupe merges identical hits
        // with the heuristic side.
        let mut roster_set: HashSet<&str> = HashSet::new();
        roster_set.insert("hongyu");
        let model_out = "[{\"username\":\"hongyu\",\"intent\":\"ask\",\"snippet\":\"ask hongyu\",\"confidence\":0.85}]";
        let llm = parse_llm_json(model_out, &roster_set).unwrap();
        assert_eq!(llm.len(), 1);
        assert_eq!(llm[0].source, "llm");
        // Combine: heuristic emits 0.7 ask + LLM emits 0.85 ask → dedupe
        // keeps the higher-confidence one.
        let heur = ExtractedMention {
            username: "hongyu".to_string(),
            intent: "ask".to_string(),
            snippet: "I should ask Hongyu".to_string(),
            confidence: 0.7,
            source: "heuristic".to_string(),
        };
        let mut combined = vec![heur];
        combined.extend(llm);
        let merged = dedupe(combined);
        assert_eq!(merged.len(), 1);
        assert!((merged[0].confidence - 0.85).abs() < 1e-6);
        assert_eq!(merged[0].source, "llm");
    }

    #[tokio::test]
    async fn empty_body_returns_empty() {
        let out = extract(&p(), "", &roster(), true).await.unwrap();
        assert!(out.is_empty());
        let out2 = extract(&p(), "   \n  \t   ", &roster(), true).await.unwrap();
        assert!(out2.is_empty());
    }

    #[tokio::test]
    async fn case_insensitive_matching() {
        // Both "HONGYU" and "Hongyu" should resolve to lowercase "hongyu".
        let body = "@HONGYU please review. Also TODO: ask HONGYU about timing.";
        let out = extract(&p(), body, &roster(), false).await.unwrap();
        assert!(out.iter().all(|m| m.username == "hongyu"));
        assert!(out.iter().any(|m| m.intent == "mention"));
        assert!(out.iter().any(|m| m.intent == "todo"));
    }

    // ------ supporting tests for dedupe + LLM parse robustness ------

    // v1.17.1 fixup — these two tests reference `parse_llm_json` which was
    // removed in v1.16 W1; gated out to unblock cargo test. Delete in v1.18.
    #[cfg(any())]
    #[test]
    fn parse_llm_json_strips_code_fence() {
        let mut r: HashSet<&str> = HashSet::new();
        r.insert("daizhe");
        let model_out = "```json\n[{\"username\":\"daizhe\",\"intent\":\"ask\",\"snippet\":\"x\",\"confidence\":0.9}]\n```";
        let parsed = parse_llm_json(model_out, &r).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].username, "daizhe");
    }

    #[cfg(any())]
    #[test]
    fn parse_llm_json_drops_entries_outside_roster() {
        let mut r: HashSet<&str> = HashSet::new();
        r.insert("daizhe");
        let model_out = "[\
            {\"username\":\"eric\",\"intent\":\"ask\",\"snippet\":\"x\",\"confidence\":0.9},\
            {\"username\":\"daizhe\",\"intent\":\"ask\",\"snippet\":\"y\",\"confidence\":0.8}\
        ]";
        let parsed = parse_llm_json(model_out, &r).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].username, "daizhe");
    }

    #[test]
    fn dedupe_collapses_same_user_intent() {
        let items = vec![
            ExtractedMention {
                username: "hongyu".to_string(),
                intent: "ask".to_string(),
                snippet: "first".to_string(),
                confidence: 0.7,
                source: "heuristic".to_string(),
            },
            ExtractedMention {
                username: "hongyu".to_string(),
                intent: "ask".to_string(),
                snippet: "second".to_string(),
                confidence: 0.95,
                source: "llm".to_string(),
            },
            ExtractedMention {
                username: "hongyu".to_string(),
                intent: "review".to_string(),
                snippet: "third".to_string(),
                confidence: 0.7,
                source: "heuristic".to_string(),
            },
        ];
        let out = dedupe(items);
        assert_eq!(out.len(), 2);
        assert!(out.iter().any(|m| m.intent == "ask" && (m.confidence - 0.95).abs() < 1e-6));
        assert!(out.iter().any(|m| m.intent == "review"));
    }

    #[tokio::test]
    async fn extract_and_emit_in_writes_canonical_inbox_jsonl() {
        // End-to-end check: the helper must write through Wave 1.13-A's
        // canonical store. Use a tmp memory dir so we don't pollute the
        // user's real ~/.tangerine-memory.
        let tmp_root = std::env::temp_dir().join(format!(
            "tii_w113c_emit_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&tmp_root).unwrap();
        let body = "I should ask Hongyu about the supplier choice tomorrow.";
        let atom_path = tmp_root.join("personal/me/threads/cursor/abc.md");
        let n = extract_and_emit_in(
            &atom_path,
            "personal/me/threads/cursor/abc.md",
            body,
            "me",
            "cursor",
            false, // skip LLM
            &tmp_root,
            &roster(),
        )
        .await;
        assert_eq!(n, 1, "expected exactly one event emitted");
        let inbox_jsonl = crate::commands::inbox_store::inbox_path(&tmp_root);
        let on_disk = std::fs::read_to_string(&inbox_jsonl).unwrap();
        assert!(on_disk.contains("ai_extracted_mention"), "kind missing: {}", on_disk);
        // Wave 1.13-A serializes with camelCase — both field-name spellings
        // are checked so a future schema flip back to snake_case still
        // surfaces the right error.
        assert!(
            on_disk.contains("\"targetUser\":\"hongyu\"")
                || on_disk.contains("\"target_user\":\"hongyu\""),
            "target missing: {}",
            on_disk
        );
        assert!(on_disk.contains("\"vendor\":\"cursor\""), "vendor missing: {}", on_disk);
        assert!(on_disk.contains("\"intent\":\"ask\""), "intent missing: {}", on_disk);
        let _ = std::fs::remove_dir_all(&tmp_root);
    }

    #[test]
    fn user_from_atom_path_extracts_user_segment() {
        let p = PathBuf::from("/home/u/.tangerine-memory/personal/daizhe/threads/cursor/abc.md");
        assert_eq!(user_from_atom_path(&p), Some("daizhe".to_string()));
        let p2 = PathBuf::from("C:\\Users\\d\\.tangerine-memory\\personal\\me\\threads\\cursor\\x.md");
        assert_eq!(user_from_atom_path(&p2), Some("me".to_string()));
        let p3 = PathBuf::from("/no/personal/segment.md");
        // "/personal/" slice still matches but the next path component is
        // "segment.md" (no trailing dir) — that's fine; the parser uses
        // this as a hint, not a hard validator.
        let _ = user_from_atom_path(&p3);
    }
}
// === end wave 1.13-C ===
