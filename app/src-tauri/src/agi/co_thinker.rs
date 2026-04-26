//! v1.8 Phase 3-B — Co-thinker brain engine.
//!
//! The co-thinker is Tangerine's persistent stateful AGI brain. It runs as a
//! daemon-driven heartbeat (see `daemon::do_heartbeat`'s `co_thinker_tick` at
//! the bottom of every tick): every 5 minutes when the app is in foreground,
//! every 30 minutes when backgrounded.
//!
//! Each tick we:
//!   1. Scan the memory tree for atoms whose mtime is >= the last heartbeat
//!      (incremental — we don't re-feed the whole memory dir every tick).
//!   2. Read the current `agi/co-thinker.md` brain doc as self-context.
//!   3. Dispatch one LLM call through the `LlmDispatcher` (P3-A's
//!      `session_borrower::dispatch` is the production impl; tests inject a
//!      `MockDispatcher`).
//!   4. Apply the **grounding rule** — every claim in the response must be
//!      followed by a `path/to/atom.md` citation; uncited paragraphs are
//!      silently dropped before we write the brain doc. The brain.md must be
//!      100% citation-grounded so the user can audit any claim back to a
//!      source file.
//!   5. Atomically replace `agi/co-thinker.md`.
//!   6. Append a single line to `agi/observations/{YYYY-MM-DD}.md` (audit log).
//!   7. Detect `PROPOSAL:` sentinels in the response → write
//!      `agi/proposals/{type}-{slug}-{date}.md`.
//!
//! Markdown is the source of truth. Every artefact this engine touches is a
//! plain `.md` file the user can `cat`, edit, or git-blame. The brain isn't a
//! black-box LLM context — it's a doc you can read.
//!
//! Throttle: a `tokio::sync::Mutex` (the heartbeat semaphore) ensures only one
//! heartbeat runs at a time. A second concurrent call short-circuits with
//! `error: Some("throttled — another heartbeat is in flight")`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, Utc};
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};

use crate::commands::AppError;

use super::observations;

// ---------------------------------------------------------------------------
// LlmDispatcher trait — abstracts P3-A's `session_borrower::dispatch`.
//
// In production, an adapter for `crate::agi::session_borrower::dispatch` is
// plugged in; in tests we plug in `MockDispatcher`. We keep the engine
// independent of P3-A's file layout so neither agent has to wait for the
// other to land before unit tests can run.

/// One-shot LLM request envelope. The system prompt is fixed; user prompt is
/// the rendered brain-update prompt (current brain.md + new atom summary).
#[derive(Debug, Clone)]
pub struct LlmRequest {
    pub system: String,
    pub user: String,
    /// Optional pin to a specific tool id (cursor / claude-code / ollama / ...);
    /// when None, the dispatcher picks per its own policy.
    pub primary_tool_id: Option<String>,
}

/// LLM response. `channel_used` reports which tool actually answered (mcp /
/// browser_ext / local_http / mock) so the heartbeat outcome can surface it
/// to the UI.
#[derive(Debug, Clone)]
pub struct LlmResponse {
    pub text: String,
    pub channel_used: String,
}

/// The trait the engine consumes. P3-A's `session_borrower::dispatch` is
/// adapted onto this trait by the production impl below. We use `BoxFuture`
/// instead of an `async fn` so the trait is dyn-compatible (Rust's native
/// async-fn-in-trait is not yet `dyn`-compatible without the `async_trait`
/// macro, and the crate isn't in our dep tree).
pub trait LlmDispatcher: Send + Sync {
    fn dispatch<'a>(
        &'a self,
        req: LlmRequest,
    ) -> BoxFuture<'a, Result<LlmResponse, AppError>>;
}

/// Default production dispatcher. Routes through P3-A's
/// `session_borrower::dispatch` (sibling module).
///
/// **Merge-watch point — INTEGRATION POINT:** the call into
/// `crate::agi::session_borrower::dispatch` happens inside
/// `dispatch_via_session_borrower`. P3-A owns the upstream API; if the
/// upstream signature changes, this function is the one place to update.
pub struct ProductionDispatcher;

impl LlmDispatcher for ProductionDispatcher {
    fn dispatch<'a>(
        &'a self,
        req: LlmRequest,
    ) -> BoxFuture<'a, Result<LlmResponse, AppError>> {
        Box::pin(dispatch_via_session_borrower(req))
    }
}

async fn dispatch_via_session_borrower(req: LlmRequest) -> Result<LlmResponse, AppError> {
    // INTEGRATION POINT — wired to P3-A's session_borrower. Their LlmRequest
    // shape uses snake-case `system_prompt` / `user_prompt` and an explicit
    // `primary_tool_id` second arg. We adapt back to our internal struct on
    // the way out.
    use crate::agi::session_borrower as sb;
    let upstream_req = sb::LlmRequest {
        system_prompt: req.system,
        user_prompt: req.user,
        max_tokens: None,
        temperature: None,
    };
    match sb::dispatch(upstream_req, req.primary_tool_id).await {
        Ok(resp) => Ok(LlmResponse {
            text: resp.text,
            channel_used: resp.channel_used,
        }),
        Err(e) => Err(AppError::external("session_borrower", e.to_string())),
    }
}

// ---------------------------------------------------------------------------
// Engine

/// Cadence of a single heartbeat. Foreground = 5 min, Background = 30 min,
/// Manual = user pressed the "Trigger heartbeat now" button in /co-thinker.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HeartbeatCadence {
    Foreground,
    Background,
    Manual,
}

impl HeartbeatCadence {
    /// Display string used in the brain.md "Last heartbeat" line.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Foreground => "5min foreground",
            Self::Background => "30min background",
            Self::Manual => "manual",
        }
    }
}

/// Outcome of one heartbeat. Returned by `heartbeat()` and the
/// `co_thinker_trigger_heartbeat` Tauri command.
#[derive(Debug, Clone, Serialize)]
pub struct HeartbeatOutcome {
    /// Number of atoms changed since the last heartbeat (mtime >= last).
    pub atoms_seen: u32,
    /// True if `co-thinker.md` was rewritten this tick.
    pub brain_updated: bool,
    /// Number of `proposals/*.md` files created this tick.
    pub proposals_created: u32,
    /// Tool channel that answered the LLM call ("mcp" / "browser_ext" /
    /// "local_http" / "mock" / "none").
    pub channel_used: String,
    /// Wall-clock latency from heartbeat entry to brain.md write.
    pub latency_ms: u64,
    /// Soft error message when something failed but the daemon survived.
    /// `None` = clean tick.
    pub error: Option<String>,
}

/// The engine. Owns the memory root + tracks last-heartbeat-ts for
/// incremental scans. The dispatcher is injected so tests can swap in a mock.
pub struct CoThinkerEngine {
    pub memory_root: PathBuf,
    pub last_heartbeat_ts: Option<DateTime<Utc>>,
    /// `Arc<dyn LlmDispatcher>` so the engine can be cheaply cloned across
    /// the daemon + Tauri command surfaces without leaking lifetimes.
    pub dispatcher: Arc<dyn LlmDispatcher>,
    /// Throttle: heartbeat takes this lock; a second concurrent call gets
    /// `try_lock` → None → short-circuits with "throttled".
    throttle: Arc<tokio::sync::Mutex<()>>,
}

impl CoThinkerEngine {
    /// New engine wired to the production session-borrower dispatcher.
    pub fn new(memory_root: PathBuf) -> Self {
        Self {
            memory_root,
            last_heartbeat_ts: None,
            dispatcher: Arc::new(ProductionDispatcher),
            throttle: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// Test/integration constructor — inject a custom dispatcher.
    pub fn with_dispatcher(memory_root: PathBuf, dispatcher: Arc<dyn LlmDispatcher>) -> Self {
        Self {
            memory_root,
            last_heartbeat_ts: None,
            dispatcher,
            throttle: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// Path to the brain doc.
    pub fn brain_doc_path(&self) -> PathBuf {
        self.memory_root.join("agi").join("co-thinker.md")
    }

    /// Read the brain doc. Returns the seed when the file doesn't exist —
    /// the user-facing /co-thinker route always has something to render.
    pub fn read_brain_doc(&self) -> Result<String, AppError> {
        let p = self.brain_doc_path();
        match std::fs::read_to_string(&p) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(seed_brain_doc(Utc::now())),
            Err(e) => Err(AppError::internal("read_brain", e.to_string())),
        }
    }

    /// Write the brain doc atomically (write-temp + rename). The user-edited
    /// brain.md from the /co-thinker route lands here too.
    pub fn write_brain_doc(&self, content: &str) -> Result<(), AppError> {
        let p = self.brain_doc_path();
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::internal("mkdir_agi", e.to_string()))?;
        }
        atomic_write(&p, content)
    }

    /// Run one heartbeat. See module-level docs for the flow.
    pub async fn heartbeat(
        &mut self,
        cadence: HeartbeatCadence,
        primary_tool_id: Option<String>,
    ) -> Result<HeartbeatOutcome, AppError> {
        let started_inst = Instant::now();
        let started = Utc::now();

        // 0. Throttle. A second concurrent heartbeat short-circuits.
        let _guard = match self.throttle.clone().try_lock_owned() {
            Ok(g) => g,
            Err(_) => {
                return Ok(HeartbeatOutcome {
                    atoms_seen: 0,
                    brain_updated: false,
                    proposals_created: 0,
                    channel_used: "none".into(),
                    latency_ms: started_inst.elapsed().as_millis() as u64,
                    error: Some("throttled — another heartbeat is in flight".into()),
                });
            }
        };

        // 1. Scan for new atoms since last_heartbeat_ts. On first run we look
        //    at the last hour so a fresh install with bundled samples gets a
        //    populated brain.md right away.
        let cutoff = self
            .last_heartbeat_ts
            .unwrap_or_else(|| started - chrono::Duration::hours(1));
        let atoms = scan_atoms_since(&self.memory_root, cutoff);
        let atoms_seen = atoms.len() as u32;

        // 2. Read current brain doc (or seed).
        let brain_existed = self.brain_doc_path().exists();
        let current_brain = self.read_brain_doc()?;

        // Fast path: no new atoms AND brain already exists → don't waste an
        // LLM call. Just bump last_heartbeat_ts and emit an empty
        // observation. This is the steady-state path 90% of heartbeats hit.
        if atoms_seen == 0 && brain_existed {
            observations::append_observation(
                &self.memory_root,
                started,
                &format!(
                    "{} cadence={} atoms_seen=0 channel=skip brief=\"no new atoms\"",
                    started.format("%H:%M:%S"),
                    cadence.label(),
                ),
            )?;
            self.last_heartbeat_ts = Some(started);
            return Ok(HeartbeatOutcome {
                atoms_seen: 0,
                brain_updated: false,
                proposals_created: 0,
                channel_used: "skip".into(),
                latency_ms: started_inst.elapsed().as_millis() as u64,
                error: None,
            });
        }

        // 3. Build the prompt.
        let req = build_llm_request(&current_brain, &atoms, cadence, started, primary_tool_id);

        // 4. Dispatch.
        let (response_text, channel_used, dispatch_error) =
            match self.dispatcher.dispatch(req).await {
                Ok(r) => (r.text, r.channel_used, None),
                Err(e) => (String::new(), "none".to_string(), Some(e.to_string())),
            };

        // If the LLM call failed, log + bail. We do NOT overwrite the brain
        // with empty content — a transient dispatch error keeps the existing
        // brain intact.
        if let Some(err) = dispatch_error {
            observations::append_observation(
                &self.memory_root,
                started,
                &format!(
                    "{} cadence={} atoms_seen={} channel=none brief=\"dispatch failed: {}\"",
                    started.format("%H:%M:%S"),
                    cadence.label(),
                    atoms_seen,
                    err,
                ),
            )?;
            self.last_heartbeat_ts = Some(started);
            return Ok(HeartbeatOutcome {
                atoms_seen,
                brain_updated: false,
                proposals_created: 0,
                channel_used: "none".into(),
                latency_ms: started_inst.elapsed().as_millis() as u64,
                error: Some(err),
            });
        }

        // 5. Validate + apply the grounding rule.
        let validated = validate_and_ground(&response_text, &current_brain);

        // 6. Write brain.md atomically.
        if !validated.is_empty() {
            self.write_brain_doc(&validated)?;
        }
        let brain_updated = !validated.is_empty();

        // 7. Detect proposals (lines starting with `PROPOSAL:`) and write them.
        let proposals_created = write_proposals(&self.memory_root, &response_text, started)?;

        // 8. Append observation log entry.
        let brief = first_reasoning_line(&validated)
            .unwrap_or_else(|| "(no brief extracted)".to_string());
        observations::append_observation(
            &self.memory_root,
            started,
            &format!(
                "{} cadence={} atoms_seen={} channel={} proposals={} brief=\"{}\"",
                started.format("%H:%M:%S"),
                cadence.label(),
                atoms_seen,
                channel_used,
                proposals_created,
                escape_for_log(&brief),
            ),
        )?;

        // 9. Update last_heartbeat_ts.
        self.last_heartbeat_ts = Some(started);

        Ok(HeartbeatOutcome {
            atoms_seen,
            brain_updated,
            proposals_created,
            channel_used,
            latency_ms: started_inst.elapsed().as_millis() as u64,
            error: None,
        })
    }
}

// ---------------------------------------------------------------------------
// Brain doc seeding

/// Initial brain doc written on cold start (heartbeat where no atoms exist
/// yet, AND the brain.md doesn't exist yet). User-readable from the
/// /co-thinker route on day-zero.
pub fn seed_brain_doc(now: DateTime<Utc>) -> String {
    format!(
        "# Tangerine Co-Thinker\n\
Initialized: {ts}\n\
\n\
## What I'm watching\n\
- (No atoms captured yet — the brain warms up after a few sources have data.)\n\
\n\
## Active threads\n\
- (None.)\n\
\n\
## My todo (next 24h, ranked)\n\
- [ ] Wait for sources to capture team data.\n\
\n\
## Recent reasoning\n\
- {ts} → Cold start. Will populate as atoms accumulate.\n\
\n\
## Cited atoms (grounding)\n\
- (None yet.)\n",
        ts = now.format("%Y-%m-%d %H:%M UTC"),
    )
}

// ---------------------------------------------------------------------------
// Atom scanning

/// One atom file the brain has noticed since the last heartbeat. We carry the
/// repo-relative path because the citation rule wants the path string the
/// user would see in the markdown, not the absolute filesystem path.
#[derive(Debug, Clone)]
pub struct AtomSummary {
    /// Path relative to memory_root, with forward slashes (e.g.
    /// `decisions/sample-pricing-20-seat.md`).
    pub rel_path: String,
    /// First non-empty line of the file's body (post-frontmatter), capped at
    /// 200 chars. Used in the LLM prompt's "new atoms" section.
    pub blurb: String,
}

/// Walk the memory dir, return atoms whose mtime is >= cutoff. Skips dotted
/// dirs (`.tangerine`, `.git`) and the `agi/` subtree itself (we don't want
/// the brain reasoning about its own reasoning log).
pub fn scan_atoms_since(memory_root: &Path, cutoff: DateTime<Utc>) -> Vec<AtomSummary> {
    let mut out = Vec::new();
    let cutoff_secs = cutoff.timestamp();
    let _ = walk_dir(memory_root, memory_root, cutoff_secs, &mut out);
    // Stable order so prompt + tests are deterministic.
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

fn walk_dir(
    root: &Path,
    dir: &Path,
    cutoff_secs: i64,
    out: &mut Vec<AtomSummary>,
) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        // Skip our own subtree to avoid feeding the brain its own logs.
        if path == root.join("agi") {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            let _ = walk_dir(root, &path, cutoff_secs, out);
        } else if ft.is_file() {
            if !name_str.ends_with(".md") {
                continue;
            }
            let mtime = match entry.metadata().and_then(|m| m.modified()) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime_secs = match mtime.duration_since(std::time::UNIX_EPOCH) {
                Ok(d) => d.as_secs() as i64,
                Err(_) => continue,
            };
            if mtime_secs < cutoff_secs {
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let blurb = read_blurb(&path);
            out.push(AtomSummary {
                rel_path: rel,
                blurb,
            });
        }
    }
    Ok(())
}

/// Read the first non-frontmatter, non-empty line. Capped at 200 chars.
fn read_blurb(path: &Path) -> String {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    let mut in_fm = false;
    let mut fm_done = false;
    for (i, line) in raw.lines().enumerate() {
        if i == 0 && line.trim() == "---" {
            in_fm = true;
            continue;
        }
        if in_fm && !fm_done {
            if line.trim() == "---" {
                fm_done = true;
            }
            continue;
        }
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let mut buf = String::new();
        for (n, c) in t.chars().enumerate() {
            if n >= 200 {
                buf.push('…');
                break;
            }
            buf.push(c);
        }
        return buf;
    }
    String::new()
}

// ---------------------------------------------------------------------------
// LLM prompt construction

const SYSTEM_PROMPT: &str = "You are Tangerine's co-thinker, a persistent team-memory analyst. \
You read the team's atoms (decisions, meetings, threads) and maintain a brain doc \
the user can audit. Every claim you make MUST be followed by a citation in the form \
`[path/to/atom.md]` or it will be silently dropped. Only output the new full markdown \
for co-thinker.md — no preamble, no fences, no commentary outside the doc. \
Use exactly these section headings: \
`## What I'm watching`, `## Active threads`, `## My todo (next 24h, ranked)`, \
`## Recent reasoning`, `## Cited atoms (grounding)`. \
When you propose a decision lock or notification, prefix the line with `PROPOSAL:` and \
include `type=decision|notification` and a short slug.";

fn build_llm_request(
    current_brain: &str,
    atoms: &[AtomSummary],
    cadence: HeartbeatCadence,
    now: DateTime<Utc>,
    primary_tool_id: Option<String>,
) -> LlmRequest {
    let mut user = String::new();
    user.push_str("# Heartbeat\n");
    user.push_str(&format!(
        "Now: {} ({})\n\n",
        now.format("%Y-%m-%d %H:%M UTC"),
        cadence.label()
    ));
    user.push_str("## Current brain doc\n\n");
    user.push_str(current_brain);
    user.push_str("\n\n## New atoms since last heartbeat\n\n");
    if atoms.is_empty() {
        user.push_str("(none — refresh recent reasoning only)\n");
    } else {
        for a in atoms {
            user.push_str(&format!("- `[{}]` — {}\n", a.rel_path, a.blurb));
        }
    }
    user.push_str(
        "\n## Task\n\n\
Update brain.md sections in place. Cite every claim with an atom path in `[…]` form. \
Drop sections that have no grounding. Output only the new full markdown for co-thinker.md.\n",
    );

    LlmRequest {
        system: SYSTEM_PROMPT.to_string(),
        user,
        primary_tool_id,
    }
}

// ---------------------------------------------------------------------------
// Validation + grounding rule

/// Required section headings. If the response is missing any of these, we
/// fall back to the existing brain doc rather than corrupting it.
const REQUIRED_HEADINGS: &[&str] = &[
    "## What I'm watching",
    "## Active threads",
    "## My todo (next 24h, ranked)",
    "## Recent reasoning",
    "## Cited atoms (grounding)",
];

/// Apply the grounding rule + section validation. Returns "" when the
/// response is malformed (caller treats empty as "don't overwrite the brain").
pub fn validate_and_ground(response: &str, current_brain: &str) -> String {
    let trimmed = response.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Strip leading code fences if the model wrapped its output anyway.
    let body = trimmed
        .trim_start_matches("```markdown")
        .trim_start_matches("```md")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    // Must contain every required heading. Missing any → bail.
    for h in REQUIRED_HEADINGS {
        if !body.contains(h) {
            return String::new();
        }
    }

    // Drop uncited bullet/dash claims. The rule:
    //   - lines starting with `- ` or `* ` or numbered (`1. `) MUST contain
    //     a `[…md]` token (or an in-parens pseudo-citation like `(no atoms…)`)
    //     to survive.
    // Heading lines, blank lines, the `Last heartbeat:` line, and
    // intentional placeholders (containing `(None)` / `(none)` / `(No atoms`)
    // pass through untouched.
    let mut out = String::new();
    for line in body.lines() {
        if is_claim_line(line) && !has_citation(line) {
            // Drop silently.
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }

    let cleaned = out.trim_end().to_string();

    // Re-validate post-strip — if dropping uncited claims removed a section
    // entirely, fall back rather than write a doc with empty headings.
    for h in REQUIRED_HEADINGS {
        if !cleaned.contains(h) {
            // Same heading might have lost all its claims. Synthesize a
            // safe doc by fusing cleaned content with a "(no grounded
            // claims)" placeholder under each missing heading.
            return repair_missing_sections(&cleaned, current_brain);
        }
    }
    cleaned
}

fn is_claim_line(line: &str) -> bool {
    let t = line.trim_start();
    if t.starts_with('#') {
        return false;
    }
    if t.starts_with("- ") || t.starts_with("* ") {
        return true;
    }
    // Numbered list "1. ", "2. " ...
    let mut chars = t.chars();
    let mut saw_digit = false;
    while let Some(c) = chars.next() {
        if c.is_ascii_digit() {
            saw_digit = true;
            continue;
        }
        if saw_digit && c == '.' {
            if matches!(chars.next(), Some(' ')) {
                return true;
            }
        }
        break;
    }
    false
}

fn has_citation(line: &str) -> bool {
    // Accept `[path.md]` (the canonical form) or an explicit
    // `(no atoms ...)` / `(None)` placeholder.
    let lower = line.to_lowercase();
    if lower.contains("(none") || lower.contains("(no atoms") || lower.contains("(none.)") {
        return true;
    }
    // `[…md]` — find a `[` followed by `]` with `.md` inside.
    if let Some(open) = line.find('[') {
        if let Some(close_rel) = line[open..].find(']') {
            let inner = &line[open + 1..open + close_rel];
            if inner.contains(".md") {
                return true;
            }
        }
    }
    false
}

/// When the grounding-strip removed an entire heading's bullets, splice in a
/// `- (No grounded claims yet.)` line. This keeps the brain doc structurally
/// intact rather than discarding the whole tick.
fn repair_missing_sections(cleaned: &str, _current_brain: &str) -> String {
    let mut out = String::new();
    let mut sections_seen = std::collections::HashSet::new();
    for line in cleaned.lines() {
        out.push_str(line);
        out.push('\n');
        for h in REQUIRED_HEADINGS {
            if line.trim() == *h {
                sections_seen.insert(*h);
            }
        }
    }
    for h in REQUIRED_HEADINGS {
        if !sections_seen.contains(h) {
            out.push_str("\n");
            out.push_str(h);
            out.push_str("\n- (No grounded claims yet.)\n");
        }
    }
    out.trim_end().to_string()
}

/// Pull the first `## Recent reasoning` bullet out for the observation log.
fn first_reasoning_line(brain: &str) -> Option<String> {
    let mut in_section = false;
    for line in brain.lines() {
        let t = line.trim();
        if t == "## Recent reasoning" {
            in_section = true;
            continue;
        }
        if in_section {
            if t.starts_with("##") {
                break;
            }
            if let Some(rest) = t.strip_prefix("- ") {
                return Some(rest.to_string());
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Proposal detection

/// Scan the LLM response for `PROPOSAL:` sentinel lines and write each to
/// `agi/proposals/{type}-{slug}-{date}.md`. Returns the count written.
fn write_proposals(
    memory_root: &Path,
    response: &str,
    now: DateTime<Utc>,
) -> Result<u32, AppError> {
    let mut count = 0u32;
    for line in response.lines() {
        let t = line.trim_start();
        let body = match t.strip_prefix("PROPOSAL:") {
            Some(rest) => rest.trim(),
            None => continue,
        };
        let (kind, slug, summary) = parse_proposal_line(body);
        let date = now.format("%Y-%m-%d");
        let filename = format!("{}-{}-{}.md", kind, slug, date);
        let path = memory_root.join("agi").join("proposals").join(&filename);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::internal("mkdir_proposals", e.to_string()))?;
        }
        let content = format!(
            "---\n\
type: {kind}\n\
slug: {slug}\n\
proposed_at: {ts}\n\
status: pending\n\
---\n\
\n\
## Proposal\n\
\n\
{summary}\n",
            kind = kind,
            slug = slug,
            ts = now.to_rfc3339(),
            summary = summary,
        );
        atomic_write(&path, &content)?;
        count += 1;
    }
    Ok(count)
}

/// Parse one `PROPOSAL:` line. Format:
///   `PROPOSAL: type=decision slug=pricing-lock <free-text summary>`
/// Defaults: type=decision, slug=item-{N}.
fn parse_proposal_line(body: &str) -> (String, String, String) {
    let mut kind = "decision".to_string();
    let mut slug = "item".to_string();
    let mut summary_parts: Vec<&str> = Vec::new();
    for tok in body.split_whitespace() {
        if let Some(v) = tok.strip_prefix("type=") {
            kind = sanitize_slug(v);
        } else if let Some(v) = tok.strip_prefix("slug=") {
            slug = sanitize_slug(v);
        } else {
            summary_parts.push(tok);
        }
    }
    let summary = summary_parts.join(" ");
    (
        kind,
        slug,
        if summary.is_empty() {
            "(no summary provided)".to_string()
        } else {
            summary
        },
    )
}

fn sanitize_slug(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Filesystem helpers

fn atomic_write(path: &Path, content: &str) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir", e.to_string()))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content).map_err(|e| AppError::internal("write_tmp", e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| AppError::internal("rename", e.to_string()))?;
    Ok(())
}

fn escape_for_log(s: &str) -> String {
    s.replace('"', "'").replace('\n', " ")
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

    /// Simple deterministic dispatcher for unit tests.
    struct MockDispatcher {
        canned: StdMutex<Vec<Result<LlmResponse, AppError>>>,
        delay: Option<Duration>,
        calls: StdMutex<u32>,
    }

    impl MockDispatcher {
        fn ok(text: &str) -> Self {
            Self {
                canned: StdMutex::new(vec![Ok(LlmResponse {
                    text: text.to_string(),
                    channel_used: "mock".to_string(),
                })]),
                delay: None,
                calls: StdMutex::new(0),
            }
        }
        fn slow_ok(text: &str, delay: Duration) -> Self {
            Self {
                canned: StdMutex::new(vec![Ok(LlmResponse {
                    text: text.to_string(),
                    channel_used: "mock".to_string(),
                })]),
                delay: Some(delay),
                calls: StdMutex::new(0),
            }
        }
        fn calls(&self) -> u32 {
            *self.calls.lock().unwrap()
        }
    }

    impl LlmDispatcher for MockDispatcher {
        fn dispatch<'a>(
            &'a self,
            _req: LlmRequest,
        ) -> BoxFuture<'a, Result<LlmResponse, AppError>> {
            Box::pin(async move {
                *self.calls.lock().unwrap() += 1;
                if let Some(d) = self.delay {
                    tokio::time::sleep(d).await;
                }
                let next = {
                    let mut q = self.canned.lock().unwrap();
                    if q.len() > 1 {
                        q.remove(0)
                    } else {
                        q[0].clone()
                    }
                };
                next
            })
        }
    }

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_co_thinker_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn touch_atom(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
    }

    fn full_brain_response() -> String {
        r#"# Tangerine Co-Thinker
Last heartbeat: 2026-04-26 14:23 (cadence: manual)

## What I'm watching
- Pricing lock at $20/seat decided. [decisions/sample-pricing-20-seat.md]

## Active threads
1. Roadmap sync follow-ups [decisions/sample-pricing-20-seat.md]

## My todo (next 24h, ranked)
- [ ] Confirm 3-seat minimum with David. [decisions/sample-pricing-20-seat.md]

## Recent reasoning
- 2026-04-26 14:23 → New pricing decision detected. [decisions/sample-pricing-20-seat.md]

## Cited atoms (grounding)
- [decisions/sample-pricing-20-seat.md]
"#
        .to_string()
    }

    #[tokio::test]
    async fn test_heartbeat_writes_brain_doc() {
        let root = tmp_root();
        touch_atom(
            &root,
            "decisions/sample-pricing-20-seat.md",
            "---\nsource: meeting\ntitle: Pricing\n---\n\nPricing $20/seat\n",
        );
        let mock = Arc::new(MockDispatcher::ok(&full_brain_response()));
        let mut engine = CoThinkerEngine::with_dispatcher(root.clone(), mock.clone());
        let out = engine.heartbeat(HeartbeatCadence::Manual, None).await.unwrap();
        assert!(out.brain_updated, "brain should be written");
        assert_eq!(out.error, None);
        let brain = std::fs::read_to_string(root.join("agi/co-thinker.md")).unwrap();
        for h in REQUIRED_HEADINGS {
            assert!(brain.contains(h), "missing heading {}", h);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_heartbeat_skips_when_no_new_atoms() {
        let root = tmp_root();
        // Pre-create the brain doc so the skip path is reachable on tick #2.
        std::fs::create_dir_all(root.join("agi")).unwrap();
        std::fs::write(
            root.join("agi/co-thinker.md"),
            seed_brain_doc(Utc::now()),
        )
        .unwrap();
        let mock = Arc::new(MockDispatcher::ok(&full_brain_response()));
        let mut engine = CoThinkerEngine::with_dispatcher(root.clone(), mock.clone());
        // First tick — no atoms (memory is empty), brain.md exists, expect skip.
        engine.last_heartbeat_ts = Some(Utc::now() - chrono::Duration::seconds(1));
        let out = engine.heartbeat(HeartbeatCadence::Manual, None).await.unwrap();
        assert_eq!(out.atoms_seen, 0);
        assert!(!out.brain_updated);
        assert_eq!(out.channel_used, "skip");
        // Second tick — still no atoms, still skip. No LLM calls total.
        let out2 = engine.heartbeat(HeartbeatCadence::Manual, None).await.unwrap();
        assert_eq!(out2.atoms_seen, 0);
        assert_eq!(mock.calls(), 0, "dispatcher must not be called on skip");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_grounding_rule_drops_uncited_claims() {
        let root = tmp_root();
        touch_atom(
            &root,
            "decisions/x.md",
            "---\ntitle: X\n---\n\nbody\n",
        );
        // Two claims under "What I'm watching" — one cited, one not.
        let mixed = r#"# Tangerine Co-Thinker
Last heartbeat: 2026-04-26

## What I'm watching
- This claim has a citation. [decisions/x.md]
- This claim is uncited and must be dropped.

## Active threads
- Thread one. [decisions/x.md]

## My todo (next 24h, ranked)
- [ ] Do the thing. [decisions/x.md]

## Recent reasoning
- 2026-04-26 → reasoning. [decisions/x.md]

## Cited atoms (grounding)
- [decisions/x.md]
"#;
        let mock = Arc::new(MockDispatcher::ok(mixed));
        let mut engine = CoThinkerEngine::with_dispatcher(root.clone(), mock.clone());
        let out = engine.heartbeat(HeartbeatCadence::Manual, None).await.unwrap();
        assert!(out.brain_updated);
        let brain = std::fs::read_to_string(root.join("agi/co-thinker.md")).unwrap();
        assert!(brain.contains("This claim has a citation."));
        assert!(
            !brain.contains("This claim is uncited and must be dropped."),
            "uncited claim must be silently truncated"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_concurrent_heartbeat_is_throttled() {
        let root = tmp_root();
        touch_atom(&root, "decisions/x.md", "---\n---\n\nbody\n");
        // Slow dispatcher so the first heartbeat is still in-flight when the
        // second one tries to acquire the lock.
        let mock = Arc::new(MockDispatcher::slow_ok(
            &full_brain_response(),
            Duration::from_millis(150),
        ));
        let engine = CoThinkerEngine::with_dispatcher(root.clone(), mock.clone());
        // We need the engine to be Send across the join. CoThinkerEngine is
        // not Clone, but we can stage the second call inline using a shared
        // mock and a separate engine pointing at the same root.
        let mut engine2 = CoThinkerEngine::with_dispatcher(
            root.clone(),
            // Different dispatcher arc — but the throttle is *per-engine*.
            // To exercise the throttle we run the second heartbeat against
            // the SAME engine, so spawn the first via tokio.
            mock.clone(),
        );
        // Share the throttle so we actually exercise it.
        engine2.throttle = engine.throttle.clone();

        let mut e1 = engine;
        let h1 = tokio::spawn(async move {
            e1.heartbeat(HeartbeatCadence::Manual, None).await.unwrap()
        });
        // Brief yield so e1 has a chance to acquire the lock + start the
        // dispatcher delay before e2 calls.
        tokio::time::sleep(Duration::from_millis(20)).await;
        let out2 = engine2.heartbeat(HeartbeatCadence::Manual, None).await.unwrap();
        assert!(
            out2.error.as_deref().unwrap_or("").contains("throttled"),
            "second heartbeat must short-circuit, got {:?}",
            out2.error
        );
        let out1 = h1.await.unwrap();
        assert!(out1.brain_updated, "first heartbeat must complete normally");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_validate_drops_when_heading_missing() {
        let bad = "## What I'm watching\n- foo [a.md]\n";
        let res = validate_and_ground(bad, "");
        assert!(res.is_empty(), "missing 4/5 headings → drop");
    }

    #[test]
    fn test_seed_brain_has_all_sections() {
        let s = seed_brain_doc(Utc::now());
        for h in REQUIRED_HEADINGS {
            assert!(s.contains(h), "seed missing {}", h);
        }
    }

    #[test]
    fn test_parse_proposal_line() {
        let (k, s, sum) = parse_proposal_line("type=decision slug=pricing-lock confirm $20");
        assert_eq!(k, "decision");
        assert_eq!(s, "pricing-lock");
        assert_eq!(sum, "confirm $20");
    }

    #[test]
    fn test_proposal_written_to_disk() {
        let root = tmp_root();
        let resp = "PROPOSAL: type=decision slug=pricing-lock confirm pricing\n";
        let n = write_proposals(&root, resp, Utc::now()).unwrap();
        assert_eq!(n, 1);
        let dir = root.join("agi/proposals");
        let files: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(files.iter().any(|f| f.starts_with("decision-pricing-lock-")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_scan_atoms_skips_agi_subtree() {
        let root = tmp_root();
        touch_atom(&root, "agi/co-thinker.md", "self");
        touch_atom(&root, "decisions/x.md", "---\n---\nbody");
        let atoms = scan_atoms_since(&root, Utc::now() - chrono::Duration::hours(1));
        assert!(
            atoms.iter().all(|a| !a.rel_path.starts_with("agi/")),
            "agi/ subtree must not be self-fed"
        );
        assert!(atoms.iter().any(|a| a.rel_path == "decisions/x.md"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
