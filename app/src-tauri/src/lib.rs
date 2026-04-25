//! Tangerine AI Teams library entry — kept thin so both the binary
//! (`main.rs`) and integration tests can link against the same surface.
//!
//! T3: when your `commands` module set is fully shipped (all of
//! commands::meetings, ::fs, ::discord, ::env, ::external, ::update exist
//! and compile), uncomment the `pub mod commands;` line below and update
//! `main.rs` to use `tmi_invoke_handler!()` instead of the shell-only
//! handler.
//!
//! Doing this in two steps avoids blocking T1 + T2 on T3's parallel work.
//
// pub mod commands;
