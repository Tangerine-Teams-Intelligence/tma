//! v1.9.0-beta.2 P2-C — Template registry + dispatch.
//!
//! Single integration point for ALL 7 v1.9 rule-based templates. The
//! co-thinker heartbeat (in `co_thinker.rs`) ends with one call to
//! [`evaluate_all`] which:
//!
//!   1. Walks every registered [`Template`] in [`all_templates`] and runs
//!      `evaluate(&ctx)`.
//!   2. Concatenates every match into a single `Vec<TemplateMatch>`.
//!   3. Sorts descending by `priority` (high wins).
//!   4. Truncates to `MAX_PER_HEARTBEAT` so a heartbeat where all 7 fire
//!      doesn't spam the user with 7 simultaneous suggestions.
//!   5. Returns the top N — the caller forwards each via the configured
//!      [`EventSink`] (Tauri sink in production, in-memory sink in tests).
//!
//! This module owns the integration polish. P2-A's and P2-B's templates
//! plug in here; no per-template glue lives in `co_thinker::heartbeat`.
//! The marker block in `co_thinker.rs` is a single call into
//! [`evaluate_all`] — adding/removing a template is a change to
//! `all_templates()` only.
//!
//! Final shape: every template is registered. `test_registry_has_7_templates`
//! pins the count so a future agent can't silently drop a template. The
//! `MAX_PER_HEARTBEAT = 3` throttle below is the integration knob that keeps
//! a 7-fire heartbeat from spamming the suggestion bus.
//!
//! v1.9.0 P4-A — Stage 2 LLM enrichment. After [`evaluate_and_emit`]
//! forwards the rule-based matches via the sink, it spawns a fire-and-
//! forget tokio task per match (subject to [`MAX_ENRICHMENTS_PER_HEARTBEAT`])
//! that calls [`super::llm_enrich::enrich_match`]. On success the enriched
//! body is re-emitted via the sink's `emit_template_match_enriched`
//! channel, sharing the rule emit's `match_id` so the frontend can swap
//! the body in place. The rule emit path is unchanged — enrichment only
//! adds a *second* event with a richer body, never blocks or replaces
//! the fast path.

use std::path::PathBuf;
use std::sync::Arc;

use super::common::{EventSink, Template, TemplateContext, TemplateMatch};

// === All 7 templates — every P2-A + P2-B + P2-C module is landed and wired. ===
// P2-A
use super::conflict::ConflictDetection;
use super::deadline::DeadlineApproaching;
use super::pattern_recurrence::PatternRecurrence;
// P2-B
use super::catchup_hint::CatchupHint;
use super::decision_drift::DecisionDrift;
use super::long_thread::LongThread;
// P2-C
use super::newcomer_onboarding::NewcomerOnboarding;
// === end ===

/// Maximum template matches emitted per heartbeat. Even if all 7 templates
/// fire simultaneously, only the top 3 (by priority) reach the frontend.
/// The remaining matches are silently dropped — they'll re-fire next
/// heartbeat if the underlying conditions still hold.
///
/// 3 chosen as a balance between "user sees the most important signal" and
/// "no notification firehose". The newcomer template fires at priority 10
/// so it always pierces this throttle on a fresh install.
pub const MAX_PER_HEARTBEAT: usize = 3;

/// v1.9.0 P4-A — hard cap on Stage 2 LLM enrichment dispatches per
/// heartbeat. Spec §5: lazy enrichment, max 5 per heartbeat to prevent
/// LLM cost spike when several templates fire in the same tick. The
/// actual count is bounded twice (once by [`MAX_PER_HEARTBEAT`] which
/// truncates the rule fan-out, once by this constant on the enrichment
/// fan-out) — a redundant gate keeps a future bump of one constant from
/// silently increasing the other's load.
pub const MAX_ENRICHMENTS_PER_HEARTBEAT: usize = 5;

/// Build the canonical template list. One stateless instance per template,
/// shared across heartbeats — they have no per-call state.
///
/// Order doesn't affect output (the dispatcher sorts by priority), but it's
/// stable so equal-priority ties resolve deterministically — the order
/// below mirrors `SUGGESTION_ENGINE_SPEC.md` §4 row order.
pub fn all_templates() -> Vec<Arc<dyn Template>> {
    vec![
        // P2-A
        Arc::new(DeadlineApproaching),
        Arc::new(PatternRecurrence),
        Arc::new(ConflictDetection),
        // P2-B
        Arc::new(DecisionDrift),
        Arc::new(LongThread),
        Arc::new(CatchupHint),
        // P2-C
        Arc::new(NewcomerOnboarding),
    ]
}

/// Evaluate every registered template against `ctx`, sort by priority
/// descending, truncate to `MAX_PER_HEARTBEAT`. Returns the top matches
/// with stable `match_id`s already stamped (UUID v4 per match).
///
/// The co-thinker heartbeat is expected to do one call to this fn at the
/// very end of its tick (after the brain doc has been written, after
/// canvas sentinels have been applied) and then forward each returned
/// match through its configured `EventSink`. See the marker block in
/// `co_thinker::heartbeat`.
pub async fn evaluate_all(ctx: &TemplateContext<'_>) -> Vec<TemplateMatch> {
    let mut all_matches: Vec<TemplateMatch> = Vec::new();
    for tpl in all_templates() {
        let mut matches = tpl.evaluate(ctx).await;
        all_matches.append(&mut matches);
    }
    // Stable sort so equal-priority matches keep their template's natural
    // order (deadline before pattern_recurrence before newcomer when all
    // tied at a given priority). This makes test assertions deterministic.
    all_matches.sort_by(|a, b| b.priority.cmp(&a.priority));
    if all_matches.len() > MAX_PER_HEARTBEAT {
        all_matches.truncate(MAX_PER_HEARTBEAT);
    }
    // v1.9.0 P4-A — stamp a UUID v4 per match before any sink sees it. The
    // enrichment path needs a stable id so the second `template_match_enriched`
    // event can target the same suggestion the rule emit created. Templates
    // pre-fill `match_id` with `String::new()`; we only assign here to keep
    // the id contract centralised in one place.
    for m in &mut all_matches {
        if m.match_id.is_empty() {
            m.match_id = uuid::Uuid::new_v4().to_string();
        }
    }
    all_matches
}

/// Convenience for the heartbeat caller: evaluate + emit each match through
/// the supplied sink. Wraps [`evaluate_all`] so the heartbeat doesn't have
/// to iterate the result vec itself; one call suffices.
///
/// Returns the count of matches emitted (post-throttle) so the caller can
/// log it into the observation line. Failures inside the sink are absorbed
/// — a single broken emit must never break the heartbeat.
///
/// **Note (v1.9.0 P4-A):** this signature does NOT spawn LLM enrichment —
/// callers wanting Stage 2 enrichment should use
/// [`evaluate_and_emit_with_enrichment`], which adds the memory_root +
/// primary_tool_id needed for `llm_enrich::enrich_match` and the
/// `Arc<dyn EventSink>` clone required for fire-and-forget spawn.
pub async fn evaluate_and_emit(
    ctx: &TemplateContext<'_>,
    sink: &dyn EventSink,
) -> usize {
    let top = evaluate_all(ctx).await;
    let n = top.len();
    for m in &top {
        sink.emit_template_match(m);
    }
    n
}

/// v1.9.0 P4-A — evaluate + emit + spawn LLM enrichment.
///
/// Same flow as [`evaluate_and_emit`] but with two additions:
///   1. Takes an `Arc<dyn EventSink>` so the spawned enrichment task can
///      hold its own clone — `&dyn EventSink` would not be `'static`.
///   2. After every rule emit, spawns a `tokio` task that calls
///      [`super::llm_enrich::enrich_match`]. On a valid response the task
///      re-emits the enriched body via `sink.emit_template_match_enriched`.
///
/// Enrichment is bounded by [`MAX_ENRICHMENTS_PER_HEARTBEAT`] AND by the
/// confidence floor in [`super::llm_enrich::ENRICHMENT_CONFIDENCE_FLOOR`].
/// Both gates fail silently — the rule body stays put.
pub async fn evaluate_and_emit_with_enrichment(
    ctx: &TemplateContext<'_>,
    sink: Arc<dyn EventSink>,
    memory_root: PathBuf,
    primary_tool_id: Option<String>,
    enrichment_enabled: bool,
) -> usize {
    let top = evaluate_all(ctx).await;
    let n = top.len();
    let mut enrichment_budget = MAX_ENRICHMENTS_PER_HEARTBEAT;

    for m in &top {
        sink.emit_template_match(m);

        if !enrichment_enabled || enrichment_budget == 0 {
            continue;
        }
        if m.confidence < super::llm_enrich::ENRICHMENT_CONFIDENCE_FLOOR {
            // Spec §5: only enrich rules with confidence > 0.6.
            continue;
        }
        enrichment_budget -= 1;

        // Fire-and-forget. We deliberately drop the JoinHandle — a
        // stalled tokio task is not a heartbeat blocker, and the 5s
        // timeout inside `enrich_match` bounds the worst case.
        let m_clone = m.clone();
        let sink_clone: Arc<dyn EventSink> = Arc::clone(&sink);
        let mem = memory_root.clone();
        let tool_id = primary_tool_id.clone();
        tokio::spawn(async move {
            match super::llm_enrich::enrich_match(&m_clone, &mem, tool_id).await {
                Ok(Some(enriched)) => {
                    sink_clone.emit_template_match_enriched(&enriched);
                }
                _ => {
                    // Silent skip on Ok(None) and Err — the rule body
                    // stays put. Telemetry would be appropriate here,
                    // but the templates layer is sink-only; the daemon
                    // tracks heartbeat counts via the observation log.
                }
            }
        });
    }
    n
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agi::templates::common::InMemorySink;
    use chrono::Utc;
    use std::path::PathBuf;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_registry_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn empty_ctx<'a>(root: &'a PathBuf) -> TemplateContext<'a> {
        TemplateContext {
            memory_root: root,
            now: Utc::now(),
            recent_telemetry: Vec::new(),
        }
    }

    #[test]
    fn test_registry_has_7_templates() {
        let templates = all_templates();
        assert_eq!(
            templates.len(),
            7,
            "registry must list all 7 v1.9 templates, found {}",
            templates.len()
        );
    }

    #[test]
    fn test_registry_template_names_are_unique_and_complete() {
        let templates = all_templates();
        let mut names: Vec<&str> = templates.iter().map(|t| t.name()).collect();
        names.sort();
        let original = names.clone();
        names.dedup();
        assert_eq!(
            names, original,
            "every template must have a unique name; got {:?}",
            original
        );
        // Spec §4 — every named template id must be present.
        let expected = [
            "deadline_approaching",
            "pattern_recurrence",
            "conflict_detection",
            "decision_drift",
            "long_thread",
            "catchup_hint",
            "newcomer_onboarding",
        ];
        for id in expected {
            assert!(
                names.contains(&id),
                "missing template id '{}' in registry; found {:?}",
                id,
                names
            );
        }
    }

    #[tokio::test]
    async fn test_evaluate_all_returns_top_priority_first() {
        // Empty memory + no telemetry → only the newcomer template fires
        // (priority 10). Other templates produce empty results, so the
        // top match is the newcomer.
        let root = tmp_root();
        let ctx = empty_ctx(&root);
        let matches = evaluate_all(&ctx).await;
        assert!(!matches.is_empty(), "newcomer must fire on empty memory");
        assert_eq!(matches[0].template, "newcomer_onboarding");
        assert_eq!(matches[0].priority, 10);
        // Priorities monotonically descend.
        for w in matches.windows(2) {
            assert!(w[0].priority >= w[1].priority);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_evaluate_all_caps_at_max() {
        // Stage a memory dir where multiple templates fire to verify the
        // MAX_PER_HEARTBEAT throttle. 4 deadline atoms with `due_at` 6h out
        // → 4 deadline matches at priority 8. With 4 atoms (≤ newcomer's 5
        // threshold) newcomer also fires at priority 10. Total = 5 matches
        // → truncated to MAX_PER_HEARTBEAT (3): newcomer first, then top 2
        // deadlines.
        let root = tmp_root();
        let now = Utc::now();
        for i in 0..4 {
            let due = now + chrono::Duration::hours(6);
            let body = format!(
                "---\ntitle: t{i}\ndue_at: {ts}\nproject: x\n---\n\nbody\n",
                ts = due.to_rfc3339()
            );
            let path = root.join("decisions").join(format!("t{i}.md"));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, body).unwrap();
        }
        let ctx = TemplateContext {
            memory_root: &root,
            now,
            recent_telemetry: Vec::new(),
        };
        let matches = evaluate_all(&ctx).await;
        assert_eq!(
            matches.len(),
            MAX_PER_HEARTBEAT,
            "registry must throttle to MAX_PER_HEARTBEAT, got {}",
            matches.len()
        );
        // Newcomer's priority 10 must lead the pack.
        assert_eq!(matches[0].template, "newcomer_onboarding");
        assert_eq!(matches[0].priority, 10);
        // Remaining slots are top-2 deadlines at priority 8.
        for tail in &matches[1..] {
            assert_eq!(tail.template, "deadline_approaching");
            assert_eq!(tail.priority, 8);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_evaluate_and_emit_forwards_to_sink() {
        let root = tmp_root();
        let ctx = empty_ctx(&root);
        let sink = InMemorySink::new();
        let n = evaluate_and_emit(&ctx, sink.as_ref()).await;
        let captured = sink.snapshot();
        assert_eq!(n, captured.len());
        assert!(
            captured.iter().any(|m| m.template == "newcomer_onboarding"),
            "newcomer must be emitted on empty memory"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_evaluate_all_is_stable_when_no_templates_match() {
        // Memory dir has 6 atoms (above newcomer threshold) and no due_at
        // atoms → no template fires.
        let root = tmp_root();
        for i in 0..6 {
            let path = root.join(format!("decisions/x{i}.md"));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "---\n---\nbody\n").unwrap();
        }
        let ctx = TemplateContext {
            memory_root: &root,
            now: Utc::now(),
            recent_telemetry: Vec::new(),
        };
        let matches = evaluate_all(&ctx).await;
        assert!(matches.is_empty(), "no template should match");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_max_per_heartbeat_is_three() {
        // The constant is the integration knob. If we ever bump it, this
        // test forces an explicit decision (and a doc update) rather than
        // a silent change.
        assert_eq!(MAX_PER_HEARTBEAT, 3);
    }

    /// v1.9.0 P4-A — every emitted match carries a non-empty UUID-shaped
    /// `match_id`. Pinned so the enrichment path can rely on the id being
    /// stable across the rule emit + the (possibly later) enriched emit.
    #[tokio::test]
    async fn test_evaluate_all_stamps_match_ids() {
        let root = tmp_root();
        let ctx = empty_ctx(&root);
        let matches = evaluate_all(&ctx).await;
        assert!(!matches.is_empty());
        let mut ids: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        for m in &matches {
            assert!(
                !m.match_id.is_empty(),
                "every match must carry a stamped match_id"
            );
            assert!(
                ids.insert(m.match_id.clone()),
                "match_id must be unique across matches in a single tick"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// v1.9.0 P4-A — enrichment budget cap. We can't run real LLM
    /// dispatches in unit tests, but we *can* assert that the registry
    /// emits no more enrichment events than the per-heartbeat budget
    /// allows. We stage a memory dir with > 5 matches that all clear the
    /// enrichment confidence floor (deadline @ 0.95) and assert the
    /// enriched-emit count never exceeds [`MAX_ENRICHMENTS_PER_HEARTBEAT`].
    ///
    /// Since session_borrower's MCP stub for the default tool returns
    /// canned text that doesn't pass our citation grounding rule, the
    /// enrichment path always returns Ok(None) — but the task is still
    /// spawned, so we can count the *attempted* enrichments via the
    /// dispatch count gate. Here we exercise the spawn-budget pathway
    /// indirectly: post-truncation we have ≤ MAX_PER_HEARTBEAT (3)
    /// matches, all clearing the floor, so at most 3 spawns occur. The
    /// budget cap of 5 is therefore not exercised by [3, 5] alone — we
    /// instead unit-test the budget arithmetic itself.
    #[test]
    fn test_enrichment_budget_caps_at_5_per_heartbeat() {
        // The spawn loop in `evaluate_and_emit_with_enrichment` takes
        // exactly `min(MAX_PER_HEARTBEAT, MAX_ENRICHMENTS_PER_HEARTBEAT)`
        // steps before either budget is exhausted. We assert the
        // documented contract here so a future bump of one constant
        // forces an explicit decision about the other.
        assert_eq!(MAX_ENRICHMENTS_PER_HEARTBEAT, 5);
        assert!(
            MAX_ENRICHMENTS_PER_HEARTBEAT >= MAX_PER_HEARTBEAT,
            "enrichment budget must be at least the per-heartbeat fan-out"
        );
    }

    /// v1.9.0 P4-A — when enrichment is disabled, `evaluate_and_emit_with_enrichment`
    /// behaves identically to `evaluate_and_emit` (no enrichment events).
    #[tokio::test]
    async fn test_evaluate_and_emit_with_enrichment_disabled_skips_all() {
        let root = tmp_root();
        let ctx = empty_ctx(&root);
        let sink = InMemorySink::new();
        let arc_sink: Arc<dyn EventSink> = sink.clone();
        let n = evaluate_and_emit_with_enrichment(
            &ctx,
            arc_sink,
            root.clone(),
            None,
            false, // enrichment_enabled = false
        )
        .await;
        // Rule emits still happen — only the spawn path is gated.
        assert!(n >= 1, "rule emit happens regardless of enrichment flag");
        let captured = sink.snapshot();
        assert_eq!(captured.len(), n);
        // No enrichment dispatched → no enriched emit ever (confirmed
        // synchronously here because no spawn happened).
        let enriched = sink.enriched_snapshot();
        assert!(
            enriched.is_empty(),
            "enrichment disabled → no enriched emits"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
