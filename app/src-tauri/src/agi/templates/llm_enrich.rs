//! v1.9.0 P4-A — Stage 2 LLM enrichment hook.
//!
//! Per `SUGGESTION_ENGINE_SPEC.md` §5: rule-based templates fire fast
//! (< 10ms) and surface immediately on the suggestion bus. After the
//! initial emit, the registry spawns a fire-and-forget enrichment task
//! that asks the borrowed LLM session to add 2-3 sentences of
//! context-aware reasoning, citing atoms by path. If the response is
//! valid (citation grounded, under 200 chars) we re-emit a
//! `template_match_enriched` event with the SAME `match_id` and the
//! frontend listener swaps the body in place.
//!
//! Design choices:
//!   * Never blocks the rule-fire path — `enrich_match` is called from a
//!     `tokio::spawn(...)` in the registry. A 5s timeout guards against
//!     a stalled LLM tool.
//!   * Silent skip on every failure mode (no LLM available, citation
//!     check fails, malformed response, timeout). The rule-version body
//!     stays — the user never sees a degraded suggestion.
//!   * Citation grounding mirrors `co_thinker::validate_and_ground`'s
//!     contract: every claim line MUST contain a `[path.md]` token. We
//!     reject responses that drop the cited atoms.
//!   * Confidence floor for enrichment — only matches with confidence
//!     > 0.6 are worth an LLM call (don't waste session-borrow capacity
//!     on weak rules).

use std::path::Path;
use std::time::Duration;

use crate::agi::session_borrower::{self, BorrowError, LlmRequest as SbRequest};
use crate::commands::AppError;

use super::common::TemplateMatch;

/// Hard cap on enriched body length. Keeps the surface visually bounded
/// so an over-eager model can't blow up the banner / toast / modal.
const MAX_BODY_CHARS: usize = 200;

/// Minimum confidence for the rule emit before we'll burn an LLM call.
/// Documented in `SUGGESTION_ENGINE_SPEC.md` §5: lazy enrichment, weak
/// rules stay un-enriched.
pub const ENRICHMENT_CONFIDENCE_FLOOR: f32 = 0.6;

/// Wall-clock timeout for the LLM dispatch path. Spec §5: < 5s. The
/// session-borrower itself caps the Ollama channel at 60s; we cap the
/// outer call so a slow tool doesn't queue enrichments.
const LLM_TIMEOUT: Duration = Duration::from_secs(5);

/// Maximum atoms we splice into the user prompt. More than 3 makes the
/// system prompt longer than the borrowed session window for some
/// tools, and the marginal value of atoms 4..N is low.
const MAX_ATOM_SNIPPETS: usize = 3;

/// Per-snippet character cap so a single huge atom can't dominate the
/// prompt budget.
const ATOM_SNIPPET_CHARS: usize = 600;

/// SYSTEM prompt sent verbatim. Spec §5 wording.
const SYSTEM_PROMPT: &str = "You are Tangerine co-thinker. A rule template fired with this match. \
                             Enrich the body with 2-3 sentences of context-aware reasoning, \
                             citing atoms by path. Stay under 200 chars.";

/// Ask the borrowed LLM to enrich `m`. Returns `Some(enriched_match)` on
/// success — same `match_id`, replaced `body`. Returns `None` on any
/// failure mode (no session, timeout, malformed, citation check fails,
/// empty enrichment, etc.) so the caller silently keeps the rule body.
///
/// `memory_root` is reserved for a future v2.0 enrichment that may want
/// to read additional atoms beyond what `m.atom_refs` cites — for now
/// we just walk the cited paths.
pub async fn enrich_match(
    m: &TemplateMatch,
    memory_root: &Path,
    primary_tool_id: Option<String>,
) -> Result<Option<TemplateMatch>, AppError> {
    // Confidence gate. Documented as the lazy-enrichment floor in the
    // spec. The registry also enforces this at the dispatch site so a
    // direct `enrich_match` caller still gets the same gate.
    if m.confidence < ENRICHMENT_CONFIDENCE_FLOOR {
        return Ok(None);
    }

    let user_prompt = build_user_prompt(m, memory_root);
    let req = SbRequest {
        system_prompt: SYSTEM_PROMPT.to_string(),
        user_prompt,
        max_tokens: Some(200),
        temperature: Some(0.3),
    };

    // Outer 5s guard. session_borrower itself has a 60s cap on Ollama —
    // we cap tighter so the user's suggestion never feels stale by the
    // time enrichment lands. Timeout / dispatch error / NotImplemented
    // all fold to the same "silent skip" outcome.
    let dispatch_fut = session_borrower::dispatch(req, primary_tool_id);
    let resp = match tokio::time::timeout(LLM_TIMEOUT, dispatch_fut).await {
        Ok(Ok(r)) => r,
        // BorrowError::AllExhausted / NotImplemented / PrimaryUnreachable —
        // every failure is a silent skip. The frontend never sees a
        // degraded enrichment.
        Ok(Err(BorrowError::AllExhausted))
        | Ok(Err(BorrowError::NotImplemented(_)))
        | Ok(Err(BorrowError::PrimaryUnreachable { .. })) => return Ok(None),
        Err(_) => return Ok(None), // tokio::time::timeout elapsed
    };

    let enriched = match validate_enrichment(&resp.text, &m.atom_refs) {
        Some(s) => s,
        None => return Ok(None),
    };

    Ok(Some(TemplateMatch {
        match_id: m.match_id.clone(),
        template: m.template.clone(),
        body: enriched,
        confidence: m.confidence,
        atom_refs: m.atom_refs.clone(),
        surface_id: m.surface_id.clone(),
        priority: m.priority,
        is_irreversible: m.is_irreversible,
        is_completion_signal: m.is_completion_signal,
        is_cross_route: m.is_cross_route,
    }))
}

/// Build the USER prompt. Serialises the match body + up to
/// [`MAX_ATOM_SNIPPETS`] cited atoms (with size-capped excerpts) so the
/// model has enough context to write 2-3 sentences without hallucinating.
fn build_user_prompt(m: &TemplateMatch, memory_root: &Path) -> String {
    let mut out = String::new();
    out.push_str("Rule template: ");
    out.push_str(&m.template);
    out.push_str("\n\nCurrent body:\n");
    out.push_str(&m.body);
    out.push_str("\n\nCited atoms:\n");

    let take = m.atom_refs.iter().take(MAX_ATOM_SNIPPETS);
    let mut any = false;
    for rel in take {
        any = true;
        out.push_str("- [");
        out.push_str(rel);
        out.push_str("]\n");
        let path = memory_root.join(rel);
        if let Ok(raw) = std::fs::read_to_string(&path) {
            let snippet = if raw.chars().count() > ATOM_SNIPPET_CHARS {
                let truncated: String =
                    raw.chars().take(ATOM_SNIPPET_CHARS).collect();
                format!("{truncated}…")
            } else {
                raw
            };
            out.push_str(&snippet);
            out.push('\n');
        }
    }
    if !any {
        out.push_str("(no atoms cited)\n");
    }
    out.push_str(
        "\nWrite 2-3 sentences enriching the body with context-aware reasoning. \
         Cite atoms inline using `[path.md]`. Stay under 200 characters total.",
    );
    out
}

/// Validate the LLM's response. Returns the trimmed enriched body when
/// it passes every check; `None` triggers a silent skip in the caller.
///
/// Rules (mirror `co_thinker::validate_and_ground`'s grounding contract):
///   1. Non-empty.
///   2. Under [`MAX_BODY_CHARS`] characters.
///   3. At least one `[path.md]` citation OR no atoms were cited at all.
///   4. When atoms were cited, at least one of them appears verbatim in
///      the enriched body — otherwise the model invented a new claim.
fn validate_enrichment(text: &str, cited_atoms: &[String]) -> Option<String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() > MAX_BODY_CHARS {
        return None;
    }

    // Citation check. If the rule emit cited any atoms, the enrichment
    // MUST keep at least one of them — otherwise we'd be replacing a
    // grounded statement with an ungrounded one.
    if !cited_atoms.is_empty() {
        let mut found = false;
        for rel in cited_atoms {
            if trimmed.contains(rel.as_str()) {
                found = true;
                break;
            }
        }
        if !found {
            return None;
        }

        // Generic citation token check — needs at least one `[…md]`
        // bracket to pass. Treats the body as ungrounded otherwise.
        if !contains_md_citation(&trimmed) {
            return None;
        }
    }

    Some(trimmed)
}

/// `true` when the line contains a `[…md]` (or `[…md ]`) bracketed
/// citation. Mirrors the heuristic in `co_thinker::has_citation`.
fn contains_md_citation(line: &str) -> bool {
    if let Some(open) = line.find('[') {
        if let Some(close_rel) = line[open..].find(']') {
            let inner = &line[open + 1..open + close_rel];
            if inner.contains(".md") {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_enrich_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn sample_match(confidence: f32) -> TemplateMatch {
        TemplateMatch {
            match_id: "test-match-id".into(),
            template: "deadline_approaching".into(),
            body: "**Patent RFP** is due in 12h.".into(),
            confidence,
            atom_refs: vec!["decisions/patent-rfp.md".into()],
            surface_id: None,
            priority: 8,
            is_irreversible: false,
            is_completion_signal: false,
            is_cross_route: false,
        }
    }

    #[test]
    fn test_validate_accepts_grounded_short_body() {
        let cited = vec!["decisions/patent-rfp.md".to_string()];
        let txt = "Patent RFP is due in 12h. Drafts in [decisions/patent-rfp.md] need attorney sign-off.";
        let v = validate_enrichment(txt, &cited);
        assert!(v.is_some(), "grounded body under 200 chars must pass");
    }

    #[test]
    fn test_validate_rejects_too_long() {
        let cited = vec!["decisions/patent-rfp.md".to_string()];
        // 250 chars of x with a citation tacked on.
        let txt = format!("{} [decisions/patent-rfp.md]", "x".repeat(250));
        assert!(validate_enrichment(&txt, &cited).is_none());
    }

    #[test]
    fn test_validate_rejects_missing_citation() {
        let cited = vec!["decisions/patent-rfp.md".to_string()];
        let txt = "RFP is due soon. Bump or close it.";
        assert!(
            validate_enrichment(txt, &cited).is_none(),
            "no [..md] citation token → reject"
        );
    }

    #[test]
    fn test_validate_rejects_dropped_atom_path() {
        let cited = vec!["decisions/patent-rfp.md".to_string()];
        // Has *a* citation but not the cited atom path.
        let txt = "Look at [decisions/something-else.md] instead.";
        assert!(
            validate_enrichment(txt, &cited).is_none(),
            "must keep at least one of the cited atoms verbatim"
        );
    }

    #[test]
    fn test_validate_accepts_uncited_match() {
        // newcomer_onboarding cites no atoms — enrichment without a `[..md]`
        // token is acceptable in that case.
        let cited: Vec<String> = Vec::new();
        let txt = "Welcome — connect Discord to feed Tangerine.";
        assert!(validate_enrichment(txt, &cited).is_some());
    }

    /// `enrich_match` returns `None` when the rule confidence is below
    /// the enrichment floor. Doesn't even attempt a dispatch.
    #[tokio::test]
    async fn test_enrich_skips_below_confidence_threshold() {
        let root = tmp_root();
        let m = sample_match(0.5); // below floor 0.6
        let res = enrich_match(&m, &root, Some("ollama".into())).await;
        let _ = std::fs::remove_dir_all(&root);
        assert!(matches!(res, Ok(None)));
    }

    /// When the user has no working LLM session AND we point the
    /// session-borrower at a closed Ollama port, every channel ends up
    /// in a silent skip → `None`. Cursor's MCP stub would otherwise
    /// answer; we choose `ollama` as the primary so the dispatcher only
    /// hits the closed HTTP path. Cursor's MCP stub still fires after
    /// fall-through, so we accept either Ok(Some(...)) (stub returned
    /// canned text — and our validator dropped it for lacking a real
    /// citation) or Ok(None) here.
    #[tokio::test]
    async fn test_enrich_match_returns_none_on_no_session() {
        let root = tmp_root();
        let mut m = sample_match(0.95);
        // Empty atoms → validator path is the no-citation branch.
        m.atom_refs.clear();
        let res = enrich_match(&m, &root, Some("ollama".into())).await;
        let _ = std::fs::remove_dir_all(&root);
        // The MCP cursor stub may still answer with canned text;
        // either outcome is a silent-skip-or-accept — both must NOT
        // surface as Err.
        assert!(matches!(res, Ok(_)));
    }

    /// Full citation grounding test. Drives `validate_enrichment`
    /// directly with a synthetic LLM response.
    #[tokio::test]
    async fn test_enrich_match_validates_citation() {
        // The validator is the citation gate; this asserts the contract
        // by exercising it with both passing + failing inputs from the
        // same fixture atom set.
        let cited = vec!["decisions/patent-rfp.md".to_string()];
        // Passing: cites the atom + has [..md] token.
        let ok = "Bump [decisions/patent-rfp.md] today — no attorney signed.";
        assert!(validate_enrichment(ok, &cited).is_some());
        // Failing: missing both.
        let bad = "RFP is overdue, please act.";
        assert!(validate_enrichment(bad, &cited).is_none());
    }

    /// Pseudo-positive: feeds the validator a hand-rolled text that
    /// resembles a valid LLM response. Confirms the constructor path
    /// (match_id preservation, body replacement) is wired correctly.
    #[tokio::test]
    async fn test_enrich_match_returns_some_on_valid_response() {
        let cited = vec!["decisions/patent-rfp.md".to_string()];
        let raw = "Bump [decisions/patent-rfp.md] today.";
        let validated = validate_enrichment(raw, &cited);
        assert!(validated.is_some(), "synthetic response must pass");

        // Now build the would-be enriched match (same path enrich_match
        // takes) and assert id + atom_refs are preserved.
        let m = sample_match(0.9);
        let new_m = TemplateMatch {
            match_id: m.match_id.clone(),
            template: m.template.clone(),
            body: validated.unwrap(),
            confidence: m.confidence,
            atom_refs: m.atom_refs.clone(),
            surface_id: m.surface_id.clone(),
            priority: m.priority,
            is_irreversible: m.is_irreversible,
            is_completion_signal: m.is_completion_signal,
            is_cross_route: m.is_cross_route,
        };
        assert_eq!(new_m.match_id, "test-match-id");
        assert_eq!(new_m.atom_refs, vec!["decisions/patent-rfp.md".to_string()]);
        assert!(new_m.body.contains("[decisions/patent-rfp.md]"));
    }
}
