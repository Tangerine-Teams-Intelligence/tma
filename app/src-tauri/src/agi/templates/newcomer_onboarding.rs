//! v1.9.0-beta.2 P2-C — Template #6: newcomer_onboarding.
//!
//! Spec ref: `SUGGESTION_ENGINE_SPEC.md` §4 row 6.
//!
//! "Welcome 🍊. Connect a source so Tangerine can see your team's actual
//! workflow. Discord works in 2 minutes."
//!
//! Trigger: `~/.tangerine-memory/` has `< 5 captured atoms` (markdown files
//! across all source-type subdirs — `meetings/` / `decisions/` / `threads/`
//! / `projects/` / `briefs/` / `messages/` / `notes/` etc.) AND no telemetry
//! events older than 24h. Both conditions must be true to fire — a returning
//! user who briefly empties their memory dir but has 24h+ telemetry is NOT
//! a "newcomer".
//!
//! Tier: toast, priority 10. The prompt pins `priority = 10` so the toast
//! fires before any other template's match competes for the
//! `MAX_PER_HEARTBEAT = 3` slots in `registry::evaluate_all`.
//!
//! Confidence: 1.0. The fresh-install detection is a hard fact — either there
//! are < 5 atoms + no old telemetry, or there aren't. No heuristic in the
//! match path.
//!
//! Idempotency: the Rust detector itself is stateless. The frontend store
//! flag `newcomerOnboardingShown` (added in `app/src/lib/store.ts`) is what
//! enforces "only fires once per fresh-install session" — when the React
//! `template_match` listener in `AppShell.tsx` sees a `newcomer_onboarding`
//! match it checks the flag, calls `pushSuggestion` only when the flag is
//! `false`, and flips the flag to `true` after the suggestion is pushed (or
//! dismissed). Once flipped, future heartbeats still emit the match but the
//! frontend silently drops it.
//!
//! `TemplateContext::recent_telemetry` is loaded by the heartbeat caller from
//! `agi::telemetry::read_events_window(memory_root, 168)` (7-day window). We
//! treat "no events older than 24h" as "every event in the 7-day window has
//! a ts within the last 24h, OR the window is empty". A single ts older than
//! 24h means the user has been around longer than a day → not a newcomer.

use std::path::Path;

use chrono::{DateTime, Duration, Utc};
use futures_util::future::BoxFuture;

use super::common::{Template, TemplateContext, TemplateMatch};
use crate::agi::telemetry::TelemetryEvent;

/// Below this atom count, we treat the install as fresh. The bound is
/// inclusive of zero — a brand-new install has 0 atoms and still fires.
pub(crate) const MAX_FRESH_ATOMS: usize = 5;

/// "No telemetry events older than 24h." Anything older means the user has
/// been around for more than a day → not a newcomer.
pub(crate) const FRESH_AGE_HOURS: i64 = 24;

/// Toast tier priority. Set to 10 (top of the 0..10 range) so the newcomer
/// pulse beats every other template's match in `registry::evaluate_all`'s
/// priority sort. The frontend's tier engine still pins this to a toast
/// because we set neither `is_cross_route` nor `is_irreversible`.
pub(crate) const PRIORITY: u8 = 10;

/// Stateless detector — lives in the registry as a unit struct.
pub struct NewcomerOnboarding;

impl Template for NewcomerOnboarding {
    fn name(&self) -> &'static str {
        "newcomer_onboarding"
    }

    fn evaluate<'a>(
        &'a self,
        ctx: &'a TemplateContext<'a>,
    ) -> BoxFuture<'a, Vec<TemplateMatch>> {
        Box::pin(async move {
            let now = ctx.now;
            // Walk the memory tree once. Bounded to MAX_FRESH_ATOMS+1 reads
            // so a user with 10000 atoms doesn't pay any walk cost.
            let atoms_count = count_user_atoms(ctx.memory_root, MAX_FRESH_ATOMS + 1);
            if atoms_count > MAX_FRESH_ATOMS {
                return Vec::new();
            }
            // "No events older than 24h." Walk telemetry; bail on the first
            // event whose ts predates the cutoff.
            if any_event_older_than(&ctx.recent_telemetry, now, FRESH_AGE_HOURS) {
                return Vec::new();
            }
            vec![build_match()]
        })
    }
}

/// The actual match shape. Public so unit tests can compare against the
/// canonical body string without re-deriving it.
pub(crate) fn build_match() -> TemplateMatch {
    TemplateMatch {
        match_id: String::new(),
        template: "newcomer_onboarding".into(),
        body:
            "Welcome 🍊. Connect a source so Tangerine can see your team's actual workflow. \
             Discord works in 2 minutes."
                .into(),
        confidence: 1.0,
        atom_refs: Vec::new(),
        surface_id: None,
        priority: PRIORITY,
        is_irreversible: false,
        // No flags set → default catch-all in the frontend's `selectTier` is
        // toast (when no `surface_id` and no `is_cross_route`). The prompt
        // pinned this to toast tier explicitly.
        is_completion_signal: false,
        is_cross_route: false,
    }
}

/// Walk every user-facing memory subdir and tally `.md` files until we hit
/// `cap`. Skips the `agi/` and `.tangerine/` subtrees (those are co-thinker /
/// daemon sidecars, not user atoms). Returns the count, capped at `cap` so
/// the walk is bounded.
pub(crate) fn count_user_atoms(memory_root: &Path, cap: usize) -> usize {
    let mut count = 0usize;
    let entries = match std::fs::read_dir(memory_root) {
        Ok(it) => it,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        if count >= cap {
            return cap;
        }
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        if name_str == "agi" {
            // The brain doc + observation log + proposals; not user atoms.
            continue;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            count = count_user_atoms_in_dir(&path, count, cap);
        } else if ft.is_file() && name_str.ends_with(".md") {
            count += 1;
        }
    }
    count.min(cap)
}

/// Recursive walker. Counts `.md` files under `dir` into `count`, returning
/// the new count. Bails as soon as `count >= cap`.
fn count_user_atoms_in_dir(dir: &Path, mut count: usize, cap: usize) -> usize {
    if count >= cap {
        return cap;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(it) => it,
        Err(_) => return count,
    };
    for entry in entries.flatten() {
        if count >= cap {
            return cap;
        }
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            count = count_user_atoms_in_dir(&path, count, cap);
        } else if ft.is_file() && name_str.ends_with(".md") {
            count += 1;
        }
    }
    count
}

/// True when at least one telemetry event has a ts older than `now -
/// hours`. Malformed timestamps are tolerated (skipped) — telemetry is
/// observational and a single bad row shouldn't flip the newcomer flag.
pub(crate) fn any_event_older_than(
    events: &[TelemetryEvent],
    now: DateTime<Utc>,
    hours: i64,
) -> bool {
    let cutoff = now - Duration::hours(hours);
    for e in events {
        if let Ok(ts) = DateTime::parse_from_rfc3339(&e.ts) {
            if ts.with_timezone(&Utc) < cutoff {
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
            "tii_newcomer_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn touch_atom(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
    }

    fn ev(name: &str, hours_ago: i64) -> TelemetryEvent {
        TelemetryEvent {
            event: name.to_string(),
            ts: (Utc::now() - Duration::hours(hours_ago)).to_rfc3339(),
            user: "daizhe".to_string(),
            payload: serde_json::json!({}),
        }
    }

    fn ctx_for<'a>(
        root: &'a Path,
        telemetry: Vec<TelemetryEvent>,
        now: DateTime<Utc>,
    ) -> TemplateContext<'a> {
        TemplateContext {
            memory_root: root,
            now,
            recent_telemetry: telemetry,
        }
    }

    #[tokio::test]
    async fn test_newcomer_fires_on_empty_memory() {
        // 0 atoms, no telemetry → must fire.
        let root = tmp_root();
        let ctx = ctx_for(&root, vec![], Utc::now());
        let matches = NewcomerOnboarding.evaluate(&ctx).await;
        assert_eq!(matches.len(), 1);
        let m = &matches[0];
        assert_eq!(m.template, "newcomer_onboarding");
        assert!(m.body.contains("Welcome"));
        assert!(m.body.contains("Discord"));
        assert!((m.confidence - 1.0).abs() < 1e-6);
        assert_eq!(m.priority, PRIORITY);
        // Toast tier — no banner / modal / chip flags.
        assert!(!m.is_cross_route);
        assert!(!m.is_irreversible);
        assert!(!m.is_completion_signal);
        assert!(m.surface_id.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_newcomer_skips_if_atoms_exist() {
        // 6 atoms (above the MAX_FRESH_ATOMS=5 bar) → silent.
        let root = tmp_root();
        for i in 0..6 {
            touch_atom(
                &root,
                &format!("decisions/sample-{i}.md"),
                "---\ntitle: x\n---\n\nbody\n",
            );
        }
        let ctx = ctx_for(&root, vec![], Utc::now());
        let matches = NewcomerOnboarding.evaluate(&ctx).await;
        assert!(matches.is_empty(), "with 6 atoms newcomer must not fire");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_newcomer_at_threshold_still_fires() {
        // Exactly 5 atoms — boundary check, MAX_FRESH_ATOMS is inclusive.
        let root = tmp_root();
        for i in 0..5 {
            touch_atom(
                &root,
                &format!("decisions/sample-{i}.md"),
                "---\n---\nbody\n",
            );
        }
        let ctx = ctx_for(&root, vec![], Utc::now());
        let matches = NewcomerOnboarding.evaluate(&ctx).await;
        assert_eq!(
            matches.len(),
            1,
            "5 atoms is right on the boundary — must still fire"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_newcomer_skips_if_telemetry_older_than_24h() {
        // 0 atoms but telemetry has an event from 30h ago → returning user.
        let root = tmp_root();
        let now = Utc::now();
        let old = ev("navigate_route", 30);
        let ctx = ctx_for(&root, vec![old], now);
        let matches = NewcomerOnboarding.evaluate(&ctx).await;
        assert!(
            matches.is_empty(),
            "30h-old telemetry means returning user, not newcomer"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_newcomer_fires_with_only_fresh_telemetry() {
        // 0 atoms + 5 events all under 24h → still a newcomer.
        let root = tmp_root();
        let now = Utc::now();
        let recent: Vec<TelemetryEvent> = (0..5).map(|i| ev("navigate_route", i)).collect();
        let ctx = ctx_for(&root, recent, now);
        let matches = NewcomerOnboarding.evaluate(&ctx).await;
        assert_eq!(matches.len(), 1, "all-fresh telemetry doesn't disqualify");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_newcomer_idempotent_via_repeated_eval() {
        // The detector itself is stateless — repeated calls return identical
        // matches. The "fires only once" guarantee is enforced frontend-side
        // by the `newcomerOnboardingShown` store flag (see AppShell.tsx).
        // This test pins the Rust contract: the detector keeps firing as
        // long as the conditions hold.
        let root = tmp_root();
        let ctx = ctx_for(&root, vec![], Utc::now());
        let m1 = NewcomerOnboarding.evaluate(&ctx).await;
        let m2 = NewcomerOnboarding.evaluate(&ctx).await;
        assert_eq!(m1.len(), 1);
        assert_eq!(m2.len(), 1);
        assert_eq!(m1[0].body, m2[0].body);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_count_user_atoms_skips_agi_subtree() {
        let root = tmp_root();
        // The agi/ subtree is NOT counted — co-thinker brain doc, observations,
        // proposals are not user atoms.
        touch_atom(&root, "agi/co-thinker.md", "self");
        touch_atom(&root, "agi/observations/2026-04-26.md", "log");
        // Two real atoms.
        touch_atom(&root, "decisions/x.md", "atom");
        touch_atom(&root, "meetings/y.md", "atom");
        let n = count_user_atoms(&root, 100);
        assert_eq!(n, 2, "agi/ files must not be counted as user atoms");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_count_user_atoms_caps_walk() {
        // 20 atoms, cap = 5 → returns 5 without walking the rest.
        let root = tmp_root();
        for i in 0..20 {
            touch_atom(&root, &format!("decisions/{i}.md"), "x");
        }
        let n = count_user_atoms(&root, 5);
        assert_eq!(n, 5, "walk must short-circuit at cap");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_any_event_older_than_handles_malformed_ts() {
        let now = Utc::now();
        let bad = TelemetryEvent {
            event: "x".to_string(),
            ts: "not-a-real-timestamp".to_string(),
            user: "u".to_string(),
            payload: serde_json::json!({}),
        };
        let recent_only = vec![bad, ev("x", 1)];
        // Malformed ts is silently skipped; the only valid event is 1h old →
        // no event older than 24h.
        assert!(!any_event_older_than(&recent_only, now, 24));
    }

    #[test]
    fn test_newcomer_fires_only_once() {
        // Documents the contract that the frontend store flag enforces. The
        // Rust side is stateless — it keeps emitting `build_match()` on
        // every heartbeat where conditions hold. The "fires only once"
        // guarantee is enforced at the React layer by the
        // `newcomerOnboardingShown` store latch in
        // `app/src/components/layout/AppShell.tsx`'s `template_match`
        // listener (and exercised by
        // `app/tests/template-listener.test.tsx::"newcomer flag stops
        // re-fire"`). This Rust test pins the Rust-side contract: the
        // detector emits a deterministic, identical match each call so the
        // React latch sees the same payload to filter on.
        let m1 = build_match();
        let m2 = build_match();
        assert_eq!(m1.template, m2.template);
        assert_eq!(m1.body, m2.body);
        // The body is the canonical onboarding copy — contract-locked so
        // future copy edits show up in test diff.
        assert!(m1.body.starts_with("Welcome"));
        assert!(m1.body.contains("Discord"));
    }
}
