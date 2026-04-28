// === wave 1.13-B ===
//! Wave 1.13-B — frontmatter-native review workflow.
//!
//! State machine: `draft` → `proposed` → `under-review` → `ratified` |
//! `rejected` (or `expired` when deadline lapses without quorum).
//!
//! Sits *next to* the existing v2.5 `crate::agi::review` sidecar engine.
//! That one is co-thinker's persistent vote log (one JSON sidecar per
//! atom, votes append over time, 2/3 quorum auto-promotes the atom's
//! frontmatter `status:` to `locked`). This module is the human-driven
//! companion: a teammate clicks "Propose for review" on a draft atom,
//! the workflow writes the review state INTO the atom's frontmatter, and
//! reviewers vote from the `/reviews` tabs.
//!
//! Why two layers? V2.5 ships with the sidecar shape baked into
//! `*.review.json`; ripping it out for v1.13-B would break the live
//! `/reviews` route + co-thinker's auto-propose flow + the dogfood
//! database. The frontmatter layer is the *new* surface 1.13-B's tabs +
//! "Propose for review" button speak to. Both can coexist (a single atom
//! can have both a sidecar and a frontmatter review — the frontmatter is
//! authoritative for human reviews, the sidecar for AGI-driven ones).
//!
//! Quorum modes:
//!   * `"2/3"` (default) — `>50%` approve, no rejects → ratified
//!   * `"unanimous"`     — every reviewer approves → ratified
//!   * `"1/3"`           — at least 1 approve → ratified
//!   * Any reject majority (`>50%`) → rejected
//!   * Past deadline w/o quorum → expired

use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::commands::AppError;

// ---------------------------------------------------------------------------
// Types

/// Workflow vote — superset of the v2.5 trinary vote, with `request_changes`
/// added (treated as a soft reject that does NOT count toward the rejection
/// quorum but does block ratification until withdrawn or replaced).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowVote {
    Approve,
    Reject,
    RequestChanges,
}

impl WorkflowVote {
    pub fn parse(s: &str) -> Result<Self, AppError> {
        match s {
            "approve" => Ok(Self::Approve),
            "reject" => Ok(Self::Reject),
            "request_changes" | "request-changes" | "requestchanges" => {
                Ok(Self::RequestChanges)
            }
            other => Err(AppError::user(
                "bad_vote_value",
                format!("vote must be approve|reject|request_changes, got {other}"),
            )),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approve => "approve",
            Self::Reject => "reject",
            Self::RequestChanges => "request_changes",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowVoteEntry {
    pub user: String,
    pub vote: WorkflowVote,
    pub at: String,
    pub comment: Option<String>,
}

/// Frontmatter-native review state for a single atom.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewWorkflowState {
    /// Atom path (absolute on disk; the surface command resolves it).
    pub atom_path: String,
    /// `draft` | `proposed` | `under-review` | `ratified` | `rejected` | `expired`.
    pub status: String,
    /// Reviewers list (usernames).
    pub reviewers: Vec<String>,
    /// All votes cast so far. One entry per (user, vote) pair; a re-vote
    /// replaces the prior entry from the same user.
    pub votes: Vec<WorkflowVoteEntry>,
    /// `"2/3"` | `"unanimous"` | `"1/3"`.
    pub quorum: String,
    /// RFC3339 deadline, or None.
    pub deadline: Option<String>,
    pub proposer: Option<String>,
    pub proposed_at: String,
}

/// Lightweight summary for the /reviews tab list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AtomReviewSummary {
    pub atom_path: String,
    pub atom_title: String,
    pub status: String,
    pub proposer: Option<String>,
    pub reviewers: Vec<String>,
    pub votes_cast: u32,
    pub votes_required: u32,
    pub deadline: Option<String>,
    pub proposed_at: String,
}

// ---------------------------------------------------------------------------
// Public API

/// Flip an atom from `draft`/`proposed` → `under-review`. Stamps the
/// reviewers / quorum / deadline in frontmatter.
pub fn propose(
    atom_path: &Path,
    reviewers: &[String],
    quorum: Option<&str>,
    deadline: Option<&str>,
    proposer: Option<&str>,
) -> Result<ReviewWorkflowState, AppError> {
    if reviewers.is_empty() {
        return Err(AppError::user(
            "no_reviewers",
            "review_propose requires at least one reviewer",
        ));
    }
    let q = quorum.unwrap_or("2/3");
    validate_quorum(q)?;
    let now = Utc::now().to_rfc3339();
    let mut fm = read_frontmatter(atom_path)?;
    fm.set("status", yaml_string("under-review"));
    fm.set("reviewers", yaml_string_seq(reviewers));
    fm.set("quorum", yaml_string(q));
    if let Some(d) = deadline {
        fm.set("deadline", yaml_string(d));
    } else {
        fm.remove("deadline");
    }
    if let Some(p) = proposer {
        fm.set("proposer", yaml_string(p));
    }
    fm.set("proposed_at", yaml_string(&now));
    // Reset votes block on (re-)propose so a stale `request_changes` vote
    // from a prior cycle doesn't carry over.
    fm.set("votes", "[]".to_string());
    write_frontmatter(atom_path, fm)?;
    state_from_disk(atom_path)
}

/// Cast a vote. Replaces any prior vote from the same user. Recomputes
/// status — auto-flips to `ratified` / `rejected` when quorum is hit.
pub fn vote(
    atom_path: &Path,
    user: &str,
    vote: WorkflowVote,
    comment: Option<&str>,
) -> Result<ReviewWorkflowState, AppError> {
    let mut state = state_from_disk(atom_path)?;
    if state.status == "ratified" || state.status == "rejected" {
        return Err(AppError::user(
            "review_closed",
            format!("review is {}, cannot vote", state.status),
        ));
    }
    if state.status == "draft" {
        return Err(AppError::user(
            "not_under_review",
            "atom must be proposed for review before voting",
        ));
    }
    if !state.reviewers.iter().any(|r| r == user) {
        return Err(AppError::user(
            "not_a_reviewer",
            format!("user {user} is not on the reviewer list"),
        ));
    }
    let now = Utc::now().to_rfc3339();
    let entry = WorkflowVoteEntry {
        user: user.to_string(),
        vote,
        at: now,
        comment: comment.map(|s| s.to_string()),
    };
    if let Some(idx) = state.votes.iter().position(|v| v.user == user) {
        state.votes[idx] = entry;
    } else {
        state.votes.push(entry);
    }

    // Recompute terminal status.
    let next_status = compute_status(&state);
    state.status = next_status;

    // Persist back.
    let mut fm = read_frontmatter(atom_path)?;
    fm.set("status", yaml_string(&state.status));
    fm.set("votes", serialize_votes(&state.votes));
    write_frontmatter(atom_path, fm)?;
    Ok(state)
}

/// Read the workflow state from frontmatter. Returns `None` if the atom
/// has no `reviewers:` key (i.e. never proposed for review via this
/// surface).
pub fn status(atom_path: &Path) -> Result<Option<ReviewWorkflowState>, AppError> {
    if !atom_path.exists() {
        return Ok(None);
    }
    let fm = read_frontmatter(atom_path)?;
    if fm.get("reviewers").is_none() && fm.get("status").map(|s| s.trim()) != Some("under-review") {
        return Ok(None);
    }
    state_from_disk(atom_path).map(Some)
}

/// All atoms under `<memory_root>/team/decisions/` (and any markdown
/// directly under `<memory_root>/team/`) whose status is `under-review`
/// AND `user` appears in `reviewers:` AND has not yet voted.
pub fn list_pending_in(
    memory_root: &Path,
    user: Option<&str>,
) -> Result<Vec<AtomReviewSummary>, AppError> {
    let mut out = Vec::new();
    walk_atoms(memory_root, &mut |path| {
        let st = match state_from_disk(path) {
            Ok(s) => s,
            Err(_) => return,
        };
        if st.status != "under-review" {
            return;
        }
        if let Some(u) = user {
            if !st.reviewers.iter().any(|r| r == u) {
                return;
            }
            if st.votes.iter().any(|v| v.user == u) {
                return;
            }
        }
        if let Some(s) = summarize(path, &st) {
            out.push(s);
        }
    })?;
    Ok(out)
}

/// Atoms whose `proposer:` matches `user` (any status).
pub fn list_by_proposer_in(
    memory_root: &Path,
    user: &str,
) -> Result<Vec<AtomReviewSummary>, AppError> {
    let mut out = Vec::new();
    walk_atoms(memory_root, &mut |path| {
        let st = match state_from_disk(path) {
            Ok(s) => s,
            Err(_) => return,
        };
        if st.proposer.as_deref() != Some(user) {
            return;
        }
        if let Some(s) = summarize(path, &st) {
            out.push(s);
        }
    })?;
    Ok(out)
}

/// Atoms with the given workflow status.
pub fn list_by_status_in(
    memory_root: &Path,
    status: &str,
) -> Result<Vec<AtomReviewSummary>, AppError> {
    let mut out = Vec::new();
    walk_atoms(memory_root, &mut |path| {
        let st = match state_from_disk(path) {
            Ok(s) => s,
            Err(_) => return,
        };
        if st.status != status {
            return;
        }
        if let Some(s) = summarize(path, &st) {
            out.push(s);
        }
    })?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// Quorum + status

fn validate_quorum(q: &str) -> Result<(), AppError> {
    match q {
        "2/3" | "unanimous" | "1/3" => Ok(()),
        other => Err(AppError::user(
            "bad_quorum",
            format!("quorum must be 2/3|unanimous|1/3, got {other}"),
        )),
    }
}

/// Returns the next status (`under-review`, `ratified`, `rejected`, or
/// `expired`).
pub fn compute_status(state: &ReviewWorkflowState) -> String {
    let approves = state
        .votes
        .iter()
        .filter(|v| matches!(v.vote, WorkflowVote::Approve))
        .count();
    let rejects = state
        .votes
        .iter()
        .filter(|v| matches!(v.vote, WorkflowVote::Reject))
        .count();
    let request_changes = state
        .votes
        .iter()
        .filter(|v| matches!(v.vote, WorkflowVote::RequestChanges))
        .count();
    let n = state.reviewers.len().max(1);

    // Reject majority short-circuits.
    if rejects * 2 > n {
        return "rejected".to_string();
    }

    // Pending request_changes blocks ratification regardless of approves.
    if request_changes > 0 && state.quorum != "1/3" {
        // Check deadline first.
        if past_deadline(&state.deadline) {
            return "expired".to_string();
        }
        return "under-review".to_string();
    }

    let ratified = match state.quorum.as_str() {
        "unanimous" => approves == n && rejects == 0 && request_changes == 0,
        "2/3" => approves * 2 > n && rejects == 0,
        "1/3" => approves >= 1 && rejects == 0,
        _ => false,
    };

    if ratified {
        return "ratified".to_string();
    }

    if past_deadline(&state.deadline) {
        return "expired".to_string();
    }

    "under-review".to_string()
}

fn past_deadline(deadline: &Option<String>) -> bool {
    let Some(d) = deadline else {
        return false;
    };
    match d.parse::<DateTime<Utc>>() {
        Ok(t) => Utc::now() > t,
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Frontmatter I/O — minimal YAML parser tailored to our review fields.

#[derive(Debug, Clone, Default)]
struct Frontmatter {
    /// (key, raw-value) pairs. `value` is the verbatim YAML scalar/flow
    /// without trailing newline. We preserve insertion order so existing
    /// frontmatter is round-tripped without churn.
    pairs: Vec<(String, String)>,
    /// Body after the closing `---`. Includes leading newline if present.
    body: String,
    /// True if the file had a `---` frontmatter block at all.
    had_fm: bool,
}

impl Frontmatter {
    fn get(&self, key: &str) -> Option<&str> {
        self.pairs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
    fn set(&mut self, key: &str, value: String) {
        if let Some(slot) = self.pairs.iter_mut().find(|(k, _)| k == key) {
            slot.1 = value;
        } else {
            self.pairs.push((key.to_string(), value));
        }
    }
    fn remove(&mut self, key: &str) {
        self.pairs.retain(|(k, _)| k != key);
    }
    fn render(&self) -> String {
        let mut out = String::from("---\n");
        for (k, v) in &self.pairs {
            if v.starts_with('[') || v.contains('\n') {
                // Flow / multiline value already pre-formatted by caller.
                out.push_str(k);
                out.push_str(": ");
                out.push_str(v);
                if !v.ends_with('\n') {
                    out.push('\n');
                }
            } else {
                out.push_str(k);
                out.push_str(": ");
                out.push_str(v);
                out.push('\n');
            }
        }
        out.push_str("---\n");
        if !self.body.is_empty() {
            if !self.body.starts_with('\n') {
                out.push('\n');
            }
            out.push_str(&self.body);
        }
        out
    }
}

fn read_frontmatter(atom_path: &Path) -> Result<Frontmatter, AppError> {
    if !atom_path.exists() {
        return Ok(Frontmatter::default());
    }
    let raw = std::fs::read_to_string(atom_path)
        .map_err(|e| AppError::internal("read_atom", e.to_string()))?;
    Ok(parse_frontmatter(&raw))
}

fn parse_frontmatter(raw: &str) -> Frontmatter {
    let mut fm = Frontmatter::default();
    let mut lines = raw.lines();
    let first = match lines.next() {
        Some(l) => l,
        None => return fm,
    };
    if first.trim() != "---" {
        fm.body = raw.to_string();
        return fm;
    }
    fm.had_fm = true;
    let mut buf_key: Option<String> = None;
    let mut buf_val: Option<String> = None;

    let mut body_started = false;
    let mut body_lines: Vec<&str> = Vec::new();

    for line in &mut lines {
        if !body_started {
            if line.trim() == "---" {
                if let (Some(k), Some(v)) = (buf_key.take(), buf_val.take()) {
                    fm.pairs.push((k, v));
                }
                body_started = true;
                continue;
            }
            // Continuation line for a flow-mapping value (e.g. `votes: [...]`
            // continued on next line) — we rely on each value being
            // single-line for our schema, so any non-key, non-`---` line
            // before the closing fence is appended to the previous value.
            if !line.starts_with(' ') && line.contains(':') {
                if let (Some(k), Some(v)) = (buf_key.take(), buf_val.take()) {
                    fm.pairs.push((k, v));
                }
                let mut split = line.splitn(2, ':');
                let k = split.next().unwrap().trim().to_string();
                let v = split.next().unwrap_or("").trim().to_string();
                buf_key = Some(k);
                buf_val = Some(v);
            } else if buf_val.is_some() {
                let v = buf_val.take().unwrap();
                buf_val = Some(format!("{}\n{}", v, line));
            }
        } else {
            body_lines.push(line);
        }
    }
    if let (Some(k), Some(v)) = (buf_key, buf_val) {
        fm.pairs.push((k, v));
    }
    fm.body = body_lines.join("\n");
    if raw.ends_with('\n') && !fm.body.is_empty() && !fm.body.ends_with('\n') {
        fm.body.push('\n');
    }
    fm
}

fn write_frontmatter(atom_path: &Path, fm: Frontmatter) -> Result<(), AppError> {
    if let Some(parent) = atom_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir_atom", e.to_string()))?;
    }
    let rendered = fm.render();
    let tmp = atom_path.with_extension("md.tmp.wfwrite");
    std::fs::write(&tmp, &rendered)
        .map_err(|e| AppError::internal("write_atom_tmp", e.to_string()))?;
    std::fs::rename(&tmp, atom_path)
        .map_err(|e| AppError::internal("rename_atom", e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// YAML helpers (intentionally narrow — schema is pinned)

fn yaml_string(s: &str) -> String {
    let needs_quote = s.is_empty()
        || s.contains(':')
        || s.contains('#')
        || s.starts_with('@')
        || s.starts_with('[')
        || s.starts_with('-');
    if needs_quote {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

fn yaml_string_seq(items: &[String]) -> String {
    let mut buf = String::from("[");
    for (i, s) in items.iter().enumerate() {
        if i > 0 {
            buf.push_str(", ");
        }
        buf.push_str(&yaml_string(s));
    }
    buf.push(']');
    buf
}

fn parse_string_seq(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        let inner = &trimmed[1..trimmed.len() - 1];
        return inner
            .split(',')
            .map(|s| dequote(s.trim()))
            .filter(|s| !s.is_empty())
            .collect();
    }
    // Block-style sequence (one `- name` per line) — multiline values
    // come in as `\n- alex\n- sam`.
    let mut out = Vec::new();
    for line in trimmed.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("- ") {
            out.push(dequote(rest.trim()));
        } else if line.starts_with('-') {
            out.push(dequote(line[1..].trim()));
        }
    }
    out
}

fn dequote(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && (s.starts_with('"') && s.ends_with('"')) {
        s[1..s.len() - 1].replace("\\\"", "\"")
    } else if s.len() >= 2 && (s.starts_with('\'') && s.ends_with('\'')) {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

fn serialize_votes(votes: &[WorkflowVoteEntry]) -> String {
    // Render as flow-style JSON-ish list — yaml is a JSON superset for
    // simple cases like ours.
    let mut buf = String::from("[");
    for (i, v) in votes.iter().enumerate() {
        if i > 0 {
            buf.push_str(", ");
        }
        let comment = v.comment.as_deref().unwrap_or("");
        buf.push_str(&format!(
            "{{user: \"{}\", vote: \"{}\", at: \"{}\", comment: \"{}\"}}",
            v.user.replace('"', "\\\""),
            v.vote.as_str(),
            v.at,
            comment.replace('"', "\\\""),
        ));
    }
    buf.push(']');
    buf
}

fn parse_votes(raw: &str) -> Vec<WorkflowVoteEntry> {
    // Try JSON array first (our serializer output is valid JSON-ish but
    // wraps keys without quotes). Re-quote keys so `serde_json` can take
    // it, then parse.
    let trimmed = raw.trim();
    if trimmed == "[]" || trimmed.is_empty() {
        return Vec::new();
    }
    let json_ish = quote_json_keys(trimmed);
    if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&json_ish) {
        return arr
            .into_iter()
            .filter_map(|v| {
                let user = v.get("user")?.as_str()?.to_string();
                let vote_s = v.get("vote")?.as_str()?;
                let vote = WorkflowVote::parse(vote_s).ok()?;
                let at = v.get("at")?.as_str()?.to_string();
                let comment = v
                    .get("comment")
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string())
                    .filter(|s| !s.is_empty());
                Some(WorkflowVoteEntry { user, vote, at, comment })
            })
            .collect();
    }
    Vec::new()
}

/// Wrap unquoted keys in double quotes (`{user: "x"}` → `{"user": "x"}`).
fn quote_json_keys(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut in_string = false;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c == '"' {
            // toggle, respecting escapes
            let mut bs = 0;
            let mut j = i;
            while j > 0 && bytes[j - 1] == b'\\' {
                bs += 1;
                j -= 1;
            }
            if bs % 2 == 0 {
                in_string = !in_string;
            }
            out.push(c);
            i += 1;
            continue;
        }
        if in_string {
            out.push(c);
            i += 1;
            continue;
        }
        if c == '{' || c == ',' {
            out.push(c);
            i += 1;
            // Skip whitespace.
            while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\n') {
                out.push(bytes[i] as char);
                i += 1;
            }
            // Look ahead for an unquoted identifier followed by `:`.
            let start = i;
            while i < bytes.len() {
                let b = bytes[i];
                if b.is_ascii_alphanumeric() || b == b'_' {
                    i += 1;
                } else {
                    break;
                }
            }
            if start != i && i < bytes.len() {
                // Find next non-whitespace.
                let mut k = i;
                while k < bytes.len() && (bytes[k] == b' ' || bytes[k] == b'\n') {
                    k += 1;
                }
                if k < bytes.len() && bytes[k] == b':' {
                    out.push('"');
                    out.push_str(&s[start..i]);
                    out.push('"');
                    continue;
                }
            }
            // Not a key — copy verbatim.
            out.push_str(&s[start..i]);
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

fn state_from_disk(atom_path: &Path) -> Result<ReviewWorkflowState, AppError> {
    let fm = read_frontmatter(atom_path)?;
    let status = fm
        .get("status")
        .map(|s| dequote(s))
        .unwrap_or_else(|| "draft".to_string());
    let reviewers = fm.get("reviewers").map(parse_string_seq).unwrap_or_default();
    let votes = fm.get("votes").map(parse_votes).unwrap_or_default();
    let quorum = fm
        .get("quorum")
        .map(|s| dequote(s))
        .unwrap_or_else(|| "2/3".to_string());
    let deadline = fm.get("deadline").map(|s| dequote(s)).filter(|s| !s.is_empty());
    let proposer = fm.get("proposer").map(|s| dequote(s)).filter(|s| !s.is_empty());
    let proposed_at = fm
        .get("proposed_at")
        .map(|s| dequote(s))
        .unwrap_or_else(|| Utc::now().to_rfc3339());

    Ok(ReviewWorkflowState {
        atom_path: atom_path.to_string_lossy().to_string(),
        status,
        reviewers,
        votes,
        quorum,
        deadline,
        proposer,
        proposed_at,
    })
}

fn summarize(path: &Path, st: &ReviewWorkflowState) -> Option<AtomReviewSummary> {
    let title = extract_title(path).unwrap_or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("(untitled)")
            .to_string()
    });
    let n = st.reviewers.len() as u32;
    let cast = st.votes.len() as u32;
    let required = match st.quorum.as_str() {
        "unanimous" => n,
        "2/3" => (n * 2 + 2) / 3, // ceil(2n/3)
        "1/3" => 1,
        _ => n,
    };
    Some(AtomReviewSummary {
        atom_path: path.to_string_lossy().to_string(),
        atom_title: title,
        status: st.status.clone(),
        proposer: st.proposer.clone(),
        reviewers: st.reviewers.clone(),
        votes_cast: cast,
        votes_required: required,
        deadline: st.deadline.clone(),
        proposed_at: st.proposed_at.clone(),
    })
}

fn extract_title(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let body = strip_frontmatter(&raw);
    for line in body.lines() {
        let trimmed = line.trim_start_matches('#').trim();
        if !trimmed.is_empty() && line.trim_start().starts_with('#') {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn strip_frontmatter(raw: &str) -> &str {
    if !raw.starts_with("---") {
        return raw;
    }
    let mut lines = raw.lines();
    let _ = lines.next();
    let mut total = "---\n".len();
    for line in lines {
        total += line.len() + 1;
        if line.trim() == "---" {
            return &raw[total..];
        }
    }
    raw
}

fn walk_atoms<F>(memory_root: &Path, f: &mut F) -> Result<(), AppError>
where
    F: FnMut(&Path),
{
    // Walk team/decisions/* + team/*.md + agi/proposals/*.
    let candidates = [
        memory_root.join("team").join("decisions"),
        memory_root.join("team"),
        memory_root.join("agi").join("proposals"),
        memory_root.join("decisions"), // legacy flat layout
    ];
    for dir in candidates {
        if !dir.exists() {
            continue;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            f(&p);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::PathBuf;
    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_wf_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn seed_atom(memory_root: &Path, slug: &str) -> PathBuf {
        let dir = memory_root.join("team").join("decisions");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("{}.md", slug));
        std::fs::write(
            &p,
            "---\nstatus: draft\nauthor: alex\n---\n\n# Decision\n\nbody\n",
        )
        .unwrap();
        p
    }

    #[test]
    fn propose_writes_frontmatter() {
        let root = tmp_root();
        let atom = seed_atom(&root, "api");
        let st = propose(
            &atom,
            &["sam".to_string(), "hongyu".to_string(), "alex".to_string()],
            None,
            Some("2026-12-31T23:59:00Z"),
            Some("alex"),
        )
        .unwrap();
        assert_eq!(st.status, "under-review");
        assert_eq!(st.reviewers.len(), 3);
        let raw = std::fs::read_to_string(&atom).unwrap();
        assert!(raw.contains("status: under-review"));
        assert!(raw.contains("sam"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn vote_two_thirds_ratifies() {
        let root = tmp_root();
        let atom = seed_atom(&root, "ratify");
        propose(
            &atom,
            &["a".to_string(), "b".to_string(), "c".to_string()],
            None,
            None,
            Some("p"),
        )
        .unwrap();
        let s1 = vote(&atom, "a", WorkflowVote::Approve, None).unwrap();
        assert_eq!(s1.status, "under-review", "1/3 approves stays open");
        // 2/3 mode: 2 of 3 approves = 66% > 50% → ratified.
        let s2 = vote(&atom, "b", WorkflowVote::Approve, None).unwrap();
        assert_eq!(s2.status, "ratified");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn vote_unanimous_needs_all() {
        let root = tmp_root();
        let atom = seed_atom(&root, "unan");
        propose(
            &atom,
            &["a".to_string(), "b".to_string(), "c".to_string()],
            Some("unanimous"),
            None,
            Some("p"),
        )
        .unwrap();
        vote(&atom, "a", WorkflowVote::Approve, None).unwrap();
        vote(&atom, "b", WorkflowVote::Approve, None).unwrap();
        let s = vote(&atom, "c", WorkflowVote::Approve, None).unwrap();
        assert_eq!(s.status, "ratified");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn one_third_quorum_ratifies_on_first_approve() {
        let root = tmp_root();
        let atom = seed_atom(&root, "third");
        propose(
            &atom,
            &["a".to_string(), "b".to_string(), "c".to_string()],
            Some("1/3"),
            None,
            Some("p"),
        )
        .unwrap();
        let s = vote(&atom, "a", WorkflowVote::Approve, None).unwrap();
        assert_eq!(s.status, "ratified");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reject_majority_short_circuits() {
        let root = tmp_root();
        let atom = seed_atom(&root, "rej");
        propose(
            &atom,
            &["a".to_string(), "b".to_string(), "c".to_string()],
            None,
            None,
            Some("p"),
        )
        .unwrap();
        vote(&atom, "a", WorkflowVote::Reject, Some("nope")).unwrap();
        let s = vote(&atom, "b", WorkflowVote::Reject, None).unwrap();
        assert_eq!(s.status, "rejected");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn request_changes_blocks_ratification() {
        let root = tmp_root();
        let atom = seed_atom(&root, "rq");
        propose(
            &atom,
            &["a".to_string(), "b".to_string(), "c".to_string()],
            None,
            None,
            Some("p"),
        )
        .unwrap();
        vote(&atom, "a", WorkflowVote::Approve, None).unwrap();
        let s = vote(&atom, "b", WorkflowVote::RequestChanges, Some("concerns")).unwrap();
        // Even though 2/3 would normally ratify, request_changes blocks.
        assert_eq!(s.status, "under-review");
        // Replace request_changes with approve → ratifies.
        let s2 = vote(&atom, "b", WorkflowVote::Approve, None).unwrap();
        assert_eq!(s2.status, "ratified");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn revote_replaces_prior() {
        let root = tmp_root();
        let atom = seed_atom(&root, "revote");
        propose(
            &atom,
            &["a".to_string(), "b".to_string(), "c".to_string()],
            None,
            None,
            Some("p"),
        )
        .unwrap();
        vote(&atom, "a", WorkflowVote::Reject, None).unwrap();
        let s = vote(&atom, "a", WorkflowVote::Approve, None).unwrap();
        assert_eq!(s.votes.len(), 1);
        assert!(matches!(s.votes[0].vote, WorkflowVote::Approve));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn deadline_in_past_marks_expired() {
        let root = tmp_root();
        let atom = seed_atom(&root, "exp");
        propose(
            &atom,
            &["a".to_string(), "b".to_string(), "c".to_string()],
            None,
            Some("2000-01-01T00:00:00Z"),
            Some("p"),
        )
        .unwrap();
        // Single approve, deadline already past → expired (no quorum).
        let s = vote(&atom, "a", WorkflowVote::Approve, None).unwrap();
        assert_eq!(s.status, "expired");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_pending_filters_by_user() {
        let root = tmp_root();
        let a1 = seed_atom(&root, "p1");
        let a2 = seed_atom(&root, "p2");
        propose(&a1, &["alex".into(), "sam".into()], None, None, Some("h")).unwrap();
        propose(&a2, &["sam".into()], None, None, Some("h")).unwrap();
        // sam votes on a2 only.
        vote(&a2, "sam", WorkflowVote::Approve, None).unwrap();

        let pending_alex = list_pending_in(&root, Some("alex")).unwrap();
        assert_eq!(pending_alex.len(), 1);
        assert!(pending_alex[0].atom_path.contains("p1"));

        let pending_sam = list_pending_in(&root, Some("sam")).unwrap();
        assert_eq!(pending_sam.len(), 1, "sam still has a1 pending");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn non_reviewer_vote_rejected() {
        let root = tmp_root();
        let atom = seed_atom(&root, "outsider");
        propose(&atom, &["a".into()], None, None, Some("p")).unwrap();
        let err = vote(&atom, "outsider", WorkflowVote::Approve, None).unwrap_err();
        assert!(format!("{err:?}").contains("not_a_reviewer"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_by_status_returns_ratified() {
        let root = tmp_root();
        let a = seed_atom(&root, "rat");
        propose(&a, &["x".into(), "y".into(), "z".into()], None, None, Some("h")).unwrap();
        vote(&a, "x", WorkflowVote::Approve, None).unwrap();
        vote(&a, "y", WorkflowVote::Approve, None).unwrap();
        let ratified = list_by_status_in(&root, "ratified").unwrap();
        assert_eq!(ratified.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }
}
// === end wave 1.13-B ===
