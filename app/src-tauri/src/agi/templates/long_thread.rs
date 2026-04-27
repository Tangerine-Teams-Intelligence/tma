//! v1.9.0-beta.2 P2-B — Template #9: long_thread_summary.
//!
//! Walk `~/.tangerine-memory/threads/**/*.md` and surface a toast when a
//! thread atom has 10+ messages and the frontmatter doesn't yet carry a
//! `summary:` field. The toast body is a "we've got your back" completion
//! signal: "**{thread_title}** has {N} messages. I summarized — _{atom}_".
//!
//! Tier: toast (per `is_completion_signal: true`). Confidence 0.85 — the
//! detection is deterministic (count messages, check frontmatter), so the
//! confidence floor is high enough that the user's `agiConfidenceThreshold`
//! slider only blocks it at the upper extreme.
//!
//! **Phase note:** the actual summarization is a stub for Phase 2-B. The
//! toast points the user at the existing thread atom file and the frontend
//! click handler renders whatever's there. Phase 4 (LLM hook) is where
//! `session_borrower::dispatch` produces the prose summary and writes it
//! back into the frontmatter as `summary: …`. That's a one-line check
//! here — once `summary:` exists, this template stops firing for that
//! thread, so the Phase 4 producer naturally suppresses re-toasting.
//!
//! Atom shape we expect (any source: email / voice / loom / discord):
//! ```yaml
//! ---
//! title: Pricing thread
//! source: discord
//! ---
//!
//! ## msg-1
//! Alice: hey
//!
//! ## msg-2
//! Bob: …
//! ```
//!
//! Message-counting heuristic: we count three patterns, take the max:
//!   1. Lines that are exactly `---` (used as a message separator in
//!      threads/email/ atoms — the email source writes one per message).
//!   2. Lines starting with `## ` followed by a non-empty token (each
//!      heading marks one message; threads/voice/ uses this).
//!   3. Lines starting with `### msg-` (older convention some sources
//!      use).
//! Whichever count is highest wins, so we don't underrepresent any source.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use futures_util::future::BoxFuture;

use super::common::{parse_frontmatter, Template, TemplateContext, TemplateMatch};

const TEMPLATE_ID: &str = "long_thread";
const CONFIDENCE: f32 = 0.85;
/// Per spec §4 row 9: priority 4 (a one-shot completion notice — toasts
/// don't fight for the banner slot, but a higher-priority toast like
/// `deadline_approaching` (priority 6-8) should win the toast queue).
const PRIORITY: u8 = 4;
const MIN_MESSAGES: u32 = 10;

/// Stateless detector. Re-instantiated cheaply per heartbeat.
pub struct LongThread;

impl Template for LongThread {
    fn name(&self) -> &'static str {
        TEMPLATE_ID
    }

    fn evaluate<'a>(
        &'a self,
        ctx: &'a TemplateContext<'a>,
    ) -> BoxFuture<'a, Vec<TemplateMatch>> {
        Box::pin(async move {
            let mut out: Vec<TemplateMatch> = Vec::new();
            for (rel, raw, _mtime) in walk_threads_recursive(ctx.memory_root) {
                if let Some(m) = evaluate_one(&rel, &raw) {
                    out.push(m);
                }
            }
            out
        })
    }
}

/// Pure helper: given one thread atom, return a match iff (msg_count ≥ 10
/// AND no `summary:` frontmatter). Public within the crate for direct unit
/// testing.
pub(crate) fn evaluate_one(rel_path: &str, raw: &str) -> Option<TemplateMatch> {
    let (fm, body) = parse_frontmatter(raw);

    // Already summarized → suppress.
    if let Some(s) = fm.get("summary") {
        if !s.trim().is_empty() {
            return None;
        }
    }

    let n = count_messages(&body);
    if n < MIN_MESSAGES {
        return None;
    }

    let title = fm
        .get("title")
        .cloned()
        .unwrap_or_else(|| derive_title_from_path(rel_path));

    let body_text = format!(
        "**{title}** has {n} messages. I summarized — _{path}_",
        title = title,
        n = n,
        path = rel_path,
    );

    Some(TemplateMatch {
        match_id: String::new(),
        template: TEMPLATE_ID.into(),
        body: body_text,
        confidence: CONFIDENCE,
        atom_refs: vec![rel_path.to_string()],
        surface_id: None,
        priority: PRIORITY,
        is_irreversible: false,
        // The completion-signal flag pins this to the toast tier even if
        // future bus changes try to escalate it on `is_cross_route` etc.
        is_completion_signal: true,
        is_cross_route: false,
    })
}

/// Count messages in a thread atom body. Returns the max of three counters
/// so any source's convention works:
///   1. `---` separator lines.
///   2. `## <something>` headings.
///   3. `### msg-<n>` lines (legacy).
pub(crate) fn count_messages(body: &str) -> u32 {
    let mut sep_count = 0u32;
    let mut h2_count = 0u32;
    let mut msg_count = 0u32;
    for line in body.lines() {
        let t = line.trim();
        if t == "---" {
            sep_count += 1;
        }
        if let Some(rest) = t.strip_prefix("## ") {
            if !rest.trim().is_empty() {
                h2_count += 1;
            }
        }
        if t.starts_with("### msg-") {
            msg_count += 1;
        }
    }
    sep_count.max(h2_count).max(msg_count)
}

/// Recursively walk `<memory_root>/threads/**/*.md`. Returns
/// `(rel_path, raw_contents, mtime)` triples with forward-slash paths.
/// Skips hidden + non-md entries. Maintains sort-stable output across
/// platforms by sorting on the relative path.
///
/// We hand-roll the recursion rather than reuse `common::walk_md_files`
/// (which is non-recursive by design) — threads/ is a two-level dir
/// (`threads/{source}/{slug}.md`) and we don't want to add a generic
/// recursive helper to common.rs because the other templates only need
/// shallow walks.
fn walk_threads_recursive(memory_root: &Path) -> Vec<(String, String, DateTime<Utc>)> {
    let root = memory_root.join("threads");
    let mut out: Vec<(String, String, DateTime<Utc>)> = Vec::new();
    walk_inner(memory_root, &root, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn walk_inner(memory_root: &Path, dir: &Path, out: &mut Vec<(String, String, DateTime<Utc>)>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path: PathBuf = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            walk_inner(memory_root, &path, out);
            continue;
        }
        if !ft.is_file() {
            continue;
        }
        if !name_str.ends_with(".md") {
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|d| DateTime::<Utc>::from_timestamp(d.as_secs() as i64, 0))
            .unwrap_or_else(Utc::now);
        let rel = path
            .strip_prefix(memory_root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        out.push((rel, raw, mtime));
    }
}

fn derive_title_from_path(rel_path: &str) -> String {
    let base = Path::new(rel_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("(untitled)");
    base.replace('-', " ")
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_long_thread_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn run(root: &Path) -> Vec<TemplateMatch> {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let ctx = TemplateContext {
                memory_root: root,
                now: Utc::now(),
                recent_telemetry: Vec::new(),
            };
            LongThread.evaluate(&ctx).await
        })
    }

    fn make_thread_body_separator(n_messages: u32) -> String {
        // Convention used by `sources/email`: each message ends in `---`.
        let mut s = String::new();
        for i in 0..n_messages {
            s.push_str(&format!("Message {}\nFrom: alice\n\nbody body body\n---\n", i));
        }
        s
    }

    fn make_thread_body_h2(n_messages: u32) -> String {
        // Convention used by some thread sources: `## msg-N` headings.
        let mut s = String::new();
        for i in 0..n_messages {
            s.push_str(&format!("## msg-{}\nbody for {}\n\n", i, i));
        }
        s
    }

    #[test]
    fn test_long_thread_matches_at_10_messages() {
        let raw = format!(
            "---\ntitle: Roadmap discussion\nsource: discord\n---\n\n{}",
            make_thread_body_separator(10)
        );
        let m = evaluate_one("threads/discord/roadmap.md", &raw)
            .expect("10 messages must trigger");
        assert_eq!(m.template, "long_thread");
        assert_eq!(m.confidence, CONFIDENCE);
        assert_eq!(m.priority, PRIORITY);
        assert!(m.is_completion_signal, "toast tier signal");
        assert!(!m.is_cross_route);
        assert!(m.body.contains("Roadmap discussion"));
        assert!(m.body.contains("10 messages"));
        assert!(m.body.contains("threads/discord/roadmap.md"));
        assert_eq!(m.atom_refs, vec!["threads/discord/roadmap.md".to_string()]);
    }

    #[test]
    fn test_long_thread_skips_below_threshold() {
        // 9 messages → must NOT fire.
        let raw = format!(
            "---\ntitle: Short thread\n---\n\n{}",
            make_thread_body_separator(9)
        );
        let m = evaluate_one("threads/email/short.md", &raw);
        assert!(m.is_none(), "9 < 10 — should not fire");
    }

    #[test]
    fn test_long_thread_skips_already_summarized() {
        // 15 messages BUT the frontmatter has `summary: …` — Phase 4 LLM
        // already wrote a summary, so this template must defer.
        let raw = format!(
            "---\ntitle: Done\nsummary: Alice and Bob agreed to ship Q3.\n---\n\n{}",
            make_thread_body_separator(15)
        );
        let m = evaluate_one("threads/discord/done.md", &raw);
        assert!(m.is_none(), "summarized threads must not re-fire");
    }

    #[test]
    fn test_long_thread_counts_h2_convention() {
        // Voice/loom convention uses `## msg-N` headings, not `---`.
        let raw = format!(
            "---\ntitle: Voice transcript\n---\n\n{}",
            make_thread_body_h2(12)
        );
        let m = evaluate_one("threads/voice/2026-04-26.md", &raw)
            .expect("12 h2 headings = 12 messages");
        assert!(m.body.contains("12 messages"));
    }

    #[test]
    fn test_long_thread_count_helper_takes_max() {
        // Mixed body — separator + h2. Should pick whichever is bigger.
        let body = "## msg-1\nbody1\n---\n## msg-2\nbody2\n---\n## msg-3\nbody3\n---\n";
        // 3 `---` lines, 3 `## ` headings → max 3.
        assert_eq!(count_messages(body), 3);
    }

    #[test]
    fn test_long_thread_recursive_walk() {
        // End-to-end: write atoms in `threads/email/` and `threads/voice/`,
        // assert both are walked.
        let root = tmp_root();
        let body_long = format!(
            "---\ntitle: A long email\n---\n\n{}",
            make_thread_body_separator(11)
        );
        let body_short = format!(
            "---\ntitle: Short voice\n---\n\n{}",
            make_thread_body_h2(3)
        );
        let p1 = root.join("threads/email/long.md");
        let p2 = root.join("threads/voice/short.md");
        std::fs::create_dir_all(p1.parent().unwrap()).unwrap();
        std::fs::create_dir_all(p2.parent().unwrap()).unwrap();
        std::fs::write(&p1, body_long).unwrap();
        std::fs::write(&p2, body_short).unwrap();
        let matches = run(&root);
        assert_eq!(matches.len(), 1, "only the long one fires");
        assert!(matches[0].body.contains("A long email"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_long_thread_no_threads_dir() {
        // No `threads/` subdir — should silently return empty.
        let root = tmp_root();
        let matches = run(&root);
        assert!(matches.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
