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

/// Hard-coded fixture used until v3.0 wires the real capture orchestrator.
/// Lives in a function (not a `const`) so the heap-allocated strings don't
/// have to be `&'static`.
fn stub_agents() -> Vec<AgentActivity> {
    vec![
        AgentActivity {
            user: "daizhe".to_string(),
            agent: "Cursor".to_string(),
            status: "running".to_string(),
            last_active: "45min".to_string(),
            task: Some("/api/auth refactor".to_string()),
        },
        AgentActivity {
            user: "daizhe".to_string(),
            agent: "Devin".to_string(),
            status: "running".to_string(),
            last_active: "30min".to_string(),
            task: Some("billing flow".to_string()),
        },
        AgentActivity {
            user: "hongyu".to_string(),
            agent: "Claude Code".to_string(),
            status: "idle".to_string(),
            last_active: "2h".to_string(),
            task: None,
        },
    ]
}

/// Return the current list of active personal AI agents across the team.
///
/// v2.0-beta.2: returns `stub_agents()` unconditionally. v3.0 will swap in
/// a read of the per-user capture watchers (see V2_0_SPEC.md §3.2).
#[tauri::command]
pub async fn get_active_agents() -> Result<Vec<AgentActivity>, AppError> {
    Ok(stub_agents())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_get_active_agents_returns_three_stub_rows() {
        let rows = get_active_agents().await.expect("stub should not error");
        assert_eq!(rows.len(), 3);
    }

    #[tokio::test]
    async fn test_stub_agents_have_expected_users_and_agents() {
        let rows = get_active_agents().await.unwrap();
        let users: Vec<&str> = rows.iter().map(|r| r.user.as_str()).collect();
        assert_eq!(users, vec!["daizhe", "daizhe", "hongyu"]);

        let agents: Vec<&str> = rows.iter().map(|r| r.agent.as_str()).collect();
        assert_eq!(agents, vec!["Cursor", "Devin", "Claude Code"]);
    }

    #[tokio::test]
    async fn test_idle_agent_has_no_task() {
        let rows = get_active_agents().await.unwrap();
        let hongyu = rows.iter().find(|r| r.user == "hongyu").unwrap();
        assert_eq!(hongyu.status, "idle");
        assert!(hongyu.task.is_none());
    }

    #[tokio::test]
    async fn test_running_agents_have_task() {
        let rows = get_active_agents().await.unwrap();
        for row in rows.iter().filter(|r| r.status == "running") {
            assert!(
                row.task.is_some(),
                "running agent must carry a task description"
            );
        }
    }

    #[tokio::test]
    async fn test_status_values_are_known_strings() {
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
