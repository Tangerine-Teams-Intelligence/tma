//! Tangerine AI Teams library entry — kept thin so both the binary
//! (`main.rs`) and integration tests can link against the same surface.
//!
//! T3: the `commands` module set is now exposed; `main.rs` uses
//! `tmi_invoke_handler!()` to register the full command surface (including
//! the v1.5 local-Whisper bring-up: get_whisper_model_status,
//! download_whisper_model, cancel_whisper_download in commands::whisper_model).

pub mod commands;
pub mod daemon;
pub mod memory_search;
// v2.0-alpha.1 — layered memory dir (`/team/` + `/personal/<user>/`).
//   * `memory_paths` resolves a kind path under either scope.
//   * `migration` runs once on boot to fold any v1.x flat layout into
//     `/team/`, seed an empty `/personal/<user>/` skeleton, and write the
//     canonical `.gitignore`.
pub mod memory_paths;
pub mod migration;
// v1.8 Phase 3 — AGI co-thinker module.
//   * Phase 3-A (this file's owner): `agi::session_borrower` — LLM dispatch
//     contract over MCP sampling / browser ext / Ollama.
//   * Phase 3-B (sibling agent): `agi::co_thinker` + `agi::observations`
//     ship later in this same module.
pub mod agi;
// v1.8 Phase 2 — source-side adapters.
//   * Phase 2-A/B (sibling agents) ships writeback for github / linear and a
//     `decisions/*.md` watcher.
//   * Phase 2-D (this agent) ships ingest for email + voice notes.
// Both halves cohabit `sources/`. The module declaration is kept here in
// `lib.rs` so the integration tests under `app/src-tauri/tests/` can reach
// the connector code without going through the `commands` crate boundary.
pub mod sources;
pub mod uri_handler;
pub mod ws_server;

// === v2.5 cloud_sync ===
// v2.5 §5 — managed cloud sync stub (per-team git mirror). Real network
// transport is deferred to v2.5 production; this module is the API + config
// shape so the React Settings surface can wire up now. Tauri-callable
// wrappers (`cloud_sync_*`) are registered in `commands::mod`.
pub mod cloud_sync;
// === end v2.5 cloud_sync ===

// === v2.5 auth + billing ===
// v2.5 §2 + §3 — real Supabase auth (replaces v1.x localStorage stub) + Stripe
// Connect billing ($5/team/month flat, 30-day no-CC trial). Both modules ship
// in **stub mode by default** — never call real Supabase / Stripe until the
// CEO unblocks `STRIPE_API_KEY` + `SUPABASE_URL` env vars. Stub mode simulates
// the full state machine end-to-end so the React surfaces (`/billing` route,
// TrialBanner, paywall gate) integrate today and the real swap is a one-line
// env change.
//
// Wave 2 deepens this: webhook event dispatch covers the 6 events listed in
// spec §2.6, an IP rate-limit JSONL ledger backs the 3-trials-per-IP-per-7d
// gate, the daemon polls a reconcile tick to recover from missed webhooks,
// and `email_verify` owns the Postmark / SendGrid send + token-verify flow
// that gates `trial_start`.
pub mod auth;
pub mod billing;
pub mod email_verify;
// === end v2.5 auth + billing ===

// === v3.0 personal agents ===
// v3.0 §1 — Personal AI agent capture (Cursor, Claude Code, Codex, Windsurf).
// Reads the user's local agent conversation logs and writes per-conversation
// atoms under `personal/<user>/threads/<source>/`. Strict opt-in: each
// adapter is gated behind a per-source toggle in
// `<user_data>/personal_agents.json`. The Tauri command surface lives at
// `crate::commands::personal_agents`; the daemon hook ticks each enabled
// source at the end of every heartbeat.
pub mod personal_agents;
// === end v3.0 personal agents ===

// === v3.5 marketplace ===
// v3.5 §1: marketplace backend (stub mode by default). Tauri command surface
// in `commands::marketplace` is the React-side entry point; this module owns
// the catalog model, install/uninstall, commission engine, and trigger-gate
// state. Real catalog API + Stripe Connect payout lights up once the v3.5
// launch gate passes (5k OSS installs + 1 self-shipped vertical template).
pub mod marketplace;
// === end v3.5 marketplace ===

// === v3.5 branding ===
// v3.5 §4: enterprise white-label branding override. Default = Tangerine
// baseline; enterprise tenants overlay logo / palette / domain / app name.
// Stub license validator accepts `tangerine-trial-*` / `tangerine-license-*`.
pub mod branding;
// === end v3.5 branding ===

// === v3.5 sso ===
// v3.5 §5.1: SSO SAML scaffold (stub). Two providers prioritized: Okta +
// Azure AD. `validate_saml_response` returns a deterministic mock
// assertion until the production cut wires `keycloak-rs` or WorkOS.
pub mod sso;
// === end v3.5 sso ===

// === v3.5 audit ===
// v3.5 §5.2: enterprise audit log. Append-only JSONL per UTC day under
// `~/.tangerine-memory/.tangerine/audit/`. Stub mode stamps
// `region = "us-east"`; real region routing in v3.5 enterprise tier.
pub mod audit_log;
// === end v3.5 audit ===

// === Wave 3 cross-cut: observability ===
// Per OBSERVABILITY_SPEC §5 — performance budget instrumentation.
pub mod perf;
// Per OBSERVABILITY_SPEC §9 — SOC 2 monitoring controls.
pub mod monitoring;
// === end Wave 3 cross-cut ===
