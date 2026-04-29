//! v1.16 Wave 1 — AGI module surface (LLM layer removed).
//!
//! Tangerine no longer borrows the user's editor LLM. The co-thinker /
//! ambient / sampling-bridge stack is gone. What remains in this module
//! is the team-memory infrastructure that was never LLM-dependent:
//! canvas, presence, telemetry, suppression, review, mention extraction
//! (heuristic only, regex-based).
//!
//! Stub-kept (delete-pending W1A2 + W2 rework):
//!   * `session_borrower` — public types still imported by
//!     `commands/setup_wizard.rs`; every fn now returns
//!     `BorrowError::AllExhausted`.
//!   * `sampling_bridge` — public types still imported by `ws_server.rs`
//!     and `setup_wizard.rs`; `global().has(_)` is always `false`.

// Stub modules retained until W1A2 (setup_wizard) and W2 (ws_server) finish
// their rework — see the file-level docs in each for the v1.16 contract.
pub mod session_borrower;
pub mod sampling_bridge;

// === Phase 4-B canvas surface ===
// Per-project ideation surface — markdown files at canvas/<project>/<topic>.md.
// Inert filesystem layer (read / atomic write / list); the AGI peer
// behaviors the v1.8 design layered on top are gone in v1.16.
pub mod canvas;
// === end Phase 4-B canvas surface ===

// === Phase 4-C — kept ===
// `propose_lock` / `canvas_writer` are filesystem helpers consumed
// directly by `commands::canvas_agi`. They never depended on the LLM
// dispatcher and stay as inert .md writers.
pub mod canvas_writer;
pub mod propose_lock;
// === end Phase 4-C ===

// === v1.9 P1-A telemetry ===
// Append-only JSONL log of every meaningful user action. Read by
// suppression's recompute path. Fully local; not LLM-dependent.
pub mod telemetry;
// === end v1.9 P1-A telemetry ===

// === v1.9 P2 templates ===
// Rule-based suggestion templates (regex / frontmatter / count rules).
// `llm_enrich` was removed in v1.16; the rule-fire path stays.
pub mod templates;
// === end v1.9 P2 templates ===

// === v1.9 P3-A suppression ===
// dismiss × 3 → 30d silence. Inert filesystem layer; recomputed from
// telemetry on the daemon heartbeat.
pub mod suppression;
// === end v1.9 P3-A suppression ===

// === v2.5 review (sidecar) ===
// PR-style decision review with `*.review.json` sidecars under
// `team/decisions/`.
pub mod review;
// === end v2.5 review ===

// === wave 1.13-B (frontmatter review workflow) ===
pub mod review_workflow;
// === end wave 1.13-B ===

// === wave 1.13-D (presence) ===
// git-mediated team presence; per-user JSON dropfiles propagated via
// the existing memory-repo sync.
pub mod presence;
// === end wave 1.13-D ===

// === wave 1.13-C (mention extractor) ===
// Heuristic regex-based @mention extraction. The LLM-extraction pass
// was removed in v1.16; the heuristic + parse-helper layer stays so the
// inbox event flow continues to work.
pub mod mention_extractor;
// === end wave 1.13-C ===

// observations.rs was the per-day audit log written by the co-thinker
// heartbeat. With the heartbeat removed, the writer side is gone, but
// the read API is still consumed by `commands::co_thinker_status` (now
// removed) — file deleted.
//
// Kept-public note: if a future caller wants per-day audit logs back,
// re-implement here as an inert append-only writer; do NOT reintroduce
// LLM dispatch as a side-effect.
