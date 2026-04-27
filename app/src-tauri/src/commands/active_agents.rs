//! v2.0-beta.2 — ACTIVE AGENTS sidebar feed.
//!
//! Exposes a single Tauri command, `get_active_agents`, that returns the
//! cross-team list of currently-active personal AI agents (Cursor sessions,
//! Devin runs, Claude Code workers, ...). The sidebar's `ActiveAgentsSection`
//! polls this every 10 seconds when the route is active, every 60 seconds
//! otherwise.
//!
//! v2.0-beta.2 ships **stub data only** — the real capture orchestrator
//! (per-source watchers under `crate::agents::{cursor,claude_code,devin,...}`)
//! lands in v3.0 alongside the personal vault. See V2_0_SPEC.md §3.1 / §3.2
//! for the full plan.
//!
//! Returning a stub from Rust (rather than just hard-coding it in the React
//! component) means:
//!   1. The IPC contract is locked now, so the v3.0 swap is a single-file
//!      change inside this module — no React-side coordination.
//!   2. The TypeScript `getActiveAgents()` wrapper exercises the real
//!      `safeInvoke` path during dogfood, instead of silently mocking forever.

use serde::Serialize;

use super::AppError;

/// One row in the ACTIVE AGENTS sidebar feed. Field names mirror the
/// TypeScript `AgentActivity` interface in `app/src/lib/tauri.ts`.
#[derive(Debug, Serialize, Clone)]
pub struct AgentActivity {
    /// User alias the agent belongs to (`"daizhe"`, `"hongyu"`, ...).
    /// Maps to a member in `~/.tmi/config.yaml :: team[]`.
    pub user: String,
    /// Agent kind. Stable string; the React side maps it to an icon.
    /// One of: `"Cursor"`, `"Claude Code"`, `"Devin"`, `"Replit"`,
    /// `"Apple Intelligence"`.
    pub agent: String,
    /// Status verdict. One of: `"running"`, `"idle"`, `"error"`.
    pub status: String,
    /// Human-friendly "last active" string (`"45min"`, `"2h"`, ...).
    /// Pre-formatted on the Rust side so the React component stays dumb.
    pub last_active: String,
    /// Optional one-line task description. `None` when the agent is idle.
    pub task: Option<String>,
}

/// === wave 6 === BUG #8 — fixture replaced with an empty list.
///
/// Pre-v1.9.3 we returned 3 hardcoded rows ("daizhe — Cursor — 45min", etc.)
/// regardless of what was actually installed on the user's machine. CEO ran
/// the v1.9.2 installer with no Cursor / no Devin and still saw those rows
/// — the sidebar was lying.
///
/// Wave 6 returns `vec![]` until the real capture orchestrator (v3.0) can
/// read per-user agent state from disk. The Sidebar's `ActiveAgentsSection`
/// already renders "no active agents" for an empty list, so the empty-state
/// is what users with no installed agents now see — matching reality.
fn stub_agents() -> Vec<AgentActivity> {
    Vec::new()
}

/// Return the current list of active personal AI agents across the team.
///
/// v2.0-beta.2: returns `stub_agents()` unconditionally. v3.0 will swap in
/// a read of the per-user capture watchers (see V2_0_SPEC.md §3.2).
///
/// === wave 6 === BUG #8 — `stub_agents()` now returns an empty Vec so the
/// sidebar's empty-state ("no active agents") shows up instead of the
/// fictitious 3-row fixture. The empty-state is honest about what's
/// actually parseable on the user's machine; the fixture was not.
#[tauri::command]
pub async fn get_active_agents() -> Result<Vec<AgentActivity>, AppError> {
    Ok(stub_agents())
}

#[cfg(test)]
mod tests {
    use super::*;

    // === wave 6 === BUG #8 — `stub_agents()` now returns an empty list so
    // the sidebar matches reality on machines that haven't installed any
    // AI agents. The pre-v1.9.3 tests asserting 3 hardcoded rows were
    // tracking the fictitious fixture; updated below to assert the new
    // honest behavior.

    #[tokio::test]
    async fn test_get_active_agents_returns_empty_until_capture_lands() {
        let rows = get_active_agents().await.expect("stub should not error");
        assert_eq!(
            rows.len(),
            0,
            "v1.9.3+: empty until per-user capture watchers (v3.0) wire in"
        );
    }

    #[tokio::test]
    async fn test_status_values_are_known_strings_when_present() {
        // The shape contract still holds: any row this command returns must
        // carry a status of "running" | "idle" | "error". Currently nothing is
        // returned, so the loop is a no-op — but the assertion guards against
        // a future regression that returns malformed rows.
        let rows = get_active_agents().await.unwrap();
        for row in &rows {
            assert!(
                matches!(row.status.as_str(), "running" | "idle" | "error"),
                "unexpected status: {}",
                row.status
            );
        }
    }
}
