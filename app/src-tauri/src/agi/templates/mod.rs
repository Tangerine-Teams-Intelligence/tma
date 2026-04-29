//! v1.9.0-beta.2 — Rule-based suggestion templates.
//!
//! Spec: `SUGGESTION_ENGINE_SPEC.md` §4. Each template is a stateless detector
//! that runs on every co-thinker heartbeat and returns 0+ matches; the
//! [`registry::evaluate_all`] dispatcher walks every registered template,
//! concatenates output, sorts by priority descending, truncates to
//! [`registry::MAX_PER_HEARTBEAT`], and emits each surviving match through
//! the [`common::EventSink`] the heartbeat configured.
//!
//! Module layout:
//!   * [`common`]              — shared types: `Template` trait, `TemplateContext`,
//!                               `TemplateMatch`, `EventSink`.
//!   * [`deadline`]            — P2-A. Atom frontmatter `due_at` within 48h.
//!   * [`pattern_recurrence`]  — P2-A. Same keyword 5+ times in 7-day telemetry.
//!   * [`conflict`]            — P2-A. Two decision atoms with opposing keywords.
//!   * [`decision_drift`]      — P2-B. 2+ atoms touch the same project with
//!                               drifting decisions.
//!   * [`long_thread`]         — P2-B. Thread atom with msg count ≥ 10.
//!   * [`catchup_hint`]        — P2-B. App boot + last_opened_at > 24h ago.
//!   * [`newcomer_onboarding`] — P2-C. Fresh install, < 5 atoms + no telemetry.
//!   * [`registry`]            — P2-C. Single dispatcher: `all_templates()`,
//!                               `evaluate_all`, `evaluate_and_emit`,
//!                               `MAX_PER_HEARTBEAT` throttle.
//!
//! Coordination: every agent owns their own template files. The shared
//! contracts (`Template`, `TemplateContext`, `TemplateMatch`, `EventSink`,
//! `parse_frontmatter`, `walk_md_files`) live in [`common`] and MUST stay
//! signature-compatible across phasing boundaries — bump those signatures
//! only with all three P2 agents in the loop.
//!
//! Heartbeat integration: `co_thinker::heartbeat` ends with one call to
//! [`registry::evaluate_and_emit`] (see the marker block in `co_thinker.rs`).
//! No per-template glue lives in the heartbeat; adding/removing a template
//! is a one-line change to [`registry::all_templates`].

pub mod common;

// === P2-A landed templates ===
pub mod conflict;
pub mod deadline;
pub mod pattern_recurrence;
// === end P2-A ===

// === P2-B landed templates ===
pub mod catchup_hint;
pub mod decision_drift;
pub mod long_thread;
// === end P2-B ===

// === P2-C (newcomer_onboarding + registry/integration polish) ===
pub mod newcomer_onboarding;
pub mod registry;
// === end P2-C ===

// === v1.16 — LLM enrichment removed ===
// `llm_enrich` was the Stage-2 hook that re-emitted a rule match with
// LLM-generated prose. Removed in v1.16 along with the rest of the
// LLM-borrow stack. The rule fire path (this module's other templates)
// stays — they don't depend on a model.
// === end v1.16 ===
