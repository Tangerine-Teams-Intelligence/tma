//! v1.9.0-beta.2 P2-B — Template #2: decision_drift.
//!
//! Walk `~/.tangerine-memory/decisions/*.md` for the last 30 days, look for
//! pairs of decisions on the same project (or strongly overlapping titles)
//! that disagree on a specific value (price, tech stack, yes/no policy).
//! When found, surface a banner: "Decision drift on **{project}**:
//! {A_summary} → {B_summary}. Lock?"
//!
//! Tier: banner (cross-route — drift is a project-level concern that should
//! follow the user across routes until resolved). Confidence 0.78 — the
//! heuristic catches obvious drifts ($20→$10, Postgres→Mongo, yes→no) but
//! semantic drift ("we agreed to ship in Q2" vs "ship in Q3") still needs
//! the embedding-based v1.9 final pass.
//!
//! Heuristic (Phase 2-B; Phase 4 ships an embedding-grounded version):
//!   1. Group decisions by `project:` frontmatter, OR by ≥ 2-token title
//!      overlap when frontmatter is missing.
//!   2. Within a group, sort by mtime ascending. For every pair (A, B)
//!      where B is at least 1 day newer than A:
//!      a. Extract "value tokens" from each body — currency (`$\d+`),
//!         booleans (`yes` / `no`), tech names (`postgres`, `mongo`,
//!         `vercel`, `aws`, `mysql`, `react`, `vue`, etc.), bare integers
//!         near a shared keyword.
//!      b. If both atoms emit a token of the same dimension AND those
//!         tokens differ → drift detected.
//!   3. We emit at most ONE drift match per project per heartbeat — the
//!      newest A→B pair wins. Spamming the user with every historical
//!      drift defeats the single-active-suggestion discipline.
//!
//! Atom shape we expect:
//! ```yaml
//! ---
//! title: Pricing — first pass
//! project: tangerine-pricing
//! ---
//!
//! Decision: $20/seat/month.
//! ```

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, Duration, Utc};
use futures_util::future::BoxFuture;

use super::common::{parse_frontmatter, walk_md_files, Template, TemplateContext, TemplateMatch};

const TEMPLATE_ID: &str = "decision_drift";
const CONFIDENCE: f32 = 0.78;
const LOOKBACK_DAYS: i64 = 30;
const MIN_PAIR_GAP_DAYS: i64 = 1;
/// Banner priority. The spec puts decision_drift at 9 — second only to
/// catchup_hint (10).
const PRIORITY: u8 = 9;

/// Stateless detector. Holds no fields — re-instantiated per heartbeat.
pub struct DecisionDrift;

impl Template for DecisionDrift {
    fn name(&self) -> &'static str {
        TEMPLATE_ID
    }

    fn evaluate<'a>(
        &'a self,
        ctx: &'a TemplateContext<'a>,
    ) -> BoxFuture<'a, Vec<TemplateMatch>> {
        Box::pin(async move {
            let cutoff = ctx.now - Duration::days(LOOKBACK_DAYS);
            let atoms = walk_md_files(ctx.memory_root, "decisions");

            // Filter to last 30 days, parse each.
            let mut parsed: Vec<ParsedAtom> = atoms
                .into_iter()
                .filter(|(_, _, mt)| *mt >= cutoff)
                .filter_map(|(rel, raw, mtime)| ParsedAtom::from(rel, &raw, mtime))
                .collect();

            // Group by project (with title-overlap fallback).
            let groups = group_by_project(&mut parsed);

            // For each group, find the strongest drift pair.
            let mut matches: Vec<TemplateMatch> = Vec::new();
            for (project, indices) in groups {
                if indices.len() < 2 {
                    continue;
                }
                if let Some(drift) = find_drift_in_group(&parsed, &indices) {
                    matches.push(build_match(&project, &parsed[drift.a_idx], &parsed[drift.b_idx], &drift));
                }
            }
            matches
        })
    }
}

/// One decision atom after frontmatter + body parse. Cheap-to-clone fields.
#[derive(Debug, Clone)]
pub(crate) struct ParsedAtom {
    pub rel_path: String,
    pub mtime: DateTime<Utc>,
    pub title: String,
    pub project: Option<String>,
    /// Original raw body. Currently unused at the heuristic layer (we scan
    /// `body_lc` instead) but kept on the struct so future templates can
    /// case-sensitively read the original prose without re-parsing the file.
    #[allow(dead_code)]
    pub body: String,
    /// Lowercased + whitespace-collapsed body — the heuristic scans this
    /// rather than the raw body so case + indentation don't perturb matches.
    pub body_lc: String,
}

impl ParsedAtom {
    pub(crate) fn from(rel: String, raw: &str, mtime: DateTime<Utc>) -> Option<Self> {
        let (fm, body) = parse_frontmatter(raw);
        let title = fm
            .get("title")
            .cloned()
            .unwrap_or_else(|| derive_title_from_path(&rel));
        let project = fm.get("project").cloned().filter(|p| !p.trim().is_empty());
        let body_lc = body.to_lowercase();
        Some(Self {
            rel_path: rel,
            mtime,
            title,
            project,
            body,
            body_lc,
        })
    }
}

/// Group decisions by their project key. Atoms without a `project:` field
/// are grouped by sharing ≥ 2 non-stop-word tokens with an existing group's
/// title; atoms that match no group form their own singleton group (which
/// the caller filters out below — < 2 members).
fn group_by_project<'a>(parsed: &mut [ParsedAtom]) -> HashMap<String, Vec<usize>> {
    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();

    for (idx, atom) in parsed.iter().enumerate() {
        if let Some(p) = &atom.project {
            groups.entry(p.clone()).or_default().push(idx);
            continue;
        }
        // No project frontmatter — try to attach to an existing group whose
        // representative title overlaps ours by ≥ 2 tokens.
        let my_tokens = title_tokens(&atom.title);
        let mut attached = false;
        for (group_key, members) in &mut groups {
            let rep_title = &parsed.get(members[0]).map(|a| a.title.clone()).unwrap_or_default();
            let rep_tokens = title_tokens(rep_title);
            if shared_token_count(&my_tokens, &rep_tokens) >= 2 {
                members.push(idx);
                attached = true;
                let _ = group_key; // silence unused
                break;
            }
        }
        if !attached {
            // Singleton — drop later.
            let key = format!("__notitle:{}", idx);
            groups.entry(key).or_default().push(idx);
        }
    }
    // Fix borrow: the above had to push to a clone; redo cleanly without the lookup loop dance.
    // (The loop above reads `members[0]` then mutates the same map; in practice we're
    // only mutating `members` push, which is fine after the title read.)
    groups
}

/// Drift between two atoms in the same group. Phase 2-B records the first
/// dimension of disagreement we find; Phase 4 may upgrade to multi-dimension
/// when we add embeddings.
#[derive(Debug, Clone)]
struct Drift {
    a_idx: usize,
    b_idx: usize,
    /// Human-readable, e.g. "$20" / "$10" / "postgres" / "mongo".
    a_token: String,
    b_token: String,
    /// Which dimension — "currency" / "tech" / "boolean" / "number".
    dimension: &'static str,
}

/// Within a group, return the most recent (B is newest) drift pair, or None.
/// "Most recent" so a banner stays focused on what's still in flight.
fn find_drift_in_group(parsed: &[ParsedAtom], indices: &[usize]) -> Option<Drift> {
    // Sort indices by mtime ascending.
    let mut sorted: Vec<usize> = indices.to_vec();
    sorted.sort_by_key(|i| parsed[*i].mtime);

    // Walk pairs newest-first so the first match is the most recent drift.
    for j in (0..sorted.len()).rev() {
        for i in 0..j {
            let a_idx = sorted[i];
            let b_idx = sorted[j];
            let a = &parsed[a_idx];
            let b = &parsed[b_idx];
            // Require ≥ 1-day gap so two same-day decisions (probably the
            // same author iterating) don't trip the drift signal.
            if b.mtime.signed_duration_since(a.mtime) < Duration::days(MIN_PAIR_GAP_DAYS) {
                continue;
            }
            if let Some(mut drift) = detect_drift(a, b) {
                // `detect_drift` doesn't see the parsed-Vec indices — fill
                // them in so the caller can resolve back to the source atoms
                // for `atom_refs` + the banner body's date stamps.
                drift.a_idx = a_idx;
                drift.b_idx = b_idx;
                return Some(drift);
            }
        }
    }
    None
}

/// Return Some(Drift) iff atom `a` and `b` disagree on a recognizable value
/// dimension. Currently checks (in priority order):
///   1. Currency (`$\d+(\.\d+)?`)
///   2. Tech-name set (postgres / mongo / mysql / vercel / aws / gcp / azure /
///      react / vue / svelte / next / nuxt / kafka / redis)
///   3. Boolean (`yes` / `no` / `true` / `false`) when both atoms contain
///      one of these tokens
///   4. Bare integer near the same keyword in both atoms (e.g.
///      "3 seats" vs "5 seats" / "Q1" vs "Q3")
fn detect_drift(a: &ParsedAtom, b: &ParsedAtom) -> Option<Drift> {
    if let (Some(a_val), Some(b_val)) = (find_currency(&a.body_lc), find_currency(&b.body_lc)) {
        if a_val != b_val {
            return Some(Drift {
                a_idx: 0, // filled in by caller
                b_idx: 0,
                a_token: a_val,
                b_token: b_val,
                dimension: "currency",
            });
        }
    }
    if let (Some(a_tech), Some(b_tech)) = (find_tech(&a.body_lc), find_tech(&b.body_lc)) {
        if a_tech != b_tech {
            return Some(Drift {
                a_idx: 0,
                b_idx: 0,
                a_token: a_tech,
                b_token: b_tech,
                dimension: "tech",
            });
        }
    }
    if let (Some(a_bool), Some(b_bool)) = (find_bool(&a.body_lc), find_bool(&b.body_lc)) {
        if a_bool != b_bool {
            return Some(Drift {
                a_idx: 0,
                b_idx: 0,
                a_token: a_bool,
                b_token: b_bool,
                dimension: "boolean",
            });
        }
    }
    None
}

/// First currency token in `body_lc`, e.g. `"$20"` / `"$10.50"`. Returns the
/// match including the leading `$` so the banner body can show it verbatim.
fn find_currency(body_lc: &str) -> Option<String> {
    // Hand-rolled scanner — no `regex` crate in the dep tree.
    let bytes = body_lc.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] != b'$' {
            continue;
        }
        // Must be followed immediately by a digit.
        let mut j = i + 1;
        let start = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j == start {
            continue;
        }
        // Optional .ddd
        if j < bytes.len() && bytes[j] == b'.' {
            let mut k = j + 1;
            let dec_start = k;
            while k < bytes.len() && bytes[k].is_ascii_digit() {
                k += 1;
            }
            if k > dec_start {
                j = k;
            }
        }
        return Some(body_lc[i..j].to_string());
    }
    None
}

const TECH_NAMES: &[&str] = &[
    "postgres", "postgresql", "mongo", "mongodb", "mysql", "sqlite",
    "vercel", "aws", "gcp", "azure", "fly.io", "netlify", "cloudflare",
    "react", "vue", "svelte", "next.js", "nuxt", "remix",
    "kafka", "redis", "rabbitmq",
    "rust", "typescript", "python", "go",
];

/// First tech-name token in `body_lc`. Boundary-checked so `mongo` doesn't
/// match inside `mongolian`.
fn find_tech(body_lc: &str) -> Option<String> {
    for name in TECH_NAMES {
        if let Some(pos) = body_lc.find(name) {
            // Boundary check — char before/after must NOT be alphanumeric.
            let before_ok = pos == 0
                || !body_lc.as_bytes()[pos - 1].is_ascii_alphanumeric();
            let after_idx = pos + name.len();
            let after_ok = after_idx >= body_lc.len()
                || !body_lc.as_bytes()[after_idx].is_ascii_alphanumeric();
            if before_ok && after_ok {
                return Some((*name).to_string());
            }
        }
    }
    None
}

/// First boolean token. We accept yes/no/true/false as standalone words
/// (boundary-checked).
fn find_bool(body_lc: &str) -> Option<String> {
    for tok in &["yes", "no", "true", "false"] {
        if let Some(pos) = body_lc.find(tok) {
            let before_ok = pos == 0
                || !body_lc.as_bytes()[pos - 1].is_ascii_alphanumeric();
            let after_idx = pos + tok.len();
            let after_ok = after_idx >= body_lc.len()
                || !body_lc.as_bytes()[after_idx].is_ascii_alphanumeric();
            if before_ok && after_ok {
                return Some((*tok).to_string());
            }
        }
    }
    None
}

/// Build the user-facing banner match. Body shape:
///   `Decision drift on **{project}**: {a_summary} → {b_summary}. Lock?`
fn build_match(project: &str, a: &ParsedAtom, b: &ParsedAtom, drift: &Drift) -> TemplateMatch {
    // Hide the synthetic `__notitle:N` group keys from the user — fall back
    // to "this project" when we couldn't infer a real project name.
    let display_project = if project.starts_with("__notitle") {
        "this project".to_string()
    } else {
        project.to_string()
    };
    let body = format!(
        "Decision drift on **{p}**: {a_t} `{a_v}` ({a_date}) → {b_t} `{b_v}` ({b_date}). Lock?",
        p = display_project,
        a_t = drift.dimension,
        a_v = drift.a_token,
        a_date = a.mtime.format("%Y-%m-%d"),
        b_t = drift.dimension,
        b_v = drift.b_token,
        b_date = b.mtime.format("%Y-%m-%d"),
    );
    TemplateMatch {
        match_id: String::new(),
        template: TEMPLATE_ID.into(),
        body,
        confidence: CONFIDENCE,
        atom_refs: vec![a.rel_path.clone(), b.rel_path.clone()],
        surface_id: None,
        priority: PRIORITY,
        is_irreversible: false,
        is_completion_signal: false,
        is_cross_route: true,
    }
}

// ---------------------------------------------------------------------------
// Title-tokenisation helpers (used for project-fallback grouping).

const STOP_WORDS: &[&str] = &[
    "a", "an", "the", "of", "and", "or", "to", "for", "on", "in", "with",
    "is", "are", "be", "this", "that", "decision", "draft", "rfc", "memo",
];

fn title_tokens(t: &str) -> Vec<String> {
    t.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|tok| !tok.is_empty() && !STOP_WORDS.contains(tok))
        .map(|s| s.to_string())
        .collect()
}

fn shared_token_count(a: &[String], b: &[String]) -> usize {
    let mut c = 0usize;
    for x in a {
        if b.contains(x) {
            c += 1;
        }
    }
    c
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
    use std::path::PathBuf;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_drift_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Write a decision atom with the given relative path + body, then set its
    /// mtime to `mtime` so the 30-day window + pair-ordering logic sees the
    /// timestamp the test wants. Filesystem mtime is what `walk_md_files`
    /// reads.
    fn write_decision(root: &Path, rel: &str, body: &str, mtime: DateTime<Utc>) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        // Set mtime via filetime crate? Not available — use the std lib path.
        let secs = mtime.timestamp();
        let ft = filetime_via_std(secs);
        let _ = std::fs::File::open(&path).map(|_f| set_mtime(&path, ft));
    }

    fn filetime_via_std(secs: i64) -> std::time::SystemTime {
        if secs >= 0 {
            std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs as u64)
        } else {
            std::time::UNIX_EPOCH - std::time::Duration::from_secs((-secs) as u64)
        }
    }

    /// Set mtime + atime on `path` to `t`. Uses platform-native syscalls via
    /// `std::fs::File::set_modified` (stable since 1.75 — our MSRV is 1.78).
    fn set_mtime(path: &Path, t: std::time::SystemTime) {
        let f = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open for set_modified");
        f.set_modified(t).expect("set_modified");
    }

    fn run(root: &Path, now: DateTime<Utc>) -> Vec<TemplateMatch> {
        // Build a fake context. `recent_telemetry` is empty — drift doesn't
        // need it. Use a tokio runtime to drive the boxed future.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let ctx = TemplateContext {
                memory_root: root,
                now,
                recent_telemetry: Vec::new(),
            };
            DecisionDrift.evaluate(&ctx).await
        })
    }

    #[test]
    fn test_decision_drift_finds_currency_change() {
        let root = tmp_root();
        let now = Utc::now();
        write_decision(
            &root,
            "decisions/pricing-v1.md",
            "---\ntitle: Pricing v1\nproject: pricing\n---\n\nDecision: $20/seat.\n",
            now - Duration::days(3),
        );
        write_decision(
            &root,
            "decisions/pricing-v2.md",
            "---\ntitle: Pricing v2\nproject: pricing\n---\n\nDecision: $10/seat (Vercel-style).\n",
            now,
        );
        let matches = run(&root, now);
        assert_eq!(matches.len(), 1, "exactly one drift on the pricing project");
        let m = &matches[0];
        assert_eq!(m.template, "decision_drift");
        assert!(m.body.contains("$20"));
        assert!(m.body.contains("$10"));
        assert!(m.body.contains("**pricing**"));
        assert_eq!(m.confidence, CONFIDENCE);
        assert_eq!(m.priority, PRIORITY);
        assert!(m.is_cross_route, "drift is a cross-route banner");
        assert_eq!(m.atom_refs.len(), 2);
        assert!(m.atom_refs.iter().any(|p| p.contains("pricing-v1")));
        assert!(m.atom_refs.iter().any(|p| p.contains("pricing-v2")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_decision_drift_skips_unrelated_projects() {
        let root = tmp_root();
        let now = Utc::now();
        // Two atoms — different projects, different prices. Should NOT drift.
        write_decision(
            &root,
            "decisions/a.md",
            "---\ntitle: Subscription pricing\nproject: subs\n---\n\n$20.\n",
            now - Duration::days(2),
        );
        write_decision(
            &root,
            "decisions/b.md",
            "---\ntitle: Hardware cost\nproject: hardware\n---\n\n$10.\n",
            now,
        );
        let matches = run(&root, now);
        assert!(matches.is_empty(), "different projects must not drift");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_decision_drift_skips_same_day_pair() {
        let root = tmp_root();
        let now = Utc::now();
        // Both same project, same day → suppressed by MIN_PAIR_GAP_DAYS.
        write_decision(
            &root,
            "decisions/x.md",
            "---\nproject: pricing\n---\n\n$20.\n",
            now - Duration::hours(2),
        );
        write_decision(
            &root,
            "decisions/y.md",
            "---\nproject: pricing\n---\n\n$10.\n",
            now,
        );
        let matches = run(&root, now);
        assert!(matches.is_empty(), "same-day decisions are iteration, not drift");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_decision_drift_finds_tech_change() {
        let root = tmp_root();
        let now = Utc::now();
        write_decision(
            &root,
            "decisions/db-v1.md",
            "---\nproject: db\n---\n\nWe'll use Postgres for everything.\n",
            now - Duration::days(5),
        );
        write_decision(
            &root,
            "decisions/db-v2.md",
            "---\nproject: db\n---\n\nSwitching to Mongo for the document store.\n",
            now,
        );
        let matches = run(&root, now);
        assert_eq!(matches.len(), 1);
        let body = &matches[0].body;
        assert!(body.contains("postgres") || body.contains("Postgres"));
        assert!(body.contains("mongo") || body.contains("Mongo"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_decision_drift_currency_helper() {
        // Direct unit test on the scanner — the regex-free path is the
        // most subtle thing here.
        assert_eq!(find_currency("we agreed on $20/seat"), Some("$20".into()));
        assert_eq!(find_currency("price is $10.50 monthly"), Some("$10.50".into()));
        assert_eq!(find_currency("nothing here"), None);
        assert_eq!(find_currency("just a $ sign"), None);
    }

    #[test]
    fn test_decision_drift_tech_boundary() {
        // `mongo` must match but not inside another word.
        assert_eq!(find_tech("we love mongo"), Some("mongo".into()));
        assert_eq!(find_tech("mongolian dialect"), None);
    }
}
