//! v1.8 Phase 3 — AGI co-thinker module.
//!
//! Tangerine doesn't host its own LLM. Instead, the co-thinker brain (sibling
//! agent P3-B at `co_thinker.rs` / `observations.rs`) dispatches LLM calls
//! through whatever AI tool the user already has open. This sub-module owns
//! the dispatch contract.
//!
//! Layout:
//!   * `session_borrower` — 3-channel dispatcher (MCP sampling, browser ext
//!     hidden conv, Ollama local fallback). The single entry point for all
//!     LLM calls in the app.
//!
//! P3-B adds `co_thinker.rs` (the persistent brain that consumes atoms each
//! heartbeat and writes the audit-able brain doc) and `observations.rs`
//! (per-day heartbeat audit log). P3-A owns `session_borrower.rs`.
//!
//! Merge-watch points:
//!   * `co_thinker::ProductionDispatcher` calls
//!     `dispatch_via_session_borrower()` which currently returns a
//!     "not_ready" error. When P3-A's `session_borrower::dispatch()` lands,
//!     replace that body with the real call (single function, no other
//!     touches needed). See the comment in `co_thinker.rs` near the marker
//!     `INTEGRATION POINT`.
//!   * The daemon hook (`crate::daemon::do_heartbeat`) calls
//!     `co_thinker_tick` at the bottom of every tick. P3-A's session-borrower
//!     hook (probably `commands/co_thinker_dispatch.rs`) is independent — the
//!     two surfaces don't conflict.
// P3-A owned: `session_borrower` is the 3-channel LLM dispatcher consumed
// by `co_thinker::ProductionDispatcher` at the `INTEGRATION POINT` marker
// in `co_thinker.rs` and by `commands::co_thinker_dispatch` for the React
// Test Query buttons.
pub mod session_borrower;
pub mod co_thinker;
pub mod observations;

// === Phase 4-B canvas surface ===
// Per-project ideation surface — markdown files at canvas/<project>/<topic>.md.
// Sibling P4-C wires AGI peer behaviors on top of the same files; this
// module is the inert filesystem layer (read / atomic write / list).
pub mod canvas;
// === end Phase 4-B canvas surface ===

// === Phase 4-A ambient ===
// v1.8 Phase 4-A — ambient input analyser. Thin wrapper around
// `session_borrower::dispatch` consumed by `commands::agi_ambient`. The
// React-side observer (`AmbientInputObserver`) hits this once per
// debounced edit on every textarea / contenteditable / palette input.
pub mod ambient;
// === end Phase 4-A ambient ===

// === Phase 4-C agi peer + propose lock ===
// v1.8 Phase 4-C — AGI participates on Canvas as a peer (proactive sticky
// throws + reactive comments via the heartbeat sentinel parser in
// `co_thinker.rs`) and lifts stickies into draft decision atoms via the
// propose-lock affordance.
//
// `propose_lock` builds canvas-{topic}-{stickyid}.md atoms under
// `~/.tangerine-memory/decisions/` from a sticky's body + comments.
// `canvas_writer` owns the AGI-side canvas writes (sticky-throw + comment),
// using P4-B's `agi::canvas::{load_topic, save_topic}` text-blob API.
pub mod canvas_writer;
pub mod propose_lock;
// === end Phase 4-C agi peer + propose lock ===

// === v1.9 P1-A telemetry ===
// v1.9.0-beta.1 — append-only JSONL log of every meaningful user action.
// Sibling P1-B (banner / modal / tier-engine) is independent; the suggestion
// engine in v1.9.0-beta.2 will consume the read API in this module to fire
// rule-based templates (Pattern recurrence, Stale RFC, etc.). This module
// is just the writer + reader; no pattern detection lives here.
pub mod telemetry;
// === end v1.9 P1-A telemetry ===

// === v1.9 P2-A/B/C suggestion templates ===
// v1.9.0-beta.2 — rule-based suggestion templates fire from the co-thinker
// heartbeat (`co_thinker.rs::heartbeat`). Each template implements
// `templates::common::Template` and runs against a single `TemplateContext`
// per heartbeat; matches are emitted via the `EventSink` trait and surface
// in the React frontend through the `template_match` Tauri event.
//
//   * P2-A: `deadline_approaching`, `pattern_recurrence`, `conflict_detection`.
//   * P2-B: `decision_drift`, `long_thread`, `catchup_hint`.
//   * P2-C: `newcomer_onboarding` + integration polish.
//
// The `templates::registry_p2a()` helper returns the P2-A registry today;
// once P2-C lands their `registry` submodule the heartbeat call site swaps
// to `templates::registry::evaluate_all` with no other touches needed.
pub mod templates;
// === end v1.9 P2 suggestion templates ===

// === v1.9 P3-A suppression ===
// v1.9.0-beta.3 — pattern-learned dismiss suppression (CEO discipline #3:
// dismiss × 3 → 30d silence). Sits BELOW the existing v1.8 24h dismiss
// memory (`store.ts::dismissedSurfaces`) — short-term + long-term layers
// are independent. This module is the inert filesystem layer (read /
// atomic write / recompute-from-telemetry); the daemon hook recomputes
// on every heartbeat, the bus's `pushSuggestion` consults it via the
// `suppression_check` Tauri command before dispatching.
pub mod suppression;
// === end v1.9 P3-A suppression ===

// === v2.5 review ===
// v2.5 §1 — PR-style decision review. Co-thinker proposes a decision atom;
// teammates vote; 2/3 quorum auto-promotes (atom status → `locked`). The
// Tauri surface lives in `crate::commands::review`; storage is a
// `*.review.json` sidecar next to each decision atom under
// `team/decisions/`. See `agi::review` module docs for the state machine.
pub mod review;
// === end v2.5 review ===
