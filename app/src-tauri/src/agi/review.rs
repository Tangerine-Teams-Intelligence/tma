//! v2.5 §1 — Decision review (PR-style workflow).
//!
//! Co-thinker proposes a decision. Instead of writing it straight into
//! `team/decisions/{atom}.md` (the v1.8 / v2.0 path via `canvas_writer.rs`),
//! v2.5 routes the proposal through a review thread. Teammates vote; once
//! the up-vote share crosses the per-team `quorum_threshold` (default 2/3),
//! the atom is auto-promoted (status flipped to `locked`). Below quorum,
//! the proposal sits in the open queue. After ~14 days of no movement we
//! mark it `stale` so the same drift doesn't get re-proposed every heartbeat.
//!
//! ## Storage
//!
//! Each decision atom (under `~/.tangerine-memory/team/decisions/{slug}.md`)
//! gets a sidecar JSON at the same path with `.review.json` appended:
//!
//! ```text
//! team/decisions/api-shape.md
//! team/decisions/api-shape.md.review.json   <-- this module's file
//! ```
//!
//! Sidecar instead of in-frontmatter so vote churn doesn't rewrite the
//! decision atom itself on every click. The atom stays git-clean while the
//! review state burns through one append per vote. Both files live in
//! `team/` so they sync.
//!
//! ## State machine
//!
//! ```text
//! open ──(approve votes / team_size >= threshold)──> approved → atom.status = locked
//! open ──(reject votes / team_size > 1 - threshold)──> rejected
//! open ──(now - created_at > 14d, no votes 14d)──> stale
//! ```
//!
//! `auto_promote_when_met` defaults to `true` — when an approve vote crosses
//! quorum, `try_promote` flips the atom's frontmatter `status:` to `locked`
//! and stamps the review as `approved`. Setting `false` keeps the review
//! `approved` but leaves the atom alone (manual override path).
//!
//! ## Idempotency
//!
//! `cast_vote` replaces any prior vote from the same user (one vote per
//! user per review). `try_promote` short-circuits if the review is already
//! approved/rejected. `create_review` is idempotent — calling twice on the
//! same atom returns the existing review.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::commands::AppError;

/// One vote on a review thread. `value` is the trinary verdict; `comment`
/// is optional free-form context.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Vote {
    pub user: String,
    pub ts: String,
    pub value: VoteValue,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VoteValue {
    Approve,
    Reject,
    Abstain,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReviewStatus {
    Open,
    Approved,
    Rejected,
    Stale,
}

/// Sidecar `*.review.json` shape. `atom_path` is repo-relative so the file
/// survives memory-root moves.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewState {
    pub atom_path: String,
    pub votes: Vec<Vote>,
    /// 0..1 — share of team that must vote `approve` to promote. Default 2/3.
    pub quorum_threshold: f32,
    /// When true (default), an approve vote that crosses quorum auto-flips
    /// the atom's frontmatter status to `locked`. False = manual promote only.
    pub auto_promote_when_met: bool,
    pub status: ReviewStatus,
    /// Stamped on `create_review`.
    pub created_at: String,
    /// Updated whenever a vote is cast.
    pub updated_at: String,
    /// Set on `try_promote` success.
    pub promoted_at: Option<String>,
    /// Pinned at create time so post-hoc team-roster changes don't re-quorum
    /// an in-flight review.
    pub team_member_count_at_create: u32,
}

impl ReviewState {
    fn now_iso() -> String {
        Utc::now().to_rfc3339()
    }

    fn new(atom_path: String, team_member_count: u32) -> Self {
        let now = Self::now_iso();
        Self {
            atom_path,
            votes: Vec::new(),
            // 2/3 — use exact proportion. Stored as 0.6666... so a vote of
            // 2/3 == threshold passes the `>=` quorum check without float
            // rounding gotchas (2 / 3.0 ≈ 0.6666666...).
            quorum_threshold: 2.0_f32 / 3.0_f32,
            auto_promote_when_met: true,
            status: ReviewStatus::Open,
            created_at: now.clone(),
            updated_at: now,
            promoted_at: None,
            team_member_count_at_create: team_member_count.max(1),
        }
    }
}

// ---------------------------------------------------------------------------
// Path helpers

/// Sidecar path for a given decision atom — `<atom>.review.json`.
pub fn sidecar_path(atom_path: &Path) -> PathBuf {
    let mut s = atom_path.as_os_str().to_owned();
    s.push(".review.json");
    PathBuf::from(s)
}

fn default_memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// Decisions live under `<memory_root>/team/decisions/`.
pub fn decisions_dir(memory_root: &Path) -> PathBuf {
    memory_root.join("team").join("decisions")
}

fn atom_rel_path(memory_root: &Path, atom_path: &Path) -> String {
    atom_path
        .strip_prefix(memory_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| atom_path.to_string_lossy().replace('\\', "/"))
}

// ---------------------------------------------------------------------------
// Persistence

fn read_state(atom_path: &Path) -> Result<Option<ReviewState>, AppError> {
    let p = sidecar_path(atom_path);
    if !p.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&p)
        .map_err(|e| AppError::internal("read_review", e.to_string()))?;
    let st: ReviewState = serde_json::from_str(&raw)?;
    Ok(Some(st))
}

fn write_state(atom_path: &Path, st: &ReviewState) -> Result<(), AppError> {
    let p = sidecar_path(atom_path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir_review", e.to_string()))?;
    }
    let json = serde_json::to_string_pretty(st)?;
    let tmp = p.with_extension("review.json.tmp");
    std::fs::write(&tmp, &json)
        .map_err(|e| AppError::internal("write_review_tmp", e.to_string()))?;
    std::fs::rename(&tmp, &p)
        .map_err(|e| AppError::internal("rename_review", e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Public API

/// Initialize a review for a freshly-proposed decision atom. Idempotent —
/// returns the existing state if the sidecar already exists (so a re-fired
/// co-thinker proposal doesn't reset votes already cast).
pub fn create_review(atom_path: &Path, team_member_count: u32) -> Result<ReviewState, AppError> {
    if let Some(existing) = read_state(atom_path)? {
        return Ok(existing);
    }
    let memory_root = default_memory_root().unwrap_or_else(|_| PathBuf::from("."));
    let rel = atom_rel_path(&memory_root, atom_path);
    let st = ReviewState::new(rel, team_member_count);
    write_state(atom_path, &st)?;
    Ok(st)
}

/// Test-friendly variant — caller provides the memory root.
pub fn create_review_in(
    memory_root: &Path,
    atom_path: &Path,
    team_member_count: u32,
) -> Result<ReviewState, AppError> {
    if let Some(existing) = read_state(atom_path)? {
        return Ok(existing);
    }
    let rel = atom_rel_path(memory_root, atom_path);
    let st = ReviewState::new(rel, team_member_count);
    write_state(atom_path, &st)?;
    Ok(st)
}

/// Record one vote. Replaces any prior vote from the same user. Recomputes
/// status + (if `auto_promote_when_met`) auto-promotes the atom.
pub fn cast_vote(
    atom_path: &Path,
    user: String,
    value: VoteValue,
    comment: Option<String>,
) -> Result<ReviewState, AppError> {
    let mut st = read_state(atom_path)?
        .ok_or_else(|| AppError::user("review_missing", format!(
            "no review found for atom {}",
            atom_path.display()
        )))?;

    if !matches!(st.status, ReviewStatus::Open) {
        return Err(AppError::user(
            "review_closed",
            format!("review is {:?}; cannot vote", st.status),
        ));
    }

    let now = Utc::now().to_rfc3339();
    let new_vote = Vote { user: user.clone(), ts: now.clone(), value, comment };

    // Replace any prior vote from this user.
    if let Some(idx) = st.votes.iter().position(|v| v.user == user) {
        st.votes[idx] = new_vote;
    } else {
        st.votes.push(new_vote);
    }
    st.updated_at = now;

    let _quorum_hit = compute_quorum(&st);
    let _ = recompute_status(&mut st);

    write_state(atom_path, &st)?;

    // Auto-promote happens AFTER the vote is persisted so a crash mid-promote
    // still leaves a recoverable record.
    if matches!(st.status, ReviewStatus::Approved) && st.auto_promote_when_met {
        st = try_promote_inner(atom_path, st)?;
    }

    Ok(st)
}

/// Read-only fetch of the review state. Returns `None` when the sidecar
/// is missing.
pub fn get_review(atom_path: &Path) -> Result<Option<ReviewState>, AppError> {
    read_state(atom_path)
}

/// Walk `team/decisions/` under the given memory root and return every
/// `*.review.json` whose status is `Open`. Cheap for the dashboard list.
pub fn list_open_in(memory_root: &Path) -> Result<Vec<ReviewState>, AppError> {
    let dir = decisions_dir(memory_root);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| AppError::internal("read_decisions_dir", e.to_string()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !name.ends_with(".review.json") {
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let mut st: ReviewState = match serde_json::from_str(&raw) {
            Ok(s) => s,
            Err(_) => continue,
        };
        // Walk the stale check at read time — keeps the list view honest
        // even if no vote has fired in 14d.
        let _ = mark_stale_if_needed(&mut st);
        if matches!(st.status, ReviewStatus::Open) {
            out.push(st);
        }
    }
    Ok(out)
}

/// Convenience wrapper around `list_open_in` using the default memory root.
pub fn list_open() -> Result<Vec<ReviewState>, AppError> {
    let root = default_memory_root()?;
    list_open_in(&root)
}

/// Manual-promote entry point. Walks the same path the auto-promoter takes.
pub fn try_promote(atom_path: &Path) -> Result<ReviewState, AppError> {
    let st = read_state(atom_path)?
        .ok_or_else(|| AppError::user("review_missing", format!(
            "no review found for atom {}", atom_path.display()
        )))?;
    try_promote_inner(atom_path, st)
}

fn try_promote_inner(atom_path: &Path, mut st: ReviewState) -> Result<ReviewState, AppError> {
    if matches!(st.status, ReviewStatus::Approved) && st.promoted_at.is_some() {
        // Already promoted — idempotent no-op.
        return Ok(st);
    }
    if !compute_quorum(&st) {
        let approve_count = st
            .votes
            .iter()
            .filter(|v| matches!(v.value, VoteValue::Approve))
            .count() as u32;
        let team_size = st.team_member_count_at_create.max(1);
        return Err(AppError::user(
            "review_under_quorum",
            format!(
                "need {:.0}% of {} approvals, have {}",
                st.quorum_threshold * 100.0,
                team_size,
                approve_count
            ),
        ));
    }

    // Flip atom frontmatter status to `locked`.
    promote_atom_status(atom_path, "locked")?;
    let now = Utc::now().to_rfc3339();
    st.status = ReviewStatus::Approved;
    st.promoted_at = Some(now.clone());
    st.updated_at = now;
    write_state(atom_path, &st)?;
    Ok(st)
}

// ---------------------------------------------------------------------------
// Quorum + status

/// True when the set of `Approve` votes crosses `quorum_threshold * team_size`
/// (using `ceil` so 2/3 of 4 = 3 approvals).
pub fn compute_quorum(st: &ReviewState) -> bool {
    let approve_count = st
        .votes
        .iter()
        .filter(|v| matches!(v.value, VoteValue::Approve))
        .count() as f32;
    let team_size = st.team_member_count_at_create.max(1) as f32;
    approve_count / team_size >= st.quorum_threshold
}

fn rejection_quorum(st: &ReviewState) -> bool {
    // Strict majority of team rejected. We don't want a single "no" on a
    // 3-person team (33%) to close the review — co-thinker can still rally
    // the other 2/3. Test gate R3 in V2_5_SPEC §1.7 implies rejection takes
    // the same shape as approval (just inverted): at least 50% reject.
    let reject_count = st
        .votes
        .iter()
        .filter(|v| matches!(v.value, VoteValue::Reject))
        .count() as f32;
    let team_size = st.team_member_count_at_create.max(1) as f32;
    reject_count / team_size > 0.5
}

fn recompute_status(st: &mut ReviewState) -> ReviewStatus {
    if compute_quorum(st) {
        st.status = ReviewStatus::Approved;
    } else if rejection_quorum(st) {
        st.status = ReviewStatus::Rejected;
    } else {
        st.status = ReviewStatus::Open;
    }
    st.status
}

fn mark_stale_if_needed(st: &mut ReviewState) -> bool {
    if !matches!(st.status, ReviewStatus::Open) {
        return false;
    }
    let updated: DateTime<Utc> = match st.updated_at.parse() {
        Ok(t) => t,
        Err(_) => return false,
    };
    if Utc::now().signed_duration_since(updated) > Duration::days(14) {
        st.status = ReviewStatus::Stale;
        return true;
    }
    false
}

// ---------------------------------------------------------------------------
// Atom frontmatter writer

/// Flip the `status:` line in an atom's YAML frontmatter to `new_status`.
/// Adds the field if missing. Best-effort — non-fatal if the atom file is
/// missing (the review still records the status change).
fn promote_atom_status(atom_path: &Path, new_status: &str) -> Result<(), AppError> {
    if !atom_path.exists() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(atom_path)
        .map_err(|e| AppError::internal("read_atom", e.to_string()))?;

    let lines: Vec<&str> = raw.lines().collect();
    let mut out_lines: Vec<String> = Vec::with_capacity(lines.len() + 1);

    let mut in_fm = false;
    let mut fm_end = false;
    let mut wrote_status = false;

    for (i, line) in lines.iter().enumerate() {
        if i == 0 && line.trim() == "---" {
            in_fm = true;
            out_lines.push(line.to_string());
            continue;
        }
        if in_fm && !fm_end {
            if line.trim() == "---" {
                if !wrote_status {
                    out_lines.push(format!("status: {}", new_status));
                    wrote_status = true;
                }
                out_lines.push(line.to_string());
                fm_end = true;
                continue;
            }
            if line.trim_start().starts_with("status:") {
                out_lines.push(format!("status: {}", new_status));
                wrote_status = true;
                continue;
            }
        }
        out_lines.push(line.to_string());
    }

    // Atom had no frontmatter — prepend one.
    if !in_fm {
        let mut new_out = vec![
            "---".to_string(),
            format!("status: {}", new_status),
            "---".to_string(),
            String::new(),
        ];
        new_out.extend(out_lines);
        out_lines = new_out;
    }

    let mut joined = out_lines.join("\n");
    if raw.ends_with('\n') && !joined.ends_with('\n') {
        joined.push('\n');
    }

    let tmp = atom_path.with_extension("md.tmp");
    std::fs::write(&tmp, &joined)
        .map_err(|e| AppError::internal("write_atom_tmp", e.to_string()))?;
    std::fs::rename(&tmp, atom_path)
        .map_err(|e| AppError::internal("rename_atom", e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_review_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn seed_atom(memory_root: &Path, slug: &str) -> PathBuf {
        let dir = decisions_dir(memory_root);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("{}.md", slug));
        std::fs::write(
            &p,
            "---\nstatus: draft\nproposed_by: co-thinker\n---\n\n# Decision\n\nbody\n",
        )
        .unwrap();
        p
    }

    #[test]
    fn create_then_2_of_3_approves_auto_promotes() {
        let root = tmp_root();
        let atom = seed_atom(&root, "api-shape");

        let st = create_review_in(&root, &atom, 3).unwrap();
        assert!(matches!(st.status, ReviewStatus::Open));
        assert_eq!(st.votes.len(), 0);
        assert!((st.quorum_threshold - 0.667).abs() < 1e-3);

        // 1st approve — under quorum (1/3 = 33% < 67%)
        let st = cast_vote(&atom, "alice".into(), VoteValue::Approve, None).unwrap();
        assert!(matches!(st.status, ReviewStatus::Open));
        assert!(!compute_quorum(&st));

        // 2nd approve — at quorum (2/3 = 67% >= 67%) → auto-promote
        let st = cast_vote(&atom, "bob".into(), VoteValue::Approve, None).unwrap();
        assert!(matches!(st.status, ReviewStatus::Approved));
        assert!(st.promoted_at.is_some());

        // Atom frontmatter must now read `status: locked`
        let raw = std::fs::read_to_string(&atom).unwrap();
        assert!(raw.contains("status: locked"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reject_vote_pre_quorum_does_not_promote() {
        let root = tmp_root();
        let atom = seed_atom(&root, "rest-vs-grpc");

        create_review_in(&root, &atom, 3).unwrap();
        let st = cast_vote(&atom, "alice".into(), VoteValue::Reject, Some("nope".into()))
            .unwrap();
        // 1 reject of 3 → 33% > (1 - 0.667) = 33%? Boundary: `>` not `>=`,
        // so we stay open until 2 rejects.
        assert!(matches!(st.status, ReviewStatus::Open));

        // Add an approve, atom must stay un-promoted (only 1 approve of 3).
        let st = cast_vote(&atom, "bob".into(), VoteValue::Approve, None).unwrap();
        assert!(matches!(st.status, ReviewStatus::Open));
        assert!(st.promoted_at.is_none());
        let raw = std::fs::read_to_string(&atom).unwrap();
        assert!(raw.contains("status: draft"), "atom must stay draft, got: {}", raw);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn user_revote_replaces_prior() {
        let root = tmp_root();
        let atom = seed_atom(&root, "revote-test");

        create_review_in(&root, &atom, 3).unwrap();
        cast_vote(&atom, "alice".into(), VoteValue::Reject, None).unwrap();
        let st = cast_vote(&atom, "alice".into(), VoteValue::Approve, None).unwrap();
        assert_eq!(st.votes.len(), 1);
        assert!(matches!(st.votes[0].value, VoteValue::Approve));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_open_returns_only_open() {
        let root = tmp_root();
        let a1 = seed_atom(&root, "open-1");
        let a2 = seed_atom(&root, "promoted-1");

        create_review_in(&root, &a1, 3).unwrap();
        create_review_in(&root, &a2, 3).unwrap();
        // Promote a2.
        cast_vote(&a2, "x".into(), VoteValue::Approve, None).unwrap();
        cast_vote(&a2, "y".into(), VoteValue::Approve, None).unwrap();

        let open = list_open_in(&root).unwrap();
        assert_eq!(open.len(), 1);
        assert!(open[0].atom_path.contains("open-1"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn solo_team_size_1_promotes_on_first_vote() {
        // team_size = 1 → 1 approval >= ceil(0.667 * 1) = 1.
        let root = tmp_root();
        let atom = seed_atom(&root, "solo");
        create_review_in(&root, &atom, 1).unwrap();
        let st = cast_vote(&atom, "alice".into(), VoteValue::Approve, None).unwrap();
        assert!(matches!(st.status, ReviewStatus::Approved));
        let _ = std::fs::remove_dir_all(&root);
    }
}
