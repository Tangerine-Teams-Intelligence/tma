//! v1.9.0-beta.2 P2-A — Template #3: deadline_approaching.
//!
//! Walk `~/.tangerine-memory/decisions/` and `~/.tangerine-memory/projects/`
//! for atoms with a `due_at:` ISO 8601 frontmatter field. Match when the
//! due timestamp is in the future and ≤ 48h away. Skips atoms where
//! `status:` is `"done"` / `"closed"` / `"completed"` so a freshly-finished
//! task doesn't keep firing.
//!
//! Tier: toast (per SUGGESTION_ENGINE_SPEC.md §4 row 3). Confidence is
//! deterministic 0.95 — `due_at` is a hard timestamp, not a heuristic.
//! Priority maps to time-pressure:
//!   * < 12h  → 8 (high)
//!   * 12-24h → 6 (medium)
//!   * 24-48h → 4 (low)
//!
//! Per the prompt: "tier: toast (via `is_completion_signal: false` and no
//! `surface_id`/`is_cross_route` — defaults to toast)". The bus's
//! `selectTier` takes a request with no special flags and `surface_id:
//! None` → toast (default catch-all).
//!
//! Atom shape we expect:
//! ```yaml
//! ---
//! title: Patent P0 attorney RFP
//! due_at: 2026-04-30T17:00:00Z
//! status: open
//! ---
//! ```

use std::path::Path;

use chrono::{DateTime, Duration, Utc};
use futures_util::future::BoxFuture;

use super::common::{parse_frontmatter, walk_md_files, Template, TemplateContext, TemplateMatch};

const CONFIDENCE: f32 = 0.95;
const WINDOW_HOURS: i64 = 48;

/// Stateless detector — no fields. Constructed once per heartbeat at
/// minimal cost.
pub struct DeadlineApproaching;

impl Template for DeadlineApproaching {
    fn name(&self) -> &'static str {
        "deadline_approaching"
    }

    fn evaluate<'a>(
        &'a self,
        ctx: &'a TemplateContext<'a>,
    ) -> BoxFuture<'a, Vec<TemplateMatch>> {
        Box::pin(async move {
            let mut matches: Vec<TemplateMatch> = Vec::new();
            for subdir in &["decisions", "projects"] {
                for (rel, raw, _mtime) in walk_md_files(ctx.memory_root, subdir) {
                    if let Some(m) = evaluate_one(&rel, &raw, ctx.now) {
                        matches.push(m);
                    }
                }
            }
            matches
        })
    }
}

/// Pure helper: given one atom's relative path + raw markdown + "now",
/// return a match if the due_at falls inside the 0..48h window. Public
/// within the crate so tests can hit it directly without spinning up
/// a fake memory dir.
pub(crate) fn evaluate_one(
    rel_path: &str,
    raw: &str,
    now: DateTime<Utc>,
) -> Option<TemplateMatch> {
    let (fm, _body) = parse_frontmatter(raw);

    let due_at_str = fm.get("due_at")?;
    let due_at = match DateTime::parse_from_rfc3339(due_at_str.as_str()) {
        Ok(dt) => dt.with_timezone(&Utc),
        Err(_) => {
            // Tolerate a naive `YYYY-MM-DD` form ("midnight UTC of that day").
            let date_only = chrono::NaiveDate::parse_from_str(due_at_str, "%Y-%m-%d").ok()?;
            let naive_dt = date_only.and_hms_opt(0, 0, 0)?;
            DateTime::<Utc>::from_naive_utc_and_offset(naive_dt, Utc)
        }
    };

    // Skip already-done atoms.
    if let Some(status) = fm.get("status") {
        let s = status.to_lowercase();
        if s == "done" || s == "closed" || s == "completed" {
            return None;
        }
    }

    // Match window: now < due_at ≤ now + 48h.
    let delta = due_at.signed_duration_since(now);
    if delta <= Duration::zero() {
        return None;
    }
    if delta > Duration::hours(WINDOW_HOURS) {
        return None;
    }

    let hours_remaining = delta.num_minutes() as f64 / 60.0;
    let priority = priority_for(delta);
    let title = fm
        .get("title")
        .cloned()
        .unwrap_or_else(|| derive_title_from_path(rel_path));

    let body = format!(
        "**{title}** is due in {hh}h. _{path}_",
        title = title,
        hh = hours_remaining.round() as i64,
        path = rel_path,
    );

    Some(TemplateMatch {
        template: "deadline_approaching".into(),
        body,
        confidence: CONFIDENCE,
        atom_refs: vec![rel_path.to_string()],
        surface_id: None,
        priority,
        is_irreversible: false,
        is_completion_signal: false,
        is_cross_route: false,
    })
}

fn priority_for(delta: Duration) -> u8 {
    let hours = delta.num_hours();
    if hours < 12 {
        8
    } else if hours < 24 {
        6
    } else {
        4
    }
}

/// Last-resort title when frontmatter has no `title:`. Uses the basename
/// stem with hyphens → spaces.
fn derive_title_from_path(rel_path: &str) -> String {
    let basename = Path::new(rel_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("(untitled)");
    basename.replace('-', " ")
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;

    fn now_utc() -> DateTime<Utc> {
        // Stable anchor — every test computes `due_at` relative to this.
        Utc::now()
    }

    #[test]
    fn test_deadline_matches_within_48h() {
        let now = now_utc();
        let due = now + Duration::hours(20);
        let raw = format!(
            "---\ntitle: Patent attorney RFP\ndue_at: {}\nstatus: open\n---\n\nBody here.\n",
            due.to_rfc3339()
        );
        let m = evaluate_one("decisions/patent-rfp.md", &raw, now).expect("should match");
        assert_eq!(m.template, "deadline_approaching");
        assert_eq!(m.confidence, CONFIDENCE);
        assert_eq!(m.priority, 6, "20h falls in the 12-24h band");
        assert!(m.body.contains("Patent attorney RFP"));
        assert!(m.body.contains("decisions/patent-rfp.md"));
        assert_eq!(m.atom_refs, vec!["decisions/patent-rfp.md".to_string()]);
        assert!(!m.is_irreversible);
        assert!(!m.is_completion_signal);
        assert!(!m.is_cross_route);
        assert!(m.surface_id.is_none(), "toast tier — no surface anchor");
    }

    #[test]
    fn test_deadline_skips_far_future() {
        let now = now_utc();
        // 5 days out — way past the 48h window.
        let due = now + Duration::days(5);
        let raw = format!(
            "---\ntitle: Far thing\ndue_at: {}\nstatus: open\n---\n\nBody.\n",
            due.to_rfc3339()
        );
        let m = evaluate_one("decisions/far-thing.md", &raw, now);
        assert!(m.is_none(), "5-day-out deadline must not fire");
    }

    #[test]
    fn test_deadline_skips_past_due() {
        let now = now_utc();
        let due = now - Duration::hours(1);
        let raw = format!(
            "---\ntitle: Already late\ndue_at: {}\n---\n",
            due.to_rfc3339()
        );
        let m = evaluate_one("decisions/late.md", &raw, now);
        assert!(m.is_none(), "past-due atoms are P-2 (overdue) territory, not this template");
    }

    #[test]
    fn test_deadline_skips_done_status() {
        let now = now_utc();
        let due = now + Duration::hours(10);
        let raw = format!(
            "---\ntitle: Closed task\ndue_at: {}\nstatus: done\n---\n",
            due.to_rfc3339()
        );
        let m = evaluate_one("decisions/closed.md", &raw, now);
        assert!(m.is_none(), "done atoms must not fire even if due_at is near");
    }

    #[test]
    fn test_deadline_priority_bands() {
        let now = now_utc();
        // 6h → high (8)
        let raw = format!(
            "---\ntitle: Urgent\ndue_at: {}\n---\n",
            (now + Duration::hours(6)).to_rfc3339()
        );
        let m = evaluate_one("decisions/urgent.md", &raw, now).unwrap();
        assert_eq!(m.priority, 8);

        // 36h → low (4)
        let raw = format!(
            "---\ntitle: Soon\ndue_at: {}\n---\n",
            (now + Duration::hours(36)).to_rfc3339()
        );
        let m = evaluate_one("decisions/soon.md", &raw, now).unwrap();
        assert_eq!(m.priority, 4);
    }

    #[test]
    fn test_deadline_tolerates_date_only_format() {
        // `due_at: 2030-01-01` (no time component). Treated as 00:00 UTC.
        // Pick a date well past 48h so we *don't* match — proves we parsed
        // it and rejected on window, not on parse failure.
        let now = now_utc();
        let raw = "---\ntitle: Date only\ndue_at: 2030-01-01\n---\n";
        let m = evaluate_one("decisions/date-only.md", raw, now);
        assert!(m.is_none(), "2030 date-only is far future, must skip");
    }

    #[test]
    fn test_deadline_falls_back_to_path_when_no_title() {
        let now = now_utc();
        let due = now + Duration::hours(8);
        let raw = format!("---\ndue_at: {}\n---\n", due.to_rfc3339());
        let m = evaluate_one("decisions/no-title-here.md", &raw, now).unwrap();
        // basename "no-title-here" with hyphens → spaces
        assert!(m.body.contains("no title here"));
    }
}
