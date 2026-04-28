// === wave 16 ===
//! Wave 16 — activity event bus.
//!
//! Every successful atom write (co-thinker brain refresh, personal-agent
//! parser, source ingestion, …) calls [`record_atom_written`] which:
//!   1. Pushes the event onto the in-memory ring buffer (cap = 50).
//!   2. Optionally appends one JSONL line to
//!      `<memory_dir>/.tangerine/activity.jsonl` (rotated at 1000 lines).
//!   3. Best-effort emits `activity:atom_written` over the supplied
//!      `tauri::AppHandle` so the React `<ActivityFeed/>` listener
//!      prepends without polling.
//!
//! Defensive policy: every IO + emit failure is silently logged at WARN
//! and dropped — recording activity must NEVER block or fail an atom
//! write. Callers therefore pass `&AppHandle` (cheap clone) and ignore
//! the unit return.
//!
//! The ring buffer lives behind a global `Lazy<Mutex<…>>` so it survives
//! across short-lived Tauri command instances + the daemon's heartbeat
//! engine. `activity_recent` reads from the same buffer.
//!
//! Frontend contract:
//!   - Event name        : `"activity:atom_written"`
//!   - Payload type      : `ActivityAtomEvent` (serde-snake-case)
//!   - Tauri command     : `activity_recent { limit?: usize }`
//!     → `Vec<ActivityAtomEvent>` newest first

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

/// Cap on the in-memory ring buffer. Anything older than 50 events is
/// dropped on push. Frontend defaults to 20 anyway; 50 leaves headroom
/// for a future "expand history" affordance.
pub const RING_BUFFER_CAP: usize = 50;

/// Cap on the on-disk `.tangerine/activity.jsonl` file. When the line
/// count crosses this we truncate to the most recent half (1000 → 500)
/// so the rotation cost is paid once per ~500 events.
pub const PERSIST_LINE_CAP: usize = 1000;

/// Atom kind enum. Any atom write has to declare what it is so the
/// frontend can colour-code the activity row + filter by surface.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AtomKind {
    /// A team decision atom — `team/decisions/<slug>.md`.
    Decision,
    /// A capture thread — `personal/<user>/threads/<vendor>/<id>.md`.
    Thread,
    /// Co-thinker brain refresh — `team/co-thinker.md`.
    BrainUpdate,
    /// Daily timeline rollup — `team/timeline/<date>.md`.
    Timeline,
    /// Co-thinker observation log entry — `agi/observations/<date>.md`.
    Observation,
}

/// Payload emitted on every `activity:atom_written` event AND returned
/// from `activity_recent`. `serde(rename_all="camelCase")` is intentional
/// so the React listener can destructure with the same idioms it uses
/// for every other Tauri payload (TemplateMatchPayload, etc.).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityAtomEvent {
    /// Repo-relative path with forward slashes (e.g.
    /// `team/co-thinker.md`, `personal/me/threads/cursor/abc.md`).
    pub path: String,
    /// Best-effort title (frontmatter `title:` / `topic:` / first H1 / fallback).
    pub title: String,
    /// AI tool / source label when known (e.g. `cursor`, `claude-code`).
    /// `None` for team / brain writes that are vendor-agnostic.
    pub vendor: Option<String>,
    /// Author handle when known (e.g. discord/github login).
    /// `None` for AGI-driven writes (`brain_update` / `observation`).
    pub author: Option<String>,
    /// RFC 3339 UTC ISO timestamp stamped at emission.
    pub timestamp: String,
    /// Atom kind enum — see [`AtomKind`].
    pub kind: AtomKind,
    // === v1.15.0 Wave 1.4 ===
    /// True when this atom was sourced from a Wave 13 demo seed (its
    /// markdown frontmatter carries `sample: true`). The frontend's
    /// `first_real_atom_captured` activation listener filters on this
    /// so a fresh install pre-populated with the bundled demo memory
    /// never trips the activation event.
    ///
    /// Defaulted to `false` and `serde(default)` so a v1.14-and-earlier
    /// persisted activity ledger entry deserialises cleanly. Real
    /// emitters that know the source is a sample (e.g. demo seed
    /// re-emit, future replay) flip this; the personal-agent / source-
    /// connector / co-thinker paths that produce real captures leave
    /// it `false`.
    #[serde(default)]
    pub is_sample: bool,
    // === end v1.15.0 Wave 1.4 ===
}

impl ActivityAtomEvent {
    /// Build a new event with `timestamp` filled to "now (UTC)".
    /// `is_sample` defaults to `false`; flip with [`with_sample`] when
    /// the caller knows the underlying file carries `sample: true` in
    /// its YAML frontmatter (Wave 13 demo seeds).
    pub fn new(
        path: impl Into<String>,
        title: impl Into<String>,
        kind: AtomKind,
    ) -> Self {
        Self {
            path: path.into(),
            title: title.into(),
            vendor: None,
            author: None,
            timestamp: Utc::now().to_rfc3339(),
            kind,
            // === v1.15.0 Wave 1.4 ===
            is_sample: false,
            // === end v1.15.0 Wave 1.4 ===
        }
    }

    /// Builder — set `vendor`.
    pub fn with_vendor(mut self, v: impl Into<String>) -> Self {
        self.vendor = Some(v.into());
        self
    }

    /// Builder — set `author`.
    pub fn with_author(mut self, a: impl Into<String>) -> Self {
        self.author = Some(a.into());
        self
    }

    // === v1.15.0 Wave 1.4 ===
    /// Builder — flip `is_sample`. Used by future replay / demo paths
    /// that re-emit a seeded fixture so the React activation listener
    /// can drop the event from the `first_real_atom_captured` count.
    pub fn with_sample(mut self, is_sample: bool) -> Self {
        self.is_sample = is_sample;
        self
    }
    // === end v1.15.0 Wave 1.4 ===
}

/// Process-wide ring buffer. `Mutex` (not `parking_lot`) keeps the dep
/// surface trivial — the lock is held for nanoseconds.
static RING: Lazy<Mutex<Vec<ActivityAtomEvent>>> =
    Lazy::new(|| Mutex::new(Vec::with_capacity(RING_BUFFER_CAP)));

/// Push one event onto the in-memory ring + best-effort persist + best-
/// effort emit. ALL failures are swallowed (logged at warn).
///
/// `app` carries the Tauri runtime handle so we can fire the event;
/// when called from a code path that has no `AppHandle` (e.g. a
/// pure-Rust unit test) the caller can use [`record_atom_written_no_emit`].
pub fn record_atom_written<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    memory_dir: &Path,
    event: ActivityAtomEvent,
) {
    push_to_ring(event.clone());
    if let Err(e) = persist_line(memory_dir, &event) {
        tracing::warn!(error=?e, "wave16 activity persist failed");
    }
    use tauri::Emitter;
    if let Err(e) = app.emit("activity:atom_written", &event) {
        // `Emitter::emit` returns `tauri::Error`, never a panic. Swallow
        // — the heartbeat / parser / ingest CANNOT block on the webview.
        tracing::warn!(error=?e, "wave16 activity emit failed");
    }
}

/// Same as [`record_atom_written`] but skips the Tauri emit. Used by:
///   - Background ticks where the AppHandle isn't easily reachable.
///   - Unit tests that exercise the ring + persistence without a Tauri
///     runtime in scope.
pub fn record_atom_written_no_emit(memory_dir: &Path, event: ActivityAtomEvent) {
    push_to_ring(event.clone());
    if let Err(e) = persist_line(memory_dir, &event) {
        tracing::warn!(error=?e, "wave16 activity persist failed (no-emit)");
    }
}

// ---------------------------------------------------------------------------
// Sink abstraction
//
// Mirrors `agi::templates::common::EventSink`: a trait the engine + parsers
// hold so daemon-driven paths can drop a no-op while Tauri-command paths
// install a real `TauriActivitySink<R>` that fires the
// `activity:atom_written` event in addition to the ring + persist.
//
// Defensive: `record` MUST NOT panic / propagate errors. The contract is
// "best effort observability"; an emit / IO failure is a tracing warn,
// never a heartbeat / parse failure.

/// Fire-and-forget sink for activity events. Production = `TauriActivitySink`;
/// daemon ticks = `RingOnlyActivitySink`; tests = the in-memory snapshot path
/// straight off `crate::activity::snapshot`.
pub trait ActivitySink: Send + Sync {
    fn record(&self, memory_dir: &Path, event: ActivityAtomEvent);
}

/// No-op sink — drops every event. Used when neither emit nor persistence
/// matters (test scaffolds that explicitly want a quiet engine).
pub struct NoopActivitySink;

impl ActivitySink for NoopActivitySink {
    fn record(&self, _memory_dir: &Path, _event: ActivityAtomEvent) {}
}

/// Daemon-friendly sink — pushes to the ring + appends to the on-disk
/// `.tangerine/activity.jsonl`, but doesn't emit (no AppHandle handy).
/// The eventual Tauri-command-driven heartbeat path replaces this with
/// `TauriActivitySink` so the live event surfaces.
pub struct RingOnlyActivitySink;

impl ActivitySink for RingOnlyActivitySink {
    fn record(&self, memory_dir: &Path, event: ActivityAtomEvent) {
        record_atom_written_no_emit(memory_dir, event);
    }
}

/// Production sink — wraps a `tauri::AppHandle<R>` and forwards every
/// event to ring + persist + Tauri emit. Generic over `R: tauri::Runtime`
/// so non-Tauri callers (cargo unit tests) compile without the runtime
/// in scope; production hits the default `Wry`.
pub struct TauriActivitySink<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriActivitySink<R> {
    pub fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: tauri::Runtime> ActivitySink for TauriActivitySink<R> {
    fn record(&self, memory_dir: &Path, event: ActivityAtomEvent) {
        record_atom_written(&self.app, memory_dir, event);
    }
}

/// Public ring-push helper — pushes a single event onto the in-memory
/// ring buffer WITHOUT persistence + WITHOUT emit. Use from atom-write
/// sites where no `AppHandle` / `memory_dir` is in scope (e.g. inside
/// the personal-agent file parsers); the eventual Tauri-command-driven
/// path that wraps the parser is expected to follow up with either an
/// explicit emit or a re-read via `activity_recent`.
pub fn push_event_to_ring(event: ActivityAtomEvent) {
    push_to_ring(event);
}

fn push_to_ring(event: ActivityAtomEvent) {
    let mut g = match RING.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(), // poisoned — recover; activity must not panic
    };
    if g.len() >= RING_BUFFER_CAP {
        // Drop the oldest. We keep newest-at-the-end so the read path
        // can `.iter().rev()` cheaply.
        g.remove(0);
    }
    g.push(event);
}

/// Drain the ring into a snapshot. Returns at most `limit` events,
/// newest first. `limit = None` returns all (capped at `RING_BUFFER_CAP`).
pub fn snapshot(limit: Option<usize>) -> Vec<ActivityAtomEvent> {
    let g = match RING.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let cap = limit.unwrap_or(RING_BUFFER_CAP).min(RING_BUFFER_CAP);
    g.iter().rev().take(cap).cloned().collect()
}

/// Test helper — wipe the ring buffer between unit tests so they don't
/// leak state across each other.
#[cfg(test)]
pub fn _clear_ring_for_tests() {
    let mut g = match RING.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    g.clear();
}

/// Path of the on-disk JSONL ledger (lives beside the existing
/// `.tangerine/` sidecar that telemetry / suppression already use).
pub fn activity_log_path(memory_dir: &Path) -> PathBuf {
    memory_dir.join(".tangerine").join("activity.jsonl")
}

/// Append one event as a single JSON line to the on-disk ledger,
/// rotating when the line count crosses [`PERSIST_LINE_CAP`].
fn persist_line(memory_dir: &Path, event: &ActivityAtomEvent) -> std::io::Result<()> {
    let path = activity_log_path(memory_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let line = serde_json::to_string(event).unwrap_or_default();

    // Rotate first — cheaper than writing then trimming. Rotation reads
    // the file, drops the oldest half, and rewrites; we eat that cost
    // ~once per 500 atom writes.
    rotate_if_needed(&path)?;

    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    writeln!(f, "{line}")?;
    Ok(())
}

fn rotate_if_needed(path: &Path) -> std::io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(path)?;
    let mut lines: Vec<&str> = raw.lines().collect();
    if lines.len() < PERSIST_LINE_CAP {
        return Ok(());
    }
    // Keep the most recent half so the steady-state file size stays
    // around `PERSIST_LINE_CAP / 2`.
    let keep = PERSIST_LINE_CAP / 2;
    let drop = lines.len().saturating_sub(keep);
    let _ = lines.drain(0..drop);
    let body = lines.join("\n") + "\n";
    std::fs::write(path, body)
}

#[cfg(test)]
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper that locks the global TEST_LOCK so ring-mutating tests
    /// across this file + `commands::activity::tests` serialize cleanly.
    /// The ring is a process-wide singleton — without serialization,
    /// parallel `cargo test` workers stomp each other's snapshots.
    fn _serialised_test<F: FnOnce()>(f: F) {
        let _g = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        _clear_ring_for_tests();
        f();
    }

    #[test]
    fn ring_returns_reverse_chronological() {
        _serialised_test(|| {
            push_to_ring(ActivityAtomEvent::new("a.md", "first", AtomKind::Decision));
            push_to_ring(ActivityAtomEvent::new("b.md", "second", AtomKind::Decision));
            push_to_ring(ActivityAtomEvent::new("c.md", "third", AtomKind::Decision));
            let snap = snapshot(None);
            assert_eq!(snap.len(), 3);
            // newest first
            assert_eq!(snap[0].title, "third");
            assert_eq!(snap[1].title, "second");
            assert_eq!(snap[2].title, "first");
        });
    }

    #[test]
    fn ring_caps_at_buffer_size() {
        _serialised_test(|| {
            for i in 0..(RING_BUFFER_CAP + 5) {
                push_to_ring(ActivityAtomEvent::new(
                    format!("{i}.md"),
                    format!("e{i}"),
                    AtomKind::Thread,
                ));
            }
            let snap = snapshot(None);
            assert_eq!(snap.len(), RING_BUFFER_CAP);
            // Oldest 5 should be dropped — newest event is e{cap+4}
            let expected_newest = format!("e{}", RING_BUFFER_CAP + 4);
            assert_eq!(snap[0].title, expected_newest);
        });
    }

    #[test]
    fn snapshot_respects_limit() {
        _serialised_test(|| {
            for i in 0..10 {
                push_to_ring(ActivityAtomEvent::new(
                    format!("{i}.md"),
                    format!("e{i}"),
                    AtomKind::Thread,
                ));
            }
            let snap = snapshot(Some(3));
            assert_eq!(snap.len(), 3);
            assert_eq!(snap[0].title, "e9");
            assert_eq!(snap[2].title, "e7");
        });
    }

    #[test]
    fn persistence_appends_and_rotates() {
        // Persistence is fs-only — doesn't touch the ring, so no need
        // for the TEST_LOCK serialization.
        let tmp = std::env::temp_dir().join(format!(
            "tii_w16_act_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&tmp).unwrap();

        for i in 0..(PERSIST_LINE_CAP + 5) {
            let ev = ActivityAtomEvent::new(
                format!("{i}.md"),
                format!("e{i}"),
                AtomKind::Decision,
            );
            persist_line(&tmp, &ev).unwrap();
        }

        let raw = std::fs::read_to_string(activity_log_path(&tmp)).unwrap();
        let count = raw.lines().filter(|l| !l.trim().is_empty()).count();
        // After rotation we keep PERSIST_LINE_CAP/2 + the 5 fresh appends
        // that landed after each rotation. Rotation triggers on *=cap*,
        // so worst-case the file stays bounded by PERSIST_LINE_CAP.
        assert!(
            count <= PERSIST_LINE_CAP,
            "expected ≤ {PERSIST_LINE_CAP} lines, got {count}"
        );
        assert!(count >= PERSIST_LINE_CAP / 2, "rotation kept too few lines");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn record_no_emit_pushes_ring_and_persists() {
        _serialised_test(|| {
            let tmp = std::env::temp_dir().join(format!(
                "tii_w16_rec_{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&tmp).unwrap();

            let ev = ActivityAtomEvent::new(
                "team/co-thinker.md",
                "Brain refresh",
                AtomKind::BrainUpdate,
            );
            record_atom_written_no_emit(&tmp, ev);

            let snap = snapshot(None);
            assert_eq!(snap.len(), 1);
            assert_eq!(snap[0].path, "team/co-thinker.md");
            assert_eq!(snap[0].kind, AtomKind::BrainUpdate);

            let raw = std::fs::read_to_string(activity_log_path(&tmp)).unwrap();
            assert!(raw.contains("\"team/co-thinker.md\""));
            assert!(raw.contains("\"brain_update\""));

            let _ = std::fs::remove_dir_all(&tmp);
        });
    }

    #[test]
    fn event_serialises_camel_case_for_frontend() {
        let ev = ActivityAtomEvent::new("a.md", "T", AtomKind::Decision)
            .with_vendor("cursor")
            .with_author("me");
        let s = serde_json::to_string(&ev).unwrap();
        // Field names must match the React payload contract.
        assert!(s.contains("\"path\""));
        assert!(s.contains("\"title\""));
        assert!(s.contains("\"vendor\""));
        assert!(s.contains("\"author\""));
        assert!(s.contains("\"timestamp\""));
        assert!(s.contains("\"kind\":\"decision\""));
        // === v1.15.0 Wave 1.4 ===
        // `is_sample` MUST always be present in the wire shape so the
        // React `first_real_atom_captured` listener can rely on the
        // field rather than a nullable check. New events default false.
        assert!(s.contains("\"isSample\""));
        assert!(s.contains("\"isSample\":false"));
        // === end v1.15.0 Wave 1.4 ===
    }

    // === v1.15.0 Wave 1.4 ===
    #[test]
    fn event_with_sample_serialises_true() {
        // A future demo-replay path can call `with_sample(true)` so the
        // event surfaces in the activity feed AND telemetry can drop it
        // from the activation funnel. Test the builder + serde shape.
        let ev = ActivityAtomEvent::new("decisions/sample.md", "Demo", AtomKind::Decision)
            .with_sample(true);
        assert!(ev.is_sample);
        let s = serde_json::to_string(&ev).unwrap();
        assert!(s.contains("\"isSample\":true"));
    }

    #[test]
    fn event_deserialises_legacy_payload_without_is_sample() {
        // A v1.14-and-earlier persisted activity.jsonl line will not
        // carry `isSample`. `serde(default)` MUST give us `false` so
        // the rotation read path doesn't blow up on legacy files.
        let legacy = r#"{"path":"a.md","title":"t","vendor":null,"author":null,"timestamp":"2026-04-28T00:00:00Z","kind":"decision"}"#;
        let ev: ActivityAtomEvent = serde_json::from_str(legacy).unwrap();
        assert_eq!(ev.path, "a.md");
        assert!(!ev.is_sample, "legacy entry must default to is_sample=false");
    }
    // === end v1.15.0 Wave 1.4 ===
}
// === end wave 16 ===
