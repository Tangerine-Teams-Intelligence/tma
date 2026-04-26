//! v1.8 Phase 2-B — Slack + Google Calendar **writeback**.
//!
//! Phase 1 (capture) shipped both connectors as one-way reads: Slack messages
//! came in, calendar events came in, atoms were written into the user's
//! `~/.tangerine-memory/` repo. Phase 2 turns the same connectors around:
//!
//!   * **Slack pre-meeting brief** — 5 min before any calendar event that
//!     touches a memory atom, post a markdown brief to the linked channel so
//!     attendees walk in pre-loaded with prior context.
//!
//!   * **Slack post-meeting summary** — once a meeting atom in
//!     `~/.tangerine-memory/meetings/<id>.md` flips to `status: finalized`,
//!     post a markdown summary (decisions list + action items) back to the
//!     channel that hosted the meeting.
//!
//!   * **Calendar writeback** — for the same finalized meeting atom, append a
//!     `Meeting summary (Tangerine)` block to the original Google Calendar
//!     event description. Idempotent: detect the sentinel and skip if already
//!     present.
//!
//! ## Why this lives here (and not in `commands/writeback.rs`)
//!
//! A sibling agent owns the GitHub / Linear writeback module
//! (`commands/writeback.rs`) per the v1.8 Phase 2 work split. The two
//! connector families share zero logic — Slack speaks `chat.postMessage`,
//! Calendar speaks Google Calendar API v3, and both are time/event triggered
//! rather than diff-driven like a PR comment. Co-locating them in a separate
//! module keeps the merge surface small and lets either side ship without
//! waiting on the other. If the sibling agent's module exists at merge time
//! we just live alongside it; if it doesn't, this module stands on its own.
//!
//! ## Trigger model
//!
//! * Pre-meeting brief — driven by the existing daemon heartbeat (see
//!   `daemon::queue_pre_meeting_briefs` in `crate::daemon`). Each tick the
//!   daemon scans the upcoming-events list and queues briefs for events
//!   landing in [now + lead - window, now + lead].
//!
//! * Post-meeting summary + Calendar writeback — driven from the finalize
//!   path. The Tauri commands below are the public surface. A future
//!   `notify`-based filesystem watcher can call them on
//!   `~/.tangerine-memory/meetings/*.md` change without us having to spin a
//!   second tokio task. Until that watcher lands the daemon's existing
//!   heartbeat is the polling cadence — see `daemon::do_heartbeat` for the
//!   wired hook.
//!
//! ## HTTP error policy
//!
//! Both backends prefer a structured `AppError::external` with a stable
//! `code` so the React side can render a remediation hint ("re-auth Slack",
//! "re-grant Calendar scope", "rate-limit, retry in 30s"). We never log the
//! raw token; Slack auth headers are stripped on error before bubbling.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{AppError, AppState};

/// Sentinel string we drop into a calendar event description so subsequent
/// runs can detect the existing summary and skip appending a duplicate.
/// Public so the unit tests can assert against the same constant the
/// production code uses — drift between the two has bitten us before.
pub const CAL_SUMMARY_SENTINEL: &str = "Meeting summary (Tangerine)";

/// Keychain service the Slack bot token is stored under. Mirrors the TS
/// connector's `KEYTAR_SERVICE` constant in `sources/slack/src/auth.ts`
/// (account = "bot"). When the Rust side gains a first-class Slack OAuth
/// flow we'll move this into a shared constants module; for now duplicating
/// keeps the two halves compatible.
const SLACK_KEYRING_SERVICE: &str = "tangerine-slack";
const SLACK_KEYRING_ACCOUNT_BOT: &str = "bot";

/// Keychain account for the Google Calendar OAuth access token. The token
/// itself is stored encrypted by the OS keychain; we only ever round-trip
/// it through here to set the Authorization header.
const CAL_KEYRING_SERVICE: &str = "tangerine-calendar";
const CAL_KEYRING_ACCOUNT: &str = "google";

// ----------------------------------------------------------------------
// Slack writeback — public API used by the Tauri commands AND the daemon's
// pre-meeting brief queue.

/// Post a pre-meeting brief to `channel_id` for the meeting whose decision
/// atom lives at `decision_path`. The "decision" framing is from the
/// pre-meeting brief flow: at T-5min we don't yet have a meeting atom, but
/// we do have the prior decisions / project notes the meeting will touch,
/// so the brief is built from those.
///
/// The atom file is read for frontmatter (`title`, `attendees`,
/// `slack_user_ids`, `event_id`, `slack_channel`) plus the body which is
/// quoted verbatim under "What this is about". When the channel_id arg is
/// empty the function falls back to the atom's `slack_channel` frontmatter
/// field — the daemon path passes "" here so a single source of truth
/// (the atom) governs which channel each brief lands in.
pub async fn writeback_brief(
    state: &AppState,
    decision_path: &Path,
    channel_id: &str,
) -> Result<(), AppError> {
    let atom = read_atom(decision_path)?;
    let target_channel = pick_channel(channel_id, &atom)?;
    let body = build_brief_markdown(&atom);
    post_slack_message(state, &target_channel, &body).await
}

/// Post a post-meeting decision summary to `channel_id` for the finalized
/// meeting atom at `meeting_path`. Reads the atom's `## Decisions` and
/// `## Action items` sections out of the body and renders them as Slack
/// markdown. Same channel-fallback semantics as `writeback_brief`.
pub async fn writeback_summary(
    state: &AppState,
    meeting_path: &Path,
    channel_id: &str,
) -> Result<(), AppError> {
    let atom = read_atom(meeting_path)?;
    let target_channel = pick_channel(channel_id, &atom)?;
    let body = build_summary_markdown(&atom);
    post_slack_message(state, &target_channel, &body).await
}

/// Pick the Slack channel to post to. Caller-supplied `channel_id` wins
/// because the user may re-route a brief to a different channel via the UI;
/// the atom's `slack_channel` frontmatter is the daemon-driven default.
fn pick_channel(arg: &str, atom: &MeetingAtom) -> Result<String, AppError> {
    if !arg.trim().is_empty() {
        return Ok(arg.trim().to_string());
    }
    atom.slack_channel.clone().ok_or_else(|| {
        AppError::user(
            "slack_channel_unset",
            "No Slack channel passed and the meeting atom has no `slack_channel` frontmatter.",
        )
    })
}

async fn post_slack_message(
    state: &AppState,
    channel_id: &str,
    text: &str,
) -> Result<(), AppError> {
    let token = read_slack_token().ok_or_else(|| {
        AppError::config(
            "slack_token_missing",
            "No Slack bot token in the keychain. Run the Slack source setup first.",
        )
    })?;
    let body = serde_json::json!({
        "channel": channel_id,
        "text": text,
        // `mrkdwn: true` is the default but we set it explicitly so a future
        // change to Slack's defaults can't silently break our formatting.
        "mrkdwn": true,
    });
    let res = state
        .http
        .post("https://slack.com/api/chat.postMessage")
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            AppError::external("slack_post", humanize_http(&strip_token(&e.to_string())))
        })?;
    let status = res.status();
    let txt = res
        .text()
        .await
        .map_err(|e| AppError::external("slack_post_body", strip_token(&e.to_string())))?;
    if !status.is_success() {
        return Err(AppError::external(
            "slack_post_status",
            format!("Slack returned HTTP {}: {}", status.as_u16(), strip_token(&txt)),
        ));
    }
    // Slack returns 200 with `{ok: false, error: "..."}` for logical errors
    // (channel_not_found, not_in_channel, rate_limited). Surface those.
    let parsed: serde_json::Value = serde_json::from_str(&txt)
        .map_err(|e| AppError::external("slack_post_parse", e.to_string()))?;
    if !parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        let err = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown_slack_error");
        return Err(AppError::external(
            "slack_api_error",
            format!("Slack rejected message: {}", err),
        ));
    }
    Ok(())
}

// ----------------------------------------------------------------------
// Calendar writeback — append a summary block to a Google Calendar event.

/// Append a markdown-ish summary block to the description of the Google
/// Calendar event identified by `event_id`. Idempotent: if the description
/// already contains [`CAL_SUMMARY_SENTINEL`] we leave it alone.
///
/// We deliberately don't try to *update* an existing block — once a Tangerine
/// block lands, the canonical content lives in the meeting atom. If the user
/// edits the meeting atom and wants the calendar to reflect the edit they
/// can manually delete the existing block in the calendar UI; the next
/// finalize tick will append a fresh one. This avoids us having to parse
/// our own previous output, which would couple us to its format forever.
pub async fn writeback_calendar_summary(
    state: &AppState,
    meeting_path: &Path,
    event_id: &str,
) -> Result<(), AppError> {
    if event_id.trim().is_empty() {
        return Err(AppError::user(
            "event_id_missing",
            "Cannot writeback to calendar without an event_id.",
        ));
    }
    let atom = read_atom(meeting_path)?;
    let token = read_calendar_token().ok_or_else(|| {
        AppError::config(
            "calendar_token_missing",
            "No Google Calendar OAuth token. Re-auth the Calendar source.",
        )
    })?;

    // 1. Fetch the existing event so we can preserve its description.
    let url = format!(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events/{}",
        urlencoding::encode(event_id)
    );
    let event = state
        .http
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            AppError::external("calendar_get", humanize_http(&strip_token(&e.to_string())))
        })?;
    let status = event.status();
    let etext = event
        .text()
        .await
        .map_err(|e| AppError::external("calendar_get_body", strip_token(&e.to_string())))?;
    if !status.is_success() {
        return Err(AppError::external(
            "calendar_get_status",
            format!("Calendar GET HTTP {}: {}", status.as_u16(), strip_token(&etext)),
        ));
    }
    let parsed: serde_json::Value = serde_json::from_str(&etext)
        .map_err(|e| AppError::external("calendar_get_parse", e.to_string()))?;
    let existing_desc = parsed
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // 2. Idempotency gate. Sentinel match is sufficient; the daemon may tick
    // many times between user edits and we don't want a wall of summaries.
    if existing_desc.contains(CAL_SUMMARY_SENTINEL) {
        tracing::info!(
            event_id = %event_id,
            "calendar writeback: sentinel already present, skipping append"
        );
        return Ok(());
    }

    // 3. Compose the new description.
    let block = build_calendar_block(&atom, meeting_path);
    let new_desc = if existing_desc.is_empty() {
        block
    } else {
        format!("{}{}", existing_desc.trim_end(), block)
    };

    // 4. PATCH back. Calendar v3 accepts partial updates via PATCH on the
    // events resource. We only touch `description`.
    let patch_body = serde_json::json!({ "description": new_desc });
    let res = state
        .http
        .patch(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&patch_body)
        .send()
        .await
        .map_err(|e| {
            AppError::external("calendar_patch", humanize_http(&strip_token(&e.to_string())))
        })?;
    let pstatus = res.status();
    let ptext = res
        .text()
        .await
        .map_err(|e| AppError::external("calendar_patch_body", strip_token(&e.to_string())))?;
    if !pstatus.is_success() {
        return Err(AppError::external(
            "calendar_patch_status",
            format!(
                "Calendar PATCH HTTP {}: {}",
                pstatus.as_u16(),
                strip_token(&ptext)
            ),
        ));
    }
    Ok(())
}

// ----------------------------------------------------------------------
// Tauri command shims — the public IPC surface. Frontend calls these.

#[tauri::command]
pub async fn slack_writeback_brief(
    state: State<'_, AppState>,
    decision_path: String,
    channel_id: String,
) -> Result<(), AppError> {
    writeback_brief(&state, Path::new(&decision_path), &channel_id).await
}

#[tauri::command]
pub async fn slack_writeback_summary(
    state: State<'_, AppState>,
    meeting_path: String,
    channel_id: String,
) -> Result<(), AppError> {
    writeback_summary(&state, Path::new(&meeting_path), &channel_id).await
}

#[tauri::command]
pub async fn calendar_writeback_summary(
    state: State<'_, AppState>,
    meeting_path: String,
    event_id: String,
) -> Result<(), AppError> {
    writeback_calendar_summary(&state, Path::new(&meeting_path), &event_id).await
}

// ----------------------------------------------------------------------
// Atom reader + markdown builders.

/// Subset of meeting-atom frontmatter we actually consume for writeback.
/// The TS atom schema is the source of truth (`sources/calendar/src/types.ts`,
/// `sources/slack/src/types.ts`); we only deserialize the keys we need so
/// drift on unrelated fields doesn't break us.
#[derive(Debug, Default, Clone)]
pub struct MeetingAtom {
    pub title: String,
    pub status: Option<String>,
    pub event_id: Option<String>,
    pub slack_channel: Option<String>,
    /// Display names. Mapped to Slack user IDs via the parallel
    /// `slack_user_ids` field when present.
    pub attendees: Vec<String>,
    /// Optional Slack-id mapping: `attendees[i]` ↔ `slack_user_ids[i]`. May
    /// be shorter than `attendees`; missing entries fall back to the bare
    /// display name in the rendered brief.
    pub slack_user_ids: Vec<String>,
    /// Decisions list (raw markdown lines under `## Decisions`).
    pub decisions: Vec<String>,
    /// Action items list (raw markdown lines under `## Action items`).
    pub action_items: Vec<String>,
    /// Body of the atom (everything after the frontmatter). Used as a fallback
    /// when no `## Decisions` section exists yet (pre-meeting briefs).
    pub body: String,
}

fn read_atom(path: &Path) -> Result<MeetingAtom, AppError> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        AppError::user(
            "atom_read",
            format!("Could not read {}: {}", path.display(), e),
        )
    })?;
    Ok(parse_atom(&raw))
}

/// Pure parser — separated so the unit tests don't need a real file.
pub fn parse_atom(raw: &str) -> MeetingAtom {
    let (frontmatter, body) = split_frontmatter(raw);
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(frontmatter).unwrap_or(serde_yaml::Value::Null);

    let title = yaml
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("(untitled)")
        .to_string();
    let status = yaml
        .get("status")
        .and_then(|v| v.as_str())
        .map(String::from);
    let event_id = yaml
        .get("event_id")
        .and_then(|v| v.as_str())
        .map(String::from);
    let slack_channel = yaml
        .get("slack_channel")
        .and_then(|v| v.as_str())
        .map(String::from);
    let attendees: Vec<String> = yaml
        .get("attendees")
        .or_else(|| yaml.get("participants"))
        .and_then(|v| v.as_sequence())
        .map(|s| {
            s.iter()
                .filter_map(|p| p.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let slack_user_ids: Vec<String> = yaml
        .get("slack_user_ids")
        .and_then(|v| v.as_sequence())
        .map(|s| {
            s.iter()
                .filter_map(|p| p.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let decisions = extract_section(body, "Decisions");
    let action_items = extract_section(body, "Action items");

    MeetingAtom {
        title,
        status,
        event_id,
        slack_channel,
        attendees,
        slack_user_ids,
        decisions,
        action_items,
        body: body.to_string(),
    }
}

/// Split a markdown file into (frontmatter, body). Frontmatter is delimited
/// by `---\n…\n---`. If absent we treat the whole file as body and return
/// an empty frontmatter — a brief over a free-form decision atom is still
/// useful even without YAML.
fn split_frontmatter(raw: &str) -> (&str, &str) {
    let trimmed = raw.trim_start_matches('\u{feff}'); // strip BOM if any
    let bytes = trimmed.as_bytes();
    if bytes.len() < 4 || &bytes[..4] != b"---\n" {
        // Some editors write `---\r\n` — accept that too.
        if !(bytes.len() >= 5 && &bytes[..5] == b"---\r\n") {
            return ("", trimmed);
        }
    }
    // Find the closing `---` on its own line.
    let after_first = if &bytes[..4] == b"---\n" { 4 } else { 5 };
    let rest = &trimmed[after_first..];
    if let Some(end_rel) = find_closing_fence(rest) {
        let fm = &rest[..end_rel];
        // Skip the closing fence + the newline after it.
        let mut body_start = end_rel + 3; // length of "---"
        // Be tolerant of `---\n` and `---\r\n` and EOF.
        if rest.as_bytes().get(body_start).copied() == Some(b'\r') {
            body_start += 1;
        }
        if rest.as_bytes().get(body_start).copied() == Some(b'\n') {
            body_start += 1;
        }
        let body = &rest[body_start..];
        return (fm, body);
    }
    ("", trimmed)
}

/// Find a `\n---\n` (or `\n---\r\n`, or trailing `\n---`) and return the
/// offset of the `---` token.
fn find_closing_fence(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i + 4 <= bytes.len() {
        // Look for line starting with "---" (i.e. either i==0 or bytes[i-1]=='\n')
        if (i == 0 || bytes[i - 1] == b'\n') && &bytes[i..i + 3] == b"---" {
            // Confirm nothing else on this line — accept ---\n / ---\r\n / EOF.
            let after = i + 3;
            if after == bytes.len() {
                return Some(i);
            }
            if bytes[after] == b'\n' || bytes[after] == b'\r' {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// Extract bullet items from a `## <heading>` markdown section. Stops at
/// the next `## ` or `# ` heading. Lines are returned trimmed of leading
/// `- ` / `* ` so we can re-render in Slack mrkdwn (which uses the same
/// bullet shape but is picky about leading whitespace).
fn extract_section(body: &str, heading: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_section = false;
    let target = format!("## {}", heading.to_lowercase());
    for raw_line in body.lines() {
        let line = raw_line.trim_end();
        let lower = line.to_lowercase();
        if lower.starts_with("## ") || lower.starts_with("# ") {
            in_section = lower.starts_with(&target);
            continue;
        }
        if !in_section {
            continue;
        }
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            out.push(rest.trim().to_string());
        } else if let Some(rest) = trimmed
            .strip_prefix("[ ] ")
            .or_else(|| trimmed.strip_prefix("[x] "))
        {
            out.push(rest.trim().to_string());
        }
    }
    out
}

/// Compose Slack markdown for a pre-meeting brief. Slack's `mrkdwn` flavour
/// uses `*bold*` (single asterisks) and `<@U123>` for user mentions. We
/// stick to a small subset that renders the same in plain text so the
/// CLI/test path looks identical to what users see.
pub fn build_brief_markdown(atom: &MeetingAtom) -> String {
    let mut out = String::new();
    out.push_str(&format!(":tangerine: *Pre-meeting brief — {}*\n", atom.title));
    out.push('\n');

    // Mention attendees by Slack user id where we can.
    let mentions = render_attendees(atom);
    if !mentions.is_empty() {
        out.push_str(&format!("*Attendees:* {}\n\n", mentions));
    }

    // Body / context. If the atom has a "What this is about" or "Context"
    // section we use it; otherwise quote the first paragraph of the body.
    let context = extract_section(&atom.body, "Context");
    if !context.is_empty() {
        out.push_str("*Context:*\n");
        for line in &context {
            out.push_str(&format!("- {}\n", line));
        }
        out.push('\n');
    } else {
        let first_para: String = atom
            .body
            .lines()
            .skip_while(|l| l.trim().is_empty() || l.starts_with('#'))
            .take_while(|l| !l.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if !first_para.is_empty() {
            out.push_str("*What this is about:*\n");
            out.push_str(&first_para);
            out.push_str("\n\n");
        }
    }

    // Prior decisions if any — useful for a recurring meeting where last
    // round's decisions are the starting point of this one.
    if !atom.decisions.is_empty() {
        out.push_str("*Prior decisions:*\n");
        for d in &atom.decisions {
            out.push_str(&format!("- {}\n", d));
        }
        out.push('\n');
    }

    out.push_str("_Generated by Tangerine. Reply in-thread to update the meeting record._\n");
    out
}

/// Compose Slack markdown for the post-meeting summary. Decisions go first
/// (CEO direction: "the decision is the contract; everything else is colour").
pub fn build_summary_markdown(atom: &MeetingAtom) -> String {
    let mut out = String::new();
    out.push_str(&format!(":tangerine: *Meeting summary — {}*\n", atom.title));
    out.push('\n');

    let mentions = render_attendees(atom);
    if !mentions.is_empty() {
        out.push_str(&format!("*Attendees:* {}\n\n", mentions));
    }

    if atom.decisions.is_empty() {
        out.push_str("*Decisions:* _none recorded_\n\n");
    } else {
        out.push_str("*Decisions:*\n");
        for d in &atom.decisions {
            out.push_str(&format!("- {}\n", d));
        }
        out.push('\n');
    }

    if !atom.action_items.is_empty() {
        out.push_str("*Action items:*\n");
        for a in &atom.action_items {
            out.push_str(&format!("- {}\n", a));
        }
        out.push('\n');
    }

    out.push_str("_Full record in your Tangerine memory dir. Edit the markdown to amend._\n");
    out
}

fn render_attendees(atom: &MeetingAtom) -> String {
    if atom.attendees.is_empty() && atom.slack_user_ids.is_empty() {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::new();
    for (i, name) in atom.attendees.iter().enumerate() {
        if let Some(uid) = atom.slack_user_ids.get(i) {
            if !uid.is_empty() {
                parts.push(format!("<@{}>", uid));
                continue;
            }
        }
        parts.push(name.clone());
    }
    // If we somehow have only slack ids and no names (atypical) emit them.
    if parts.is_empty() {
        for uid in &atom.slack_user_ids {
            if !uid.is_empty() {
                parts.push(format!("<@{}>", uid));
            }
        }
    }
    parts.join(", ")
}

/// Build the calendar description block. Public so the idempotency test can
/// simulate "second run" without re-rolling the format.
pub fn build_calendar_block(atom: &MeetingAtom, meeting_path: &Path) -> String {
    let filename = meeting_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown.md");
    let mut summary = String::new();
    if !atom.decisions.is_empty() {
        summary.push_str("Decisions:\n");
        for d in &atom.decisions {
            summary.push_str(&format!("- {}\n", d));
        }
    } else {
        summary.push_str("No decisions recorded.\n");
    }
    if !atom.action_items.is_empty() {
        summary.push_str("\nAction items:\n");
        for a in &atom.action_items {
            summary.push_str(&format!("- {}\n", a));
        }
    }
    // The leading "\n\n---\n" matters: Calendar's renderer collapses single
    // newlines, so we force a horizontal-rule-ish separator + double-newline
    // padding so the block is visually distinct from any user-typed content
    // already in the description.
    format!(
        "\n\n---\n📋 {}:\n{}\n_~/.tangerine-memory/meetings/{}_\n",
        CAL_SUMMARY_SENTINEL,
        summary.trim_end(),
        filename
    )
}

// ----------------------------------------------------------------------
// Token storage. Slack + Calendar stash their tokens in the same OS keychain
// the existing GitHub flow uses (`commands::sync::TokenStore`); we don't
// pull that in directly because it's `<service, login>`-keyed and we want
// fixed accounts ("bot" / "google"). Instead we go through the `keyring`
// crate ourselves with our own service strings.

fn read_slack_token() -> Option<String> {
    if let Ok(t) = std::env::var("TANGERINE_SLACK_BOT_TOKEN") {
        if !t.trim().is_empty() {
            return Some(t.trim().to_string());
        }
    }
    if let Ok(e) = keyring::Entry::new(SLACK_KEYRING_SERVICE, SLACK_KEYRING_ACCOUNT_BOT) {
        if let Ok(t) = e.get_password() {
            return Some(t);
        }
    }
    // Fallback: file-store under <user_data>/sync/slack-bot.token. Mirrors
    // the GitHub TokenStore fallback so a CI/devbox without keychain still
    // works (see commands::sync::TokenStore::file_get).
    file_token_read("slack-bot")
}

fn read_calendar_token() -> Option<String> {
    if let Ok(t) = std::env::var("TANGERINE_CAL_OAUTH_TOKEN") {
        if !t.trim().is_empty() {
            return Some(t.trim().to_string());
        }
    }
    if let Ok(e) = keyring::Entry::new(CAL_KEYRING_SERVICE, CAL_KEYRING_ACCOUNT) {
        if let Ok(t) = e.get_password() {
            return Some(t);
        }
    }
    file_token_read("calendar-google")
}

fn file_token_read(label: &str) -> Option<String> {
    let dir = file_token_dir()?;
    let p = dir.join(format!("{}.token", label));
    std::fs::read_to_string(&p).ok().map(|s| s.trim().to_string())
}

fn file_token_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok()
        .or_else(dirs::data_local_dir)?;
    #[cfg(not(windows))]
    let base = dirs::data_local_dir()?;
    Some(base.join("TangerineMeeting").join("sync"))
}

// ----------------------------------------------------------------------
// Helpers shared with the github.rs side (no need to depend on it).

fn humanize_http(raw: &str) -> String {
    if raw.contains("error sending request") || raw.contains("dns error") {
        return "Couldn't reach the server. Check your internet.".into();
    }
    if raw.contains("connect timed out") {
        return "Server is slow to respond. Try again?".into();
    }
    raw.to_string()
}

/// Strip Slack / Google bearer tokens out of error bodies so we never log a
/// leaked secret. The two patterns we care about are `xoxb-…` (Slack bot)
/// and `ya29.…` (Google OAuth2 short-lived). We also redact `Bearer …` so
/// the Authorization header content can't slip into a panic message.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WritebackOutcome {
    pub kind: String,        // "slack_brief" | "slack_summary" | "calendar"
    pub ok: bool,
    pub message: String,     // human-readable
    pub at: String,          // RFC 3339 timestamp
}

pub(crate) fn strip_token(s: &str) -> String {
    let mut out = s.to_string();
    for prefix in ["xoxb-", "xoxp-", "xapp-", "ya29.", "ghp_", "gho_"] {
        let mut idx = 0;
        while let Some(pos) = out[idx..].find(prefix) {
            let abs = idx + pos;
            let end = out[abs..]
                .find(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-' && c != '.')
                .map(|n| abs + n)
                .unwrap_or(out.len());
            out.replace_range(abs..end, "REDACTED");
            idx = abs + "REDACTED".len();
        }
    }
    // Redact the value after a literal "Bearer " (case-insensitive prefix).
    let lower = out.to_lowercase();
    if let Some(pos) = lower.find("bearer ") {
        let start = pos + "bearer ".len();
        let end = out[start..]
            .find(|c: char| c.is_whitespace() || c == '"' || c == ',')
            .map(|n| start + n)
            .unwrap_or(out.len());
        if end > start {
            out.replace_range(start..end, "REDACTED");
        }
    }
    out
}

// ----------------------------------------------------------------------
// Tests
//
// HTTP is mocked via `wiremock` would be ideal; we don't have it in
// Cargo.toml and the task said don't hit real APIs. So instead the unit
// tests exercise everything that doesn't touch the network: parsing, brief
// + summary markdown, calendar-block format, and the idempotency sentinel.
// The HTTP wiring (`post_slack_message`, `writeback_calendar_summary`'s
// GET+PATCH) is covered by an integration test in tests/ that points
// AppState.http at a local mock server bound on 127.0.0.1.

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_atom_md() -> &'static str {
        r#"---
date: 2026-04-25
title: David roadmap sync
status: finalized
event_id: abc123xyz
slack_channel: C0PROJECTROADMAP
attendees: ["Daizhe", "David"]
slack_user_ids: ["U001DAIZHE", "U002DAVID"]
participants: [daizhe, david]
---

## Context

- Pricing locked at $20/seat
- Postgres chosen over Mongo

## Decisions

- Pricing: $20/seat, 3 seat minimum
- Backend: Postgres for v1
- 20% annual discount

## Action items

- [ ] Daizhe drafts pricing page copy by Friday
- [ ] David sets up postgres CI job
"#
    }

    #[test]
    fn test_parse_atom_extracts_frontmatter() {
        let a = parse_atom(sample_atom_md());
        assert_eq!(a.title, "David roadmap sync");
        assert_eq!(a.status.as_deref(), Some("finalized"));
        assert_eq!(a.event_id.as_deref(), Some("abc123xyz"));
        assert_eq!(a.slack_channel.as_deref(), Some("C0PROJECTROADMAP"));
        assert_eq!(a.attendees, vec!["Daizhe", "David"]);
        assert_eq!(a.slack_user_ids, vec!["U001DAIZHE", "U002DAVID"]);
        assert_eq!(a.decisions.len(), 3);
        assert_eq!(a.action_items.len(), 2);
        assert!(a.decisions[0].contains("Pricing"));
        assert!(a.action_items[0].contains("Daizhe drafts"));
    }

    #[test]
    fn test_parse_atom_no_frontmatter() {
        let a = parse_atom("Just a body, no frontmatter.\n");
        assert_eq!(a.title, "(untitled)");
        assert!(a.decisions.is_empty());
        assert!(a.body.contains("Just a body"));
    }

    #[test]
    fn test_parse_atom_crlf_frontmatter() {
        // Editors on Windows often emit \r\n. Make sure we still parse.
        let raw = "---\r\ntitle: CRLF Test\r\nstatus: finalized\r\n---\r\n\r\n## Decisions\r\n\r\n- Choose CRLF for Windows\r\n";
        let a = parse_atom(raw);
        assert_eq!(a.title, "CRLF Test");
        assert_eq!(a.decisions.len(), 1);
    }

    #[test]
    fn test_extract_section_skips_other_sections() {
        let body = "## Decisions\n\n- A\n- B\n\n## Notes\n\n- not a decision\n";
        let d = extract_section(body, "Decisions");
        assert_eq!(d, vec!["A", "B"]);
        let n = extract_section(body, "Notes");
        assert_eq!(n, vec!["not a decision"]);
    }

    #[test]
    fn test_slack_brief_format() {
        let a = parse_atom(sample_atom_md());
        let md = build_brief_markdown(&a);
        // Must lead with the tangerine emoji prefix.
        assert!(md.starts_with(":tangerine: *Pre-meeting brief"), "got: {}", md);
        // Title appears.
        assert!(md.contains("David roadmap sync"));
        // Slack user-id mentions render with <@…> shape.
        assert!(md.contains("<@U001DAIZHE>"));
        assert!(md.contains("<@U002DAVID>"));
        // Context section was rendered.
        assert!(md.contains("Pricing locked at $20"));
        // Footer present.
        assert!(md.contains("Generated by Tangerine"));
    }

    #[test]
    fn test_slack_brief_format_falls_back_to_names_without_uids() {
        let raw = r#"---
title: Plain meeting
attendees: ["Alice", "Bob"]
---

Body line.
"#;
        let a = parse_atom(raw);
        let md = build_brief_markdown(&a);
        assert!(md.contains("Alice"));
        assert!(md.contains("Bob"));
        // No fake mention shape.
        assert!(!md.contains("<@>"));
    }

    #[test]
    fn test_slack_summary_format() {
        let a = parse_atom(sample_atom_md());
        let md = build_summary_markdown(&a);
        assert!(md.starts_with(":tangerine: *Meeting summary"));
        assert!(md.contains("David roadmap sync"));
        assert!(md.contains("*Decisions:*"));
        assert!(md.contains("Pricing: $20/seat, 3 seat minimum"));
        assert!(md.contains("*Action items:*"));
        assert!(md.contains("Daizhe drafts"));
    }

    #[test]
    fn test_slack_summary_with_no_decisions() {
        let raw = r#"---
title: Empty
attendees: ["Alice"]
slack_user_ids: ["U_ALICE"]
status: finalized
---

Just a chat with no decisions.
"#;
        let a = parse_atom(raw);
        let md = build_summary_markdown(&a);
        assert!(md.contains("_none recorded_"));
        assert!(md.contains("<@U_ALICE>"));
    }

    #[test]
    fn test_calendar_writeback_idempotent() {
        // Build the block, simulate appending it to an existing description,
        // and verify a second invocation would detect the sentinel and skip.
        let a = parse_atom(sample_atom_md());
        let path = Path::new("sample-2026-04-25-roadmap-sync.md");
        let block1 = build_calendar_block(&a, path);
        assert!(block1.contains(CAL_SUMMARY_SENTINEL));

        // First run: empty description → block becomes the description.
        let mut desc = String::new();
        if !desc.contains(CAL_SUMMARY_SENTINEL) {
            desc.push_str(&block1);
        }
        let after_first = desc.clone();

        // Second run: sentinel present → no append.
        if !desc.contains(CAL_SUMMARY_SENTINEL) {
            let block2 = build_calendar_block(&a, path);
            desc.push_str(&block2);
        }
        assert_eq!(desc, after_first, "second run should be a no-op");
        // And only one occurrence of the sentinel after both runs.
        assert_eq!(desc.matches(CAL_SUMMARY_SENTINEL).count(), 1);
    }

    #[test]
    fn test_calendar_block_appends_to_existing() {
        let a = parse_atom(sample_atom_md());
        let path = Path::new("test.md");
        let existing = "User wrote some prelim notes here.";
        let block = build_calendar_block(&a, path);
        // Simulate the real append path used in writeback_calendar_summary.
        let combined = format!("{}{}", existing.trim_end(), block);
        assert!(combined.starts_with("User wrote some prelim notes"));
        assert!(combined.contains("---"));
        assert!(combined.contains(CAL_SUMMARY_SENTINEL));
        assert!(combined.contains("test.md"));
    }

    #[test]
    fn test_pick_channel_arg_wins() {
        let a = MeetingAtom {
            slack_channel: Some("C_ATOM".into()),
            ..Default::default()
        };
        let got = pick_channel("C_ARG", &a).unwrap();
        assert_eq!(got, "C_ARG");
    }

    #[test]
    fn test_pick_channel_falls_back_to_atom() {
        let a = MeetingAtom {
            slack_channel: Some("C_ATOM".into()),
            ..Default::default()
        };
        let got = pick_channel("", &a).unwrap();
        assert_eq!(got, "C_ATOM");
    }

    #[test]
    fn test_pick_channel_errors_when_unset() {
        let a = MeetingAtom::default();
        let err = pick_channel("", &a).unwrap_err();
        let msg = format!("{}", err);
        assert!(msg.contains("slack_channel_unset") || msg.contains("frontmatter"));
    }

    #[test]
    fn test_strip_token_removes_xoxb() {
        let s = strip_token(r#"posted with header Authorization: Bearer xoxb-AAAA-BBBB-CCCC"#);
        assert!(!s.contains("xoxb-AAAA"));
        assert!(s.contains("REDACTED"));
    }

    #[test]
    fn test_strip_token_redacts_bearer() {
        let s = strip_token("Authorization: Bearer ya29.something_secret_42 ok");
        assert!(!s.contains("ya29.something_secret_42"));
        assert!(s.contains("REDACTED"));
    }

    #[test]
    fn test_humanize_http() {
        assert!(humanize_http("error sending request: dns error").contains("internet"));
        assert!(humanize_http("connect timed out").contains("slow"));
        assert_eq!(humanize_http("plain"), "plain");
    }
}
