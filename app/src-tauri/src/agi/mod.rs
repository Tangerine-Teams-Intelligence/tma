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
