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

// === wave 1.13-B ===
//
// L4 — Review workflow real. Adds the propose / vote / status /
// list_pending state machine described in V2_5_SPEC §1.13-B on top of the
// existing v2.5 sidecar surface above. The new layer is *frontmatter-
// native*: status / reviewers / votes / quorum / deadline live inside
// the atom's YAML frontmatter so a teammate cloning the team-memory git
// repo sees the review state without needing the sidecar JSON. The
// existing `review_*` commands continue to operate on the sidecar — we
// keep both because (a) co-thinker still emits sidecar reviews and we
// don't want to break the v2.5 dashboard, and (b) the frontmatter view
// is what the new /reviews tabs show.
//
// State machine: draft → proposed → under-review → ratified | rejected.
// Quorum modes: "2/3" (default, >50% approve, no rejects), "unanimous",
// "1/3". Past deadline without quorum → status flips to "expired".
//
// Inbox integration: every reviewer named in `review_propose` gets one
// `inbox_emit(InboxEvent { kind: ReviewRequest, ... })`. Wave 1.13-A
// owns the consumer surface; this module just emits.

use crate::agi::review_workflow as wf;
use crate::commands::inbox::{inbox_emit, InboxEvent, InboxEventKind};

/// Propose an atom for team review. Flips frontmatter `status:` to
/// `under-review`, attaches the reviewer list + quorum + deadline, and
/// fans out one `review_request` Inbox event per reviewer.
///
/// `quorum` is one of `"2/3"` (default), `"unanimous"`, `"1/3"`.
#[tauri::command]
pub async fn review_propose(
    atom_path: String,
    reviewers: Vec<String>,
    quorum: Option<String>,
    deadline: Option<String>,
    proposer: Option<String>,
) -> Result<wf::ReviewWorkflowState, AppError> {
    let path = resolve_atom_path(&atom_path)?;
    let state = wf::propose(&path, &reviewers, quorum.as_deref(), deadline.as_deref(), proposer.as_deref())?;

    // Fan-out Inbox events. Best-effort — if Inbox write fails we log but
    // the propose still succeeds (the review state IS the canonical record).
    let proposer_user = proposer.unwrap_or_else(|| "self".to_string());
    for reviewer in &reviewers {
        let event = InboxEvent {
            id: format!("rr_{}_{}_{}", reviewer, state.proposed_at.replace(':', "-"), uuid::Uuid::new_v4().simple()),
            kind: InboxEventKind::ReviewRequest,
            recipient: reviewer.clone(),
            source: atom_path.clone(),
            payload: serde_json::json!({
                "atom_path": atom_path,
                "proposer": proposer_user,
                "deadline": state.deadline,
                "quorum": state.quorum,
            }),
            at: chrono::Utc::now().to_rfc3339(),
            read: false,
        };
        let _ = inbox_emit(event);
    }
    Ok(state)
}

/// Cast a vote on an under-review atom. `vote` is `"approve"`,
/// `"reject"`, or `"request_changes"`. When quorum is reached the atom
/// status flips to `ratified` (or `rejected`).
#[tauri::command]
pub async fn review_vote(
    atom_path: String,
    user: String,
    vote: String,
    comment: Option<String>,
) -> Result<wf::ReviewWorkflowState, AppError> {
    let path = resolve_atom_path(&atom_path)?;
    let v = wf::WorkflowVote::parse(&vote)?;
    wf::vote(&path, &user, v, comment.as_deref())
}

/// Read the current workflow state for an atom. Returns `None` when the
/// atom has no review frontmatter.
#[tauri::command]
pub async fn review_workflow_status(
    atom_path: String,
) -> Result<Option<wf::ReviewWorkflowState>, AppError> {
    let path = resolve_atom_path(&atom_path)?;
    wf::status(&path)
}

/// All atoms awaiting `user`'s vote (or every pending review if `user`
/// is omitted — useful for an admin overview).
#[tauri::command]
pub async fn review_list_pending(
    user: Option<String>,
) -> Result<Vec<wf::AtomReviewSummary>, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    let memory_root = home.join(".tangerine-memory");
    wf::list_pending_in(&memory_root, user.as_deref())
}

/// All atoms proposed by `user` (any status). Powers the "Proposed by me"
/// tab on `/reviews`.
#[tauri::command]
pub async fn review_list_proposed_by(
    user: String,
) -> Result<Vec<wf::AtomReviewSummary>, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    let memory_root = home.join(".tangerine-memory");
    wf::list_by_proposer_in(&memory_root, &user)
}

/// All atoms whose workflow status is `ratified` or `rejected`. Powers
/// the corresponding tabs.
#[tauri::command]
pub async fn review_list_by_status(
    status: String,
) -> Result<Vec<wf::AtomReviewSummary>, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    let memory_root = home.join(".tangerine-memory");
    wf::list_by_status_in(&memory_root, &status)
}
// === end wave 1.13-B ===
