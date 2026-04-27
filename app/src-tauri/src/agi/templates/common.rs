//! v1.9.0-beta.2 P2-A — Shared types + traits for rule-based suggestion templates.
//!
//! Each template (deadline / pattern_recurrence / conflict / decision_drift /
//! long_thread / catchup_hint / newcomer_onboarding) implements the
//! [`Template`] trait. The co-thinker heartbeat collects every match into a
//! single `Vec<TemplateMatch>` and emits each via the [`EventSink`] so the
//! frontend's `template_match` listener can call `pushSuggestion(...)`.
//!
//! Both `Template` and `EventSink` use `BoxFuture` instead of `async fn` so
//! the traits are dyn-compatible (the same constraint we already satisfy in
//! `agi::co_thinker::LlmDispatcher`). This lets us swap in a mock event sink
//! during unit tests without dragging in a Tauri runtime.
//!
//! Telemetry: `pattern_recurrence` is the only template that needs a
//! 7-day telemetry window — it reads via `crate::agi::telemetry::read_events_window`.
//! `deadline` and `conflict` walk the memory tree directly.
//!
//! Tier mapping (per SUGGESTION_ENGINE_SPEC.md §3.5 and the bus's
//! `selectTier`):
//!   * `is_irreversible: true`        → modal
//!   * `is_completion_signal: true`   → toast
//!   * `is_cross_route: true`         → banner (when confidence ≥ 0.8)
//!   * `surface_id: Some(_)`          → chip
//!   * otherwise                      → toast
//!
//! Sibling P2-B (`decision_drift` / `long_thread` / `catchup_hint`) and P2-C
//! (`newcomer_onboarding`) will reuse this module verbatim — keep the shape
//! stable.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};

use crate::agi::telemetry::TelemetryEvent;

/// One template match. The frontend's `template_match` listener wraps this
/// in a `SuggestionRequest` and forwards it to `pushSuggestion(...)`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TemplateMatch {
    /// v1.9.0 P4-A — UUID v4 stamped at emission time so the LLM-enrichment
    /// path (Stage 2) can update the same suggestion in place via
    /// `template_match_enriched`. The dispatcher (`registry::evaluate_and_emit`)
    /// fills this in when the field is empty so existing templates don't have
    /// to set it themselves. Stable across the rule emit → enrich emit pair.
    ///
    /// Backward-compat: `#[serde(default)]` lets old payloads (no `match_id`
    /// field) deserialise cleanly — the dispatcher fills the value before
    /// any sink sees it.
    #[serde(default)]
    pub match_id: String,
    /// Template id (e.g. `"deadline_approaching"`). Used by the frontend bus
    /// for telemetry payloads + dedup keys.
    pub template: String,
    /// Markdown body shown in the chip / banner / toast / modal.
    pub body: String,
    /// 0..1 confidence. The bus enforces `MIN_CONFIDENCE` (0.7) on top of
    /// the user-tunable `agiConfidenceThreshold`; templates emit raw.
    pub confidence: f32,
    /// Atom paths the template cited (for grounding + dedup). Always
    /// repo-relative with forward slashes, matching the convention used by
    /// `co_thinker::AtomSummary::rel_path`.
    pub atom_refs: Vec<String>,
    /// For chip-tier templates: anchor surface id. `None` for non-chip.
    pub surface_id: Option<String>,
    /// 0..10 — used to break ties when the bus's banner queue contests a
    /// slot. Defaults to 5 in the bus when omitted.
    pub priority: u8,
    /// Promotes to `modal` tier in `selectTier`. Reserved for AGI proposals
    /// that would commit an irreversible side effect.
    #[serde(default)]
    pub is_irreversible: bool,
    /// Pins to `toast` tier — completion notices never escalate.
    #[serde(default)]
    pub is_completion_signal: bool,
    /// Promotes to `banner` tier when confidence ≥ 0.8 (per the bus floor
    /// `BANNER_CONFIDENCE_FLOOR`). Below the floor we fall back to a toast.
    #[serde(default)]
    pub is_cross_route: bool,
}

/// Shared inputs every template gets per heartbeat. Build once, pass by
/// reference. New templates added by P2-B / P2-C should add fields here
/// rather than re-walking the memory tree themselves.
pub struct TemplateContext<'a> {
    /// User's memory dir (e.g. `~/.tangerine-memory`). All path-walking
    /// templates resolve relative paths from here.
    pub memory_root: &'a Path,
    /// "Now" timestamp the templates compare against. Pass UTC.
    pub now: DateTime<Utc>,
    /// Last 7 days of telemetry. Loaded once by the heartbeat caller (NOT
    /// per-template) so a single template doesn't pay the IO cost on every
    /// invocation. Templates that don't need telemetry simply ignore it.
    pub recent_telemetry: Vec<TelemetryEvent>,
}

/// Trait every template implements. `BoxFuture` keeps the trait dyn-compatible
/// so the dispatcher can hold `Vec<Arc<dyn Template>>`.
pub trait Template: Send + Sync {
    /// Stable id (e.g. `"deadline_approaching"`). Returned by `evaluate`'s
    /// `TemplateMatch::template` so the frontend can route.
    fn name(&self) -> &'static str;

    /// Run the detector against `ctx` and return zero or more matches. An
    /// empty `Vec` is the steady-state path (most heartbeats produce no
    /// suggestions).
    fn evaluate<'a>(
        &'a self,
        ctx: &'a TemplateContext<'a>,
    ) -> BoxFuture<'a, Vec<TemplateMatch>>;
}

/// Abstraction over `tauri::AppHandle::emit("template_match", &m)`.
///
/// Production impl wraps a `tauri::AppHandle` (see [`TauriEventSink`]).
/// Tests use [`InMemorySink`] which appends to a `Vec` so we can assert on
/// what got emitted without spinning up a Tauri runtime.
pub trait EventSink: Send + Sync {
    /// Emit one template match. Production sinks may serialize and forward
    /// to the frontend; mock sinks just record. Failures are absorbed —
    /// dropping a single template-match must never break the heartbeat.
    fn emit_template_match(&self, m: &TemplateMatch);

    /// v1.9.0 P4-A — emit an *enriched* template match. Carries the same
    /// `match_id` as the original rule emit; the frontend listener replaces
    /// the existing suggestion's body in place via `updateSuggestion`.
    /// Default impl is a no-op so existing test sinks compile unchanged.
    fn emit_template_match_enriched(&self, _m: &TemplateMatch) {}
}

/// No-op sink — used by the daemon path until v1.9.0 final wires the
/// `AppHandle` through, and by tests that don't care about emit
/// observability.
pub struct NoopSink;

impl EventSink for NoopSink {
    fn emit_template_match(&self, _m: &TemplateMatch) {}
    fn emit_template_match_enriched(&self, _m: &TemplateMatch) {}
}

/// Production sink — wraps a `tauri::AppHandle` and forwards each match
/// to the frontend via `app.emit("template_match", m)`. The React layer's
/// `template_match` listener (in `AppShell.tsx`) calls `pushSuggestion`
/// with the deserialised payload.
///
/// Generic over `R: tauri::Runtime` so tests / non-Tauri callers can use
/// `NoopSink` without the runtime in scope. Production mainly hits the
/// default `Wry` runtime.
pub struct TauriEventSink<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriEventSink<R> {
    pub fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: tauri::Runtime> EventSink for TauriEventSink<R> {
    fn emit_template_match(&self, m: &TemplateMatch) {
        // `tauri::Emitter` is the trait that gives `app.emit(name, &payload)`
        // in Tauri 2.x. Failures are swallowed — a single failed emit
        // (e.g. webview not yet ready on cold start) must never break
        // the heartbeat.
        use tauri::Emitter;
        let _ = self.app.emit("template_match", m);
    }

    fn emit_template_match_enriched(&self, m: &TemplateMatch) {
        // v1.9.0 P4-A — same fire-and-forget path as the rule emit. The
        // frontend `template_match_enriched` listener calls
        // `updateSuggestion(match_id, body)` to swap the body in place.
        use tauri::Emitter;
        let _ = self.app.emit("template_match_enriched", m);
    }
}

/// Test sink that appends every emit into a shared `Vec`. Production code
/// MUST NOT depend on this — keep it test-only by gating callers in the
/// `with_event_sink(...)` constructor.
#[cfg(test)]
pub struct InMemorySink {
    pub matches: parking_lot::Mutex<Vec<TemplateMatch>>,
    /// v1.9.0 P4-A — enrichment emits land here so tests can assert on
    /// "the second event with the same match_id".
    pub enriched: parking_lot::Mutex<Vec<TemplateMatch>>,
}

#[cfg(test)]
impl InMemorySink {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            matches: parking_lot::Mutex::new(Vec::new()),
            enriched: parking_lot::Mutex::new(Vec::new()),
        })
    }
    pub fn snapshot(&self) -> Vec<TemplateMatch> {
        self.matches.lock().clone()
    }
    pub fn enriched_snapshot(&self) -> Vec<TemplateMatch> {
        self.enriched.lock().clone()
    }
}

#[cfg(test)]
impl EventSink for InMemorySink {
    fn emit_template_match(&self, m: &TemplateMatch) {
        self.matches.lock().push(m.clone());
    }
    fn emit_template_match_enriched(&self, m: &TemplateMatch) {
        self.enriched.lock().push(m.clone());
    }
}

/// Helper used by templates to read a markdown atom + parse its YAML
/// frontmatter into a HashMap of string keys → string values. Returns
/// `(frontmatter_map, body)` where `body` is everything after the closing
/// `---`. Missing or malformed frontmatter → empty map + raw body.
///
/// Kept in `common.rs` so all three templates share a single parser; v1.9
/// final or P3 may switch to `serde_yaml::from_str::<serde_yaml::Value>` if
/// nested frontmatter ever shows up. For now the primitive flat-key map is
/// enough for `due_at`, `topic`, `status`, `title` — which is everything
/// the rule templates need.
pub fn parse_frontmatter(raw: &str) -> (std::collections::HashMap<String, String>, String) {
    let mut fm = std::collections::HashMap::new();
    let mut body = String::new();
    let mut lines = raw.lines();

    let first = match lines.next() {
        Some(l) => l,
        None => return (fm, body),
    };
    if first.trim() != "---" {
        // No frontmatter; the whole content is body.
        body.push_str(first);
        body.push('\n');
        for l in lines {
            body.push_str(l);
            body.push('\n');
        }
        return (fm, body);
    }

    // Walk frontmatter until the closing `---`.
    let mut closed = false;
    for l in lines.by_ref() {
        if l.trim() == "---" {
            closed = true;
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            let key = k.trim().to_string();
            let value = v.trim().trim_matches('"').trim_matches('\'').to_string();
            if !key.is_empty() {
                fm.insert(key, value);
            }
        }
    }

    if !closed {
        // Malformed — treat the whole thing as body.
        return (std::collections::HashMap::new(), raw.to_string());
    }

    for l in lines {
        body.push_str(l);
        body.push('\n');
    }
    (fm, body)
}

/// Walk one directory under `memory_root` (e.g. `decisions/` or `projects/`)
/// and return every `.md` file's `(rel_path, raw_contents, mtime)`. Skips
/// hidden files and unreadable entries silently. Forward-slash paths.
pub fn walk_md_files(memory_root: &Path, subdir: &str) -> Vec<(String, String, DateTime<Utc>)> {
    let dir = memory_root.join(subdir);
    let mut out: Vec<(String, String, DateTime<Utc>)> = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path: PathBuf = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        if !name_str.ends_with(".md") {
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
        out.push((rel, raw, mtime));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Convenience holder used by the heartbeat to bundle every registered
/// template behind a single `Arc<dyn Template>` collection.
pub fn arc_template<T: Template + 'static>(t: T) -> Arc<dyn Template> {
    Arc::new(t)
}
