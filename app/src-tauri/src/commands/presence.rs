// === wave 1.13-D ===
//! v1.13 Wave 1.13-D — Tauri command surface for team presence.
//!
//! Two commands wrap `crate::agi::presence`:
//!
//! `presence_emit { user, current_route, active_atom?, action_type? }`
//!   → write the local user's presence file. The frontend
//!     `PresenceProvider` calls this every 10 s plus once on each route
//!     change so the heartbeat carries the freshest "what am I looking
//!     at" snapshot. Soft-fails so a transient FS error never blocks the
//!     UI tick.
//!
//! `presence_list_active { ttl_seconds?: u32 }` → return every teammate
//!   whose presence file is fresher than `ttl_seconds` (default 60).
//!   Excludes the calling user when `current_user` is provided so the
//!   React side doesn't render itself.
//!
//! Both commands also fire telemetry events (`presence_update_emitted` /
//! `presence_teammate_seen`) so the v1.9 suggestion engine can later
//! reason about "you and Hongyu were both on /memory at the same time".
//! Telemetry writes are best-effort: failures are logged but never
//! propagated.

use std::path::PathBuf;

use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

use crate::agi::presence::{self, PresenceInfo};
use crate::agi::telemetry::{self as agi_telemetry, TelemetryEvent};

use super::AppError;

/// Resolve the user's memory root. Mirrors `commands::telemetry`'s helper —
/// duplicated locally so this module doesn't take a private dep on memory.rs
/// internals.
fn resolve_memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// Argument shape for `presence_emit`. The frontend already knows its
/// `currentUser` from the Zustand store (`ui.currentUser`); we accept it
/// here rather than re-resolving on the Rust side because the Rust side
/// has no concept of "logged-in user" (auth lives entirely in the React
/// + Supabase stack).
#[derive(Debug, Deserialize)]
pub struct PresenceEmitArgs {
    pub user: String,
    pub current_route: String,
    pub active_atom: Option<String>,
    pub action_type: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PresenceListResult {
    pub teammates: Vec<PresenceInfo>,
}

/// Emit (write) the local user's presence file. Idempotent in the sense
/// that calling it back-to-back with the same payload simply overwrites
/// the same file with a fresh `last_active` timestamp — the file always
/// holds exactly one snapshot.
///
/// === v1.13.5 round-5 === — also fires the `presence:update` Tauri event
/// the React `PresenceProvider` already subscribes to via
/// `listenPresenceUpdates`. Round 4 wired the React side; Round 5 found
/// the Rust side never emitted, so the listener sat idle and the polling
/// fallback was the only live path. Now: every successful emit fan-outs
/// to all windows so multi-window setups (main + popout) and any future
/// daemon-driven git-pull-detected presence refresh share one channel.
#[tauri::command]
pub async fn presence_emit<R: Runtime>(
    app: AppHandle<R>,
    args: PresenceEmitArgs,
) -> Result<(), AppError> {
    let root = resolve_memory_root()?;

    // Defensive: a missing user string would land us writing to a `.json`
    // file whose stem is empty. Reject up front rather than producing junk.
    let user = args.user.trim().to_string();
    if user.is_empty() {
        return Err(AppError::internal("presence_emit", "empty user"));
    }

    let now = Utc::now().to_rfc3339();
    // We don't track started_at on the Rust side (the React store owns
    // session timing). On every emit we reuse `now` for both fields so
    // the on-disk schema stays valid even when the very first emit arrives.
    // The React side could later carry started_at through the args if it
    // wants the "online for 2h" rendering — for v1.13 the freshest emit
    // wins and the timestamp simply represents "last heartbeat".
    let info = PresenceInfo {
        user: user.clone(),
        current_route: args.current_route,
        active_atom: args.active_atom,
        action_type: args.action_type.clone(),
        last_active: now.clone(),
        started_at: now.clone(),
    };

    presence::write_local_presence(&root, &info)?;

    // Telemetry — best-effort, never propagate.
    let event = TelemetryEvent {
        event: "presence_update_emitted".to_string(),
        ts: now,
        user,
        payload: serde_json::json!({
            "route": info.current_route,
            "atom": info.active_atom,
            "action": args.action_type,
        }),
    };
    if let Err(e) = agi_telemetry::append_event(&root, event).await {
        tracing::warn!(error = %e, "presence_emit: telemetry append failed");
    }

    // === v1.13.5 round-5 === — fan out to listeners. Best-effort: an emit
    // failure should never bubble up because the on-disk write already
    // succeeded and the polling path will pick up the same snapshot.
    if let Err(e) = app.emit("presence:update", &info) {
        tracing::warn!(error = ?e, "presence_emit: tauri emit failed");
    }

    Ok(())
}

/// List teammates whose presence file is fresher than `ttl_seconds`. The
/// React `usePresence` hook calls this every 10 s on a tick (mounted at
/// AppShell level so all routes see the live state). Optional
/// `exclude_user` so the caller doesn't render itself in the avatar bar.
#[tauri::command]
pub async fn presence_list_active(
    ttl_seconds: Option<u32>,
    exclude_user: Option<String>,
) -> Result<PresenceListResult, AppError> {
    let root = resolve_memory_root()?;
    let ttl = Duration::seconds(ttl_seconds.unwrap_or(60) as i64);
    let teammates =
        presence::read_active_presences(&root, ttl, exclude_user.as_deref());

    // Telemetry one entry per visible teammate. Cheap enough at small N
    // (team OS launch target = ≤ 20 active teammates) and lets the
    // suggestion engine later reason about "co-presence on /memory".
    for info in &teammates {
        let event = TelemetryEvent {
            event: "presence_teammate_seen".to_string(),
            ts: Utc::now().to_rfc3339(),
            user: exclude_user.clone().unwrap_or_default(),
            payload: serde_json::json!({
                "teammate": info.user,
                "route": info.current_route,
                "atom": info.active_atom,
            }),
        };
        if let Err(e) = agi_telemetry::append_event(&root, event).await {
            tracing::warn!(error = %e, "presence_list_active: telemetry append failed");
        }
    }

    Ok(PresenceListResult { teammates })
}
// === end wave 1.13-D ===
