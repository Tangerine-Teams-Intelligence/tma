//! v1.9.0-beta.2 P2-B — Template #10: catchup_hint.
//!
//! Surfaces a high-priority banner the FIRST time the user opens the app
//! after >= 24h of inactivity. Body: "**{N} things changed since you were
//! last here.** {decision_count} decisions locked. Click for catchup." with
//! a CTA to navigate to `/today` (the catchup view).
//!
//! Tier: banner (`is_cross_route: true`). Confidence 0.9 — deterministic
//! from telemetry. Priority 10 (highest of all v1.9 templates) — this is
//! the first thing the user should see on returning, ahead of every other
//! suggestion competing for the banner slot.
//!
//! Detection (per spec §4 row 10):
//!   1. Find the most recent `navigate_route` event in the last-7d
//!      telemetry window passed via `TemplateContext::recent_telemetry`.
//!   2. If no event exists OR the most recent is < 24h ago → no match.
//!   3. Otherwise count atoms in `/memory/{meetings,decisions,threads,projects}`
//!      whose mtime is >= the last activity ts. If the total delta is < 1
//!      → no match (nothing actually changed; banner would be noise).
//!   4. Within those, count "significant decisions" — decision atoms with
//!      `status: locked` frontmatter — separately so the body can show
//!      both numbers.
//!
//! Notes:
//!   * Empty telemetry (first launch, just-cleared) → no match. Spec is
//!     explicit: "If telemetry empty (first launch or just cleared) → no
//!     match either." This protects against false positives on a fresh
//!     install where every atom is technically "newer than last activity".
//!   * Once the user navigates after seeing the banner, the next heartbeat
//!     re-reads telemetry, finds the fresh `navigate_route` event, and
//!     stops firing. So the banner self-clears after one click.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use futures_util::future::BoxFuture;

use super::common::{parse_frontmatter, Template, TemplateContext, TemplateMatch};
use crate::agi::telemetry::TelemetryEvent;

const TEMPLATE_ID: &str = "catchup_hint";
const CONFIDENCE: f32 = 0.9;
const PRIORITY: u8 = 10;
const IDLE_THRESHOLD_HOURS: i64 = 24;
/// Subdirs we count when assembling the "things changed" tally. Order
/// fixed so the count is reproducible across platforms.
const ATOM_SUBDIRS: &[&str] = &["meetings", "decisions", "threads", "projects"];

/// Stateless detector. No fields — created fresh per heartbeat.
pub struct CatchupHint;

impl Template for CatchupHint {
    fn name(&self) -> &'static str {
        TEMPLATE_ID
    }

    fn evaluate<'a>(
        &'a self,
        ctx: &'a TemplateContext<'a>,
    ) -> BoxFuture<'a, Vec<TemplateMatch>> {
        Box::pin(async move {
            // 1. Find most recent navigate_route in telemetry. None → no match.
            let last_active = match find_last_navigate(&ctx.recent_telemetry) {
                Some(ts) => ts,
                None => return Vec::new(),
            };

            // 2. < 24h idle → no match.
            let idle = ctx.now.signed_duration_since(last_active);
            if idle < Duration::hours(IDLE_THRESHOLD_HOURS) {
                return Vec::new();
            }

            // 3. Count changed atoms since last_active.
            let (atom_delta, decision_count) =
                count_changes_since(ctx.memory_root, last_active);

            // 4. Nothing changed → don't bother the user.
            if atom_delta == 0 {
                return Vec::new();
            }

            let body = format!(
                "**{n} things changed since you were last here.** \
                 {d} decisions locked. Click for catchup.",
                n = atom_delta,
                d = decision_count,
            );

            let m = TemplateMatch {
                template: TEMPLATE_ID.into(),
                body,
                confidence: CONFIDENCE,
                atom_refs: Vec::new(),
                surface_id: None,
                priority: PRIORITY,
                is_irreversible: false,
                is_completion_signal: false,
                is_cross_route: true,
            };

            // Wire a CTA href via the priority side-channel — Phase 2-B's
            // common.rs doesn't have explicit cta fields on TemplateMatch,
            // so the frontend listener picks the route by template id
            // ("catchup_hint" → `/today`). Documented in the bus listener.
            vec![m]
        })
    }
}

/// Pure helper — public within crate so unit tests can drive it without a
/// full TemplateContext + filesystem.
pub(crate) fn find_last_navigate(events: &[TelemetryEvent]) -> Option<DateTime<Utc>> {
    let mut latest: Option<DateTime<Utc>> = None;
    for ev in events {
        if ev.event != "navigate_route" {
            continue;
        }
        if let Ok(parsed) = DateTime::parse_from_rfc3339(&ev.ts) {
            let utc = parsed.with_timezone(&Utc);
            latest = match latest {
                None => Some(utc),
                Some(prev) if utc > prev => Some(utc),
                Some(prev) => Some(prev),
            };
        }
    }
    latest
}

/// Walk the four atom subdirs and return:
///   * total atom-mtime-since-cutoff count
///   * subset where the atom is a decision with `status: locked`
fn count_changes_since(memory_root: &Path, since: DateTime<Utc>) -> (u32, u32) {
    let mut total = 0u32;
    let mut locked_decisions = 0u32;
    for subdir in ATOM_SUBDIRS {
        for_each_md(memory_root, subdir, |rel, raw, mtime| {
            if mtime < since {
                return;
            }
            total += 1;
            if rel.starts_with("decisions/") {
                let (fm, _body) = parse_frontmatter(raw);
                if let Some(s) = fm.get("status") {
                    if s.to_lowercase() == "locked" {
                        locked_decisions += 1;
                    }
                }
            }
        });
    }
    (total, locked_decisions)
}

/// Recursive walk under `<memory_root>/<subdir>/`. Calls `visit(rel, raw, mtime)`
/// for every `.md` file. Forward-slash paths. Skips hidden + unreadable
/// entries silently.
fn for_each_md(memory_root: &Path, subdir: &str, mut visit: impl FnMut(&str, &str, DateTime<Utc>)) {
    let root = memory_root.join(subdir);
    let mut stack: Vec<PathBuf> = vec![root];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
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
                stack.push(path);
                continue;
            }
            if !ft.is_file() || !name_str.ends_with(".md") {
                continue;
            }
            let raw = match std::fs::read_to_string(&path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|d| DateTime::<Utc>::from_timestamp(d.as_secs() as i64, 0))
                .unwrap_or_else(Utc::now);
            let rel = path
                .strip_prefix(memory_root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            visit(&rel, &raw, mtime);
        }
    }
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_catchup_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn make_event(name: &str, ts: DateTime<Utc>) -> TelemetryEvent {
        TelemetryEvent {
            event: name.to_string(),
            ts: ts.to_rfc3339(),
            user: "daizhe".to_string(),
            payload: serde_json::json!({}),
        }
    }

    fn run(root: &Path, now: DateTime<Utc>, telem: Vec<TelemetryEvent>) -> Vec<TemplateMatch> {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let ctx = TemplateContext {
                memory_root: root,
                now,
                recent_telemetry: telem,
            };
            CatchupHint.evaluate(&ctx).await
        })
    }

    /// Write an atom at `rel` and force its mtime to `mtime` so the
    /// since-cutoff comparator sees the test's chosen time. `set_modified`
    /// is stable since 1.75; our MSRV is 1.78.
    fn write_atom(root: &Path, rel: &str, body: &str, mtime: DateTime<Utc>) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        let secs = mtime.timestamp();
        let st = if secs >= 0 {
            std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs as u64)
        } else {
            std::time::UNIX_EPOCH - std::time::Duration::from_secs((-secs) as u64)
        };
        let f = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap();
        f.set_modified(st).unwrap();
    }

    #[test]
    fn test_catchup_hint_fires_after_24h_idle() {
        let root = tmp_root();
        let now = Utc::now();
        let last_active = now - Duration::hours(48);

        // Three new atoms since last_active.
        write_atom(
            &root,
            "decisions/d1.md",
            "---\nstatus: locked\n---\n\nbody1\n",
            now - Duration::hours(20),
        );
        write_atom(
            &root,
            "decisions/d2.md",
            "---\nstatus: open\n---\n\nbody2\n",
            now - Duration::hours(10),
        );
        write_atom(
            &root,
            "meetings/m1.md",
            "---\n---\n\nbody\n",
            now - Duration::hours(5),
        );

        // Telemetry: one navigate_route 48h ago.
        let telem = vec![make_event("navigate_route", last_active)];
        let matches = run(&root, now, telem);

        assert_eq!(matches.len(), 1, "must fire once");
        let m = &matches[0];
        assert_eq!(m.template, "catchup_hint");
        assert_eq!(m.confidence, CONFIDENCE);
        assert_eq!(m.priority, PRIORITY);
        assert!(m.is_cross_route, "banner tier");
        assert!(m.body.contains("3 things changed"));
        assert!(m.body.contains("1 decisions locked"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_catchup_hint_skips_if_recent_activity() {
        let root = tmp_root();
        let now = Utc::now();
        let last_active = now - Duration::hours(2);

        write_atom(
            &root,
            "decisions/x.md",
            "---\nstatus: locked\n---\n",
            now - Duration::minutes(30),
        );

        let telem = vec![make_event("navigate_route", last_active)];
        let matches = run(&root, now, telem);
        assert!(matches.is_empty(), "2h idle is well under 24h threshold");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_catchup_hint_skips_when_telemetry_empty() {
        let root = tmp_root();
        let now = Utc::now();
        // Atoms exist…
        write_atom(
            &root,
            "decisions/x.md",
            "---\n---\nbody\n",
            now - Duration::hours(1),
        );
        // …but no telemetry → first launch / just cleared. Spec says no match.
        let matches = run(&root, now, Vec::new());
        assert!(matches.is_empty(), "empty telemetry must not fire");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_catchup_hint_skips_when_nothing_changed() {
        // 48h idle but no atoms newer than last_active → user came back to
        // a quiet workspace; banner would be noise.
        let root = tmp_root();
        let now = Utc::now();
        let last_active = now - Duration::hours(48);
        // Pre-existing atom whose mtime is BEFORE last_active.
        write_atom(
            &root,
            "decisions/old.md",
            "---\n---\nold body\n",
            last_active - Duration::hours(5),
        );
        let telem = vec![make_event("navigate_route", last_active)];
        let matches = run(&root, now, telem);
        assert!(matches.is_empty(), "no atom changes → no banner");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_find_last_navigate_picks_max() {
        // Direct test on the helper — multiple navigates, take the latest.
        let now = Utc::now();
        let events = vec![
            make_event("navigate_route", now - Duration::hours(6)),
            make_event("dismiss_chip", now - Duration::hours(2)),
            make_event("navigate_route", now - Duration::hours(1)),
            make_event("navigate_route", now - Duration::hours(8)),
        ];
        let last = find_last_navigate(&events).expect("should find one");
        // Should match the 1h-ago entry.
        assert!((now - last).num_hours() <= 1);
    }

    #[test]
    fn test_find_last_navigate_ignores_other_events() {
        let now = Utc::now();
        let events = vec![
            make_event("dismiss_chip", now - Duration::hours(1)),
            make_event("edit_atom", now - Duration::hours(2)),
        ];
        assert!(find_last_navigate(&events).is_none());
    }
}
