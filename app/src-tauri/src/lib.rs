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
pub mod uri_handler;
pub mod ws_server;
