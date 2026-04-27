//! v2.5 §1 — Tauri command surface for the decision review workflow.
//!
//! Thin wrappers around `crate::agi::review`. The frontend calls these from
//! `/reviews` (list + detail views) and from the co-thinker integration.

use std::path::{Path, PathBuf};

use crate::agi::review::{
    cast_vote as agi_cast_vote, create_review as agi_create_review, get_review,
    list_open as agi_list_open, try_promote as agi_try_promote, ReviewState, VoteValue,
};
use crate::commands::AppError;

/// Resolve an atom path argument. Accepts either an absolute path or a
/// repo-relative one (`team/decisions/foo.md`); relative paths are joined
/// onto `~/.tangerine-memory/`.
fn resolve_atom_path(input: &str) -> Result<PathBuf, AppError> {
    let p = Path::new(input);
    if p.is_absolute() {
        return Ok(p.to_path_buf());
    }
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory").join(p))
}

/// Initialize a review thread for the atom at `atom_path`. Idempotent.
/// `team_member_count` is pinned at create time (default 3 if missing — keeps
/// the 2/3 quorum sensible for a typical small team).
#[tauri::command]
pub async fn review_create(
    atom_path: String,
    team_member_count: Option<u32>,
) -> Result<ReviewState, AppError> {
    let path = resolve_atom_path(&atom_path)?;
    let count = team_member_count.unwrap_or(3);
    agi_create_review(&path, count)
}

/// Cast a vote. `value` must be one of `"approve" | "reject" | "abstain"`.
#[tauri::command]
pub async fn review_cast_vote(
    atom_path: String,
    user: String,
    value: String,
    comment: Option<String>,
) -> Result<ReviewState, AppError> {
    let path = resolve_atom_path(&atom_path)?;
    let v = match value.as_str() {
        "approve" => VoteValue::Approve,
        "reject" => VoteValue::Reject,
        "abstain" => VoteValue::Abstain,
        other => {
            return Err(AppError::user(
                "bad_vote_value",
                format!("vote must be approve|reject|abstain, got {other}"),
            ))
        }
    };
    agi_cast_vote(&path, user, v, comment)
}

/// Read-only fetch. Returns `null` (None) when no review exists.
#[tauri::command]
pub async fn review_get(atom_path: String) -> Result<Option<ReviewState>, AppError> {
    let path = resolve_atom_path(&atom_path)?;
    get_review(&path)
}

/// All currently-open reviews (list view).
#[tauri::command]
pub async fn review_list_open() -> Result<Vec<ReviewState>, AppError> {
    agi_list_open()
}

/// Manual promotion override (e.g. owner force-merge). Errors if the review
/// is still under quorum.
#[tauri::command]
pub async fn review_promote(atom_path: String) -> Result<ReviewState, AppError> {
    let path = resolve_atom_path(&atom_path)?;
    agi_try_promote(&path)
}
