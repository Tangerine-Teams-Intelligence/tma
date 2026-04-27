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
/// descending, truncate to `MAX_PER_HEARTBEAT`. Returns the top matches.
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
    all_matches
}

/// Convenience for the heartbeat caller: evaluate + emit each match through
/// the supplied sink. Wraps [`evaluate_all`] so the heartbeat doesn't have
/// to iterate the result vec itself; one call suffices.
///
/// Returns the count of matches emitted (post-throttle) so the caller can
/// log it into the observation line. Failures inside the sink are absorbed
/// — a single broken emit must never break the heartbeat.
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
}
