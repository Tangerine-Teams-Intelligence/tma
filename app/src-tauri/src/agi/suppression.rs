//! v1.9.0-beta.3 P3-A — Pattern-learned dismiss suppression.
//!
//! CEO 6 anti-Clippy disciplines #3: when the user dismisses the same
//! suggestion template 3 times, suppress it for 30 days. v1.8 only had a
//! 24h `dismissedSurfaces` throttle (`lib/ambient.ts::THROTTLE_24H_MS`);
//! beta.3 adds this longer pattern-learned layer that kicks in after the
//! 3rd dismiss.
//!
//! Storage:
//!   `~/.tangerine-memory/.tangerine/suppression.json`
//!
//! Atomic write via `.tmp` + rename (same model used by every other
//! sidecar writer in the app — see `agi::canvas::save_topic`).
//!
//! Recompute path: every daemon heartbeat we walk the last 30 days of
//! telemetry JSONL (P1-A) and rebuild the map from scratch. Cheap (~ms)
//! because the events we care about (`dismiss_*` family) are a thin
//! slice of the total log. Idempotent — recomputing twice yields the
//! same map.
//!
//! Suppression key strategy: per-`{template, scope}` rather than global.
//! Dismissing `deadline_approaching` for atom A 3× must NOT silence
//! deadline matches for atom B. Scope resolution at write time:
//!
//!   1. The first entry of the match's `atom_refs` (if non-empty), e.g.
//!      `decisions/patent-rfp.md`.
//!   2. Else the chip-tier `surface_id`, e.g. `input-textarea-foo`.
//!   3. Else the literal string `"global"`.
//!
//! The 30d window is consulted by the frontend `pushSuggestion(...)` —
//! the bus calls `suppression_check` before dispatching; suppressed
//! matches drop with a `suggestion_dropped` telemetry record (reason =
//! `suppressed`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::agi::telemetry::{self, TelemetryEvent};
use crate::commands::AppError;

/// Promotion threshold — number of dismisses of a `{template, scope}`
/// pair within the recompute window before we enter the 30d suppression
/// state. Spec §1.3 explicitly fixes this at 3.
pub const SUPPRESSION_THRESHOLD: u32 = 3;

/// Suppression duration once the threshold is hit. Spec §1.3 fixes this
/// at 30 days.
pub const SUPPRESSION_DAYS: i64 = 30;

/// How far back the recompute pass walks the telemetry log. Matches
/// `SUPPRESSION_DAYS` so a suppression that was just promoted yesterday
/// doesn't accidentally lapse the next time we recompute (the 3rd
/// dismiss event still falls inside the window). Telemetry's own
/// retention is 90 days, so we never read past the available data.
pub const RECOMPUTE_WINDOW_DAYS: i64 = 30;

/// Filename under `<memory_root>/.tangerine/`. Singular file (not
/// per-day rotated) — the whole map fits in a few KiB even after months
/// of dismisses.
const FILENAME: &str = "suppression.json";

/// One entry per `{template, scope}` pair. Promoted into the suppressed
/// state once `dismiss_count >= SUPPRESSION_THRESHOLD`; from that moment
/// `suppressed_until` is `Some(now + 30d)` and the bus drops the
/// template for that scope until the timestamp passes.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SuppressionEntry {
    /// Composite key — `"{template}:{scope}"`. Stored explicitly (rather
    /// than derived from the map's outer key) so a serialized array of
    /// entries via `suppression_list` keeps the key visible in payloads.
    pub key: String,
    /// Template id (e.g. `"deadline_approaching"`). Mirrors
    /// `agi::templates::common::TemplateMatch::template`.
    pub template: String,
    /// Scope qualifier — atom path, surface_id, or `"global"`. See module
    /// doc for the resolution chain.
    pub scope: String,
    /// Number of dismisses observed within the recompute window for this
    /// pair. Capped only by the available telemetry — once the count
    /// reaches `SUPPRESSION_THRESHOLD`, `suppressed_until` is set and
    /// further dismisses keep the count rolling without re-extending the
    /// 30d window.
    pub dismiss_count: u32,
    /// Most recent dismiss timestamp seen. Read by the UI for the
    /// "dismissed N times, last on …" affordance.
    pub last_dismiss_at: DateTime<Utc>,
    /// `Some(ts)` once the threshold trips; `None` until the third
    /// dismiss arrives. The bus checks `now < ts` to gate.
    pub suppressed_until: Option<DateTime<Utc>>,
}

/// Build the canonical key from `{template, scope}`. Public so the
/// frontend → backend round-trip in `suppression_check` can use the
/// exact same encoding without re-implementing it on the JS side.
pub fn make_key(template: &str, scope: &str) -> String {
    format!("{}:{}", template, scope)
}

/// Path to the on-disk JSON file.
fn db_path(memory_root: &Path) -> PathBuf {
    memory_root.join(".tangerine").join(FILENAME)
}

/// Load the suppression map from disk. Returns an empty map when the
/// file doesn't exist (= fresh install) or is unreadable / malformed
/// (= disk corruption — the next recompute will rebuild it).
pub async fn read_suppression_db(
    memory_root: &Path,
) -> Result<HashMap<String, SuppressionEntry>, AppError> {
    let path = db_path(memory_root);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(HashMap::new()),
    };
    if raw.trim().is_empty() {
        return Ok(HashMap::new());
    }
    // Defensive parse — a hand-edited / corrupt file should not crash
    // the daemon. The next recompute will overwrite it cleanly.
    match serde_json::from_str::<HashMap<String, SuppressionEntry>>(&raw) {
        Ok(m) => Ok(m),
        Err(_) => Ok(HashMap::new()),
    }
}

/// Persist the suppression map atomically. Writes to `<file>.tmp` then
/// renames over the destination so a crash mid-write never leaves a
/// truncated JSON blob behind. Creates the parent dir on first call.
pub async fn write_suppression_db(
    memory_root: &Path,
    db: &HashMap<String, SuppressionEntry>,
) -> Result<(), AppError> {
    let path = db_path(memory_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir_suppression", e.to_string()))?;
    }
    let body = serde_json::to_string_pretty(db)
        .map_err(|e| AppError::internal("serialize_suppression", e.to_string()))?;

    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body.as_bytes())
        .map_err(|e| AppError::internal("write_suppression_tmp", e.to_string()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| AppError::internal("rename_suppression", e.to_string()))?;
    Ok(())
}

/// Recompute the suppression map from scratch by walking the last 30
/// days of telemetry events. Counts `dismiss_*` events grouped by
/// `{template, scope}` and promotes any pair with count ≥ threshold to
/// the suppressed state.
///
/// Telemetry payload contract (mirrors `lib/telemetry.ts`):
///
/// * `dismiss_chip`   — `{ surface_id, template?, atom_path?, ... }`
/// * `dismiss_banner` — `{ surface_id, banner_kind, template?, atom_path? }`
/// * `dismiss_toast`  — `{ toast_id, kind?, template?, atom_path? }`
/// * `dismiss_modal`  — `{ surface_id, modal_kind?, template?, atom_path? }`
///
/// We treat `template` (when present) as the suggestion template id and
/// derive `scope` from `atom_path` first, falling back to `surface_id`,
/// then `"global"`. Events with no recoverable template are skipped —
/// suppression is per-template, so a chip dismiss without a template
/// hint can't be promoted to a suppression.
///
/// Idempotent — running it twice in a row yields the same map. Side
/// effect: the on-disk file is NOT touched here. Callers (the daemon
/// heartbeat hook) write the result with [`write_suppression_db`].
pub async fn recompute_from_telemetry(
    memory_root: &Path,
) -> Result<HashMap<String, SuppressionEntry>, AppError> {
    let now = Utc::now();
    let window_hours = (RECOMPUTE_WINDOW_DAYS * 24) as u32;
    let events = telemetry::read_events_window(memory_root, window_hours).await?;

    // Carry forward any existing entries that promoted into the
    // suppressed state — once `suppressed_until` is set, we stay
    // suppressed for 30d even if the dismiss events that caused the
    // promotion later age out of the recompute window. Without this,
    // a user who dismissed 3× on day 0 would see the suppression lapse
    // on day 30 even though the bus's gate hadn't fired yet.
    let prior_db = read_suppression_db(memory_root).await?;

    let mut db: HashMap<String, SuppressionEntry> = HashMap::new();

    for ev in events {
        // Only consider `dismiss_*` events. A dismiss without a `template`
        // payload field can't promote a per-template suppression.
        if !ev.event.starts_with("dismiss_") {
            continue;
        }
        let template = match payload_string(&ev, "template") {
            Some(t) if !t.is_empty() => t,
            _ => continue,
        };
        let scope = derive_scope(&ev);
        let key = make_key(&template, &scope);

        // Parse this event's timestamp; skip on parse error so a single
        // malformed line never corrupts the map.
        let ts = match DateTime::parse_from_rfc3339(&ev.ts) {
            Ok(t) => t.with_timezone(&Utc),
            Err(_) => continue,
        };

        let entry = db.entry(key.clone()).or_insert_with(|| SuppressionEntry {
            key: key.clone(),
            template: template.clone(),
            scope: scope.clone(),
            dismiss_count: 0,
            last_dismiss_at: ts,
            suppressed_until: None,
        });
        entry.dismiss_count = entry.dismiss_count.saturating_add(1);
        if ts > entry.last_dismiss_at {
            entry.last_dismiss_at = ts;
        }
    }

    // Promotion pass — anything ≥ threshold in this recompute pass
    // gets `suppressed_until` set. We base the window on the last
    // dismiss timestamp so a suppression that just promoted on the
    // 3rd dismiss runs for a full 30d from that dismiss, NOT from
    // recompute time. (Recomputes are roughly per-heartbeat — without
    // this, a user who dismissed 3× yesterday would see a window that
    // shrinks each time the daemon ticks.)
    for entry in db.values_mut() {
        if entry.dismiss_count >= SUPPRESSION_THRESHOLD {
            // Honour any prior suppression timestamp that's still in
            // the future — re-promotion shouldn't extend the window.
            // (If a prior `suppressed_until` is in the past, treat it
            // as expired and re-promote from the latest dismiss.)
            let computed = entry.last_dismiss_at + Duration::days(SUPPRESSION_DAYS);
            entry.suppressed_until = match prior_db.get(&entry.key) {
                Some(prior) => match prior.suppressed_until {
                    Some(prior_until) if prior_until > now => Some(prior_until),
                    _ => Some(computed),
                },
                None => Some(computed),
            };
        }
    }

    // Carry-forward pass — any prior entry whose suppression hasn't
    // expired must survive recomputes even if the 3 dismiss events
    // have aged out of the window. This is the bug-prevention case
    // documented above. Skip if the new pass already has the key
    // (the new pass owns the count for the active window).
    for (key, prior) in prior_db {
        if let Some(until) = prior.suppressed_until {
            if until > now && !db.contains_key(&key) {
                db.insert(key, prior);
            }
        }
    }

    Ok(db)
}

/// True when `{template, scope}` is currently suppressed at `now`. Reads
/// purely from the in-memory map — caller is responsible for keeping
/// the map fresh (the daemon does this each heartbeat).
pub fn is_suppressed(
    db: &HashMap<String, SuppressionEntry>,
    template: &str,
    scope: &str,
    now: DateTime<Utc>,
) -> bool {
    let key = make_key(template, scope);
    match db.get(&key) {
        Some(entry) => match entry.suppressed_until {
            Some(until) => now < until,
            None => false,
        },
        None => false,
    }
}

/// Pull a string field from a telemetry event's payload. Returns `None`
/// when the field is missing or not a string. Defensive — the writer
/// is fire-and-forget so a malformed payload should never panic the
/// reader.
fn payload_string(ev: &TelemetryEvent, key: &str) -> Option<String> {
    ev.payload
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Resolve scope from a telemetry event payload using the standard
/// chain: `atom_path` → `surface_id` → `"global"`. Empty strings are
/// treated as missing so a payload that explicitly carries
/// `atom_path: ""` falls through to the next link.
fn derive_scope(ev: &TelemetryEvent) -> String {
    if let Some(atom) = payload_string(ev, "atom_path") {
        if !atom.is_empty() {
            return atom;
        }
    }
    if let Some(surface) = payload_string(ev, "surface_id") {
        if !surface.is_empty() {
            return surface;
        }
    }
    "global".to_string()
}

/// Wipe the suppression file. Backs the "Clear suppression list" button
/// in the AGI Settings tab — gives the user an escape hatch when they
/// want to re-enable a template they previously dismissed too often.
pub async fn clear_suppression(memory_root: &Path) -> Result<(), AppError> {
    let path = db_path(memory_root);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::internal("clear_suppression", e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agi::telemetry::append_event;
    use std::path::PathBuf;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_suppression_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn dismiss_event(template: &str, atom_path: &str, ts: DateTime<Utc>) -> TelemetryEvent {
        TelemetryEvent {
            event: "dismiss_chip".to_string(),
            ts: ts.to_rfc3339(),
            user: "daizhe".to_string(),
            payload: serde_json::json!({
                "surface_id": "input-1",
                "template": template,
                "atom_path": atom_path,
            }),
        }
    }

    /// Write directly into the dated jsonl file. The telemetry writer
    /// only ever appends to today's file, so for older entries we hand-
    /// place a record the same way the rotation reader expects.
    fn write_dated_event(root: &Path, ev: &TelemetryEvent) {
        let parsed: DateTime<Utc> = DateTime::parse_from_rfc3339(&ev.ts)
            .unwrap()
            .with_timezone(&Utc);
        let dir = root.join(".tangerine").join("telemetry");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{}.jsonl", parsed.format("%Y-%m-%d")));
        let line = serde_json::to_string(ev).unwrap();
        let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
        existing.push_str(&line);
        existing.push('\n');
        std::fs::write(&path, existing).unwrap();
    }

    #[tokio::test]
    async fn test_suppression_promotes_to_30d_after_3_dismisses() {
        let root = tmp_root();
        let now = Utc::now();
        for i in 0..3 {
            let ts = now - Duration::minutes(10 * i);
            let ev = dismiss_event("deadline_approaching", "decisions/x.md", ts);
            append_event(&root, ev).await.unwrap();
        }

        let db = recompute_from_telemetry(&root).await.unwrap();
        let key = make_key("deadline_approaching", "decisions/x.md");
        let entry = db.get(&key).expect("entry must exist after 3 dismisses");
        assert_eq!(entry.dismiss_count, 3);
        assert!(entry.suppressed_until.is_some(), "suppressed_until set");
        let until = entry.suppressed_until.unwrap();
        // The window should be ~30 days out from the latest dismiss; a
        // small tolerance covers the elapsed-time-during-test gap.
        let approx = entry.last_dismiss_at + Duration::days(SUPPRESSION_DAYS);
        let diff = (until - approx).num_seconds().abs();
        assert!(diff < 5, "until ≈ last_dismiss + 30d, diff={}s", diff);

        assert!(is_suppressed(&db, "deadline_approaching", "decisions/x.md", now));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_suppression_per_scope_independent() {
        // Dismiss A×3 must not suppress B.
        let root = tmp_root();
        let now = Utc::now();
        for i in 0..3 {
            let ts = now - Duration::minutes(5 * i);
            append_event(
                &root,
                dismiss_event("deadline_approaching", "decisions/A.md", ts),
            )
            .await
            .unwrap();
        }
        // One dismiss for B — far below threshold.
        append_event(
            &root,
            dismiss_event("deadline_approaching", "decisions/B.md", now),
        )
        .await
        .unwrap();

        let db = recompute_from_telemetry(&root).await.unwrap();
        assert!(is_suppressed(
            &db,
            "deadline_approaching",
            "decisions/A.md",
            now
        ));
        assert!(!is_suppressed(
            &db,
            "deadline_approaching",
            "decisions/B.md",
            now
        ));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_suppression_expires_after_30d() {
        // Dismiss 3× exactly 30 days + 1h ago. Recompute now: the
        // dismiss events are still within the 30d window (their
        // timestamps are ≥30d old), so the count gets re-tallied —
        // but the 3rd dismiss promoted to suppressed at that earlier
        // time, and the `suppressed_until` is `last_dismiss + 30d`
        // which by definition has now passed. We verify
        // `is_suppressed` correctly reports `false` when `now > until`.
        let root = tmp_root();
        let now = Utc::now();
        // Forge a prior db with an explicitly-expired suppression.
        let key = make_key("deadline_approaching", "decisions/x.md");
        let mut prior = HashMap::new();
        prior.insert(
            key.clone(),
            SuppressionEntry {
                key: key.clone(),
                template: "deadline_approaching".to_string(),
                scope: "decisions/x.md".to_string(),
                dismiss_count: 3,
                last_dismiss_at: now - Duration::days(31),
                suppressed_until: Some(now - Duration::hours(1)),
            },
        );
        write_suppression_db(&root, &prior).await.unwrap();

        let db = read_suppression_db(&root).await.unwrap();
        assert!(!is_suppressed(
            &db,
            "deadline_approaching",
            "decisions/x.md",
            now
        ));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_recompute_idempotent() {
        let root = tmp_root();
        let now = Utc::now();
        for i in 0..4 {
            // 4 dismisses — past threshold but stable shape.
            append_event(
                &root,
                dismiss_event("pattern_recurrence", "decisions/q.md", now - Duration::minutes(2 * i)),
            )
            .await
            .unwrap();
        }
        let first = recompute_from_telemetry(&root).await.unwrap();
        write_suppression_db(&root, &first).await.unwrap();
        let second = recompute_from_telemetry(&root).await.unwrap();
        // The two maps must agree key-by-key. We compare via the
        // PartialEq impl (the carry-forward branch can pick a slightly
        // different `suppressed_until` if `now` advanced between calls —
        // we sidestep that by asserting on count + key + template +
        // scope which are deterministic).
        assert_eq!(first.len(), second.len());
        for (k, e1) in &first {
            let e2 = second.get(k).expect("same key");
            assert_eq!(e1.dismiss_count, e2.dismiss_count);
            assert_eq!(e1.template, e2.template);
            assert_eq!(e1.scope, e2.scope);
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_is_suppressed_with_no_data() {
        let root = tmp_root();
        let now = Utc::now();
        let db = read_suppression_db(&root).await.unwrap();
        assert!(db.is_empty(), "fresh root → empty db");
        assert!(!is_suppressed(&db, "deadline_approaching", "decisions/x.md", now));
        assert!(!is_suppressed(&db, "anything", "global", now));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_only_dismiss_events_count() {
        // accept_suggestion / suggestion_pushed events must be ignored.
        let root = tmp_root();
        let now = Utc::now();
        for _ in 0..5 {
            append_event(
                &root,
                TelemetryEvent {
                    event: "accept_suggestion".to_string(),
                    ts: now.to_rfc3339(),
                    user: "daizhe".to_string(),
                    payload: serde_json::json!({
                        "template": "deadline_approaching",
                        "atom_path": "decisions/x.md",
                    }),
                },
            )
            .await
            .unwrap();
        }
        let db = recompute_from_telemetry(&root).await.unwrap();
        assert!(db.is_empty(), "non-dismiss events must not seed suppression");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_dismiss_without_template_skipped() {
        // A dismiss with no `template` payload field can't be promoted
        // — suppression is per-template.
        let root = tmp_root();
        let now = Utc::now();
        for _ in 0..3 {
            append_event(
                &root,
                TelemetryEvent {
                    event: "dismiss_chip".to_string(),
                    ts: now.to_rfc3339(),
                    user: "daizhe".to_string(),
                    payload: serde_json::json!({
                        "surface_id": "input-1",
                    }),
                },
            )
            .await
            .unwrap();
        }
        let db = recompute_from_telemetry(&root).await.unwrap();
        assert!(db.is_empty(), "dismisses without template must skip");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_scope_falls_back_through_chain() {
        // Three dismisses with no atom_path but a surface_id — scope =
        // surface_id; promotion happens for that key.
        let root = tmp_root();
        let now = Utc::now();
        for i in 0..3 {
            let ts = now - Duration::minutes(i);
            append_event(
                &root,
                TelemetryEvent {
                    event: "dismiss_banner".to_string(),
                    ts: ts.to_rfc3339(),
                    user: "daizhe".to_string(),
                    payload: serde_json::json!({
                        "surface_id": "banner-foo",
                        "template": "decision_drift",
                    }),
                },
            )
            .await
            .unwrap();
        }
        let db = recompute_from_telemetry(&root).await.unwrap();
        let key = make_key("decision_drift", "banner-foo");
        assert!(db.contains_key(&key), "scope falls back to surface_id");
        assert!(is_suppressed(&db, "decision_drift", "banner-foo", now));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_atomic_write_replaces_existing() {
        let root = tmp_root();
        let key = make_key("t", "s");
        let mut db1 = HashMap::new();
        db1.insert(
            key.clone(),
            SuppressionEntry {
                key: key.clone(),
                template: "t".to_string(),
                scope: "s".to_string(),
                dismiss_count: 1,
                last_dismiss_at: Utc::now(),
                suppressed_until: None,
            },
        );
        write_suppression_db(&root, &db1).await.unwrap();

        let mut db2 = HashMap::new();
        db2.insert(
            key.clone(),
            SuppressionEntry {
                key: key.clone(),
                template: "t".to_string(),
                scope: "s".to_string(),
                dismiss_count: 7,
                last_dismiss_at: Utc::now(),
                suppressed_until: None,
            },
        );
        write_suppression_db(&root, &db2).await.unwrap();

        let read = read_suppression_db(&root).await.unwrap();
        assert_eq!(read.get(&key).unwrap().dismiss_count, 7);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_clear_suppression_removes_file() {
        let root = tmp_root();
        let key = make_key("t", "s");
        let mut db = HashMap::new();
        db.insert(
            key.clone(),
            SuppressionEntry {
                key,
                template: "t".to_string(),
                scope: "s".to_string(),
                dismiss_count: 5,
                last_dismiss_at: Utc::now(),
                suppressed_until: Some(Utc::now() + Duration::days(30)),
            },
        );
        write_suppression_db(&root, &db).await.unwrap();
        assert!(db_path(&root).is_file());

        clear_suppression(&root).await.unwrap();
        assert!(!db_path(&root).is_file());

        // Idempotent — clearing twice doesn't error.
        clear_suppression(&root).await.unwrap();

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_carry_forward_preserves_active_suppression() {
        // Forge a prior db where a suppression was promoted but the
        // dismiss events are now outside the 30d recompute window.
        // Recompute must keep the entry alive so the 30d window
        // doesn't lapse early.
        let root = tmp_root();
        let now = Utc::now();
        let key = make_key("deadline_approaching", "decisions/old.md");
        let until = now + Duration::days(15); // 15d remaining
        let mut prior = HashMap::new();
        prior.insert(
            key.clone(),
            SuppressionEntry {
                key: key.clone(),
                template: "deadline_approaching".to_string(),
                scope: "decisions/old.md".to_string(),
                dismiss_count: 3,
                last_dismiss_at: now - Duration::days(15),
                suppressed_until: Some(until),
            },
        );
        write_suppression_db(&root, &prior).await.unwrap();

        // No fresh telemetry — the recompute should carry forward the
        // active suppression untouched.
        let db = recompute_from_telemetry(&root).await.unwrap();
        let entry = db.get(&key).expect("active suppression carried forward");
        assert_eq!(entry.suppressed_until, Some(until));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_re_promotion_does_not_extend_window() {
        // Pre-existing suppressed_until > now must NOT be replaced by a
        // recompute that finds the same template + scope still
        // breaching threshold.
        let root = tmp_root();
        let now = Utc::now();
        let key = make_key("deadline_approaching", "decisions/x.md");
        let prior_until = now + Duration::days(20);
        let mut prior = HashMap::new();
        prior.insert(
            key.clone(),
            SuppressionEntry {
                key: key.clone(),
                template: "deadline_approaching".to_string(),
                scope: "decisions/x.md".to_string(),
                dismiss_count: 3,
                last_dismiss_at: now - Duration::days(10),
                suppressed_until: Some(prior_until),
            },
        );
        write_suppression_db(&root, &prior).await.unwrap();

        // Fresh dismisses today — they would push `last_dismiss + 30d`
        // farther out, but the existing window must be preserved.
        for i in 0..3 {
            append_event(
                &root,
                dismiss_event(
                    "deadline_approaching",
                    "decisions/x.md",
                    now - Duration::minutes(i),
                ),
            )
            .await
            .unwrap();
        }
        let db = recompute_from_telemetry(&root).await.unwrap();
        let entry = db.get(&key).unwrap();
        assert_eq!(entry.suppressed_until, Some(prior_until));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_make_key_format_is_template_colon_scope() {
        assert_eq!(make_key("t", "s"), "t:s");
        assert_eq!(make_key("deadline", "decisions/foo.md"), "deadline:decisions/foo.md");
    }

    #[tokio::test]
    async fn test_dated_telemetry_walk_picks_up_old_dismisses() {
        // Fold a dated jsonl entry from yesterday — the recompute walks
        // the prior days as expected.
        let root = tmp_root();
        let yesterday = Utc::now() - Duration::days(1);
        for _ in 0..3 {
            let ev = dismiss_event("conflict_detection", "decisions/x.md", yesterday);
            write_dated_event(&root, &ev);
        }
        let db = recompute_from_telemetry(&root).await.unwrap();
        let key = make_key("conflict_detection", "decisions/x.md");
        let entry = db.get(&key).unwrap();
        assert_eq!(entry.dismiss_count, 3);
        assert!(entry.suppressed_until.is_some());

        let _ = std::fs::remove_dir_all(&root);
    }
}
