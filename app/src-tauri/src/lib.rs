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
