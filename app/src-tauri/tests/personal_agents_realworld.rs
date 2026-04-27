//! Wave 4-B real-world parser validation.
//!
//! This test is `#[ignore]` by default — it only runs when the developer
//! has actual conversation logs on disk (e.g. on the CEO's machine). It
//! never copies the user's data into the repo. The goal is to catch parser
//! schema drift against real vendor logs without bloating fixtures.
//!
//! Run with:
//!   cargo test --test personal_agents_realworld -- --ignored --nocapture

use std::fs;
use std::path::PathBuf;

use tangerine_meeting_lib::personal_agents::claude_code;

fn home_dir() -> PathBuf {
    dirs::home_dir().expect("home dir")
}

#[test]
#[ignore]
fn claude_code_parses_every_real_session_without_error() {
    let root = home_dir().join(".claude").join("projects");
    if !root.is_dir() {
        eprintln!("no ~/.claude/projects on this machine — skipping");
        return;
    }
    let mut total_files = 0usize;
    let mut parsed_ok = 0usize;
    let mut parse_errors: Vec<(PathBuf, String)> = Vec::new();
    let mut total_messages = 0usize;
    let project_dirs = fs::read_dir(&root).expect("read projects root");
    for proj in project_dirs.flatten() {
        let pdir = proj.path();
        if !pdir.is_dir() {
            continue;
        }
        let session_iter = match fs::read_dir(&pdir) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for entry in session_iter.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            if p.extension().map(|e| e != "jsonl").unwrap_or(true) {
                continue;
            }
            // Skip files larger than 50 MB — they're long-running sessions
            // that would slow this validation pass without changing the
            // schema-validation outcome (the parser already exercised the
            // same shape on smaller files in the same project dir).
            let size = match fs::metadata(&p) {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            if size > 50 * 1024 * 1024 {
                continue;
            }
            total_files += 1;
            let raw = match fs::read_to_string(&p) {
                Ok(s) => s,
                Err(e) => {
                    parse_errors.push((p.clone(), format!("read: {}", e)));
                    continue;
                }
            };
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("session");
            match claude_code::parse_jsonl(&raw, stem) {
                Ok(atom) => {
                    parsed_ok += 1;
                    total_messages += atom.message_count;
                    // Every parsed atom must carry a non-empty body string
                    // (we filter empty turns) and a stable conversation id.
                    assert!(!atom.body.trim().is_empty(), "empty body for {:?}", p);
                    assert!(
                        !atom.conversation_id.is_empty(),
                        "empty conversation id for {:?}",
                        p
                    );
                }
                Err(e) => {
                    // "no user/assistant messages" is acceptable for
                    // session-bootstrap files that only carry diagnostic
                    // events — track but don't fail.
                    if e.contains("no user/assistant messages") {
                        continue;
                    }
                    parse_errors.push((p.clone(), e));
                }
            }
        }
    }
    eprintln!(
        "claude_code real-world: files={} parsed_ok={} errors={} total_messages={}",
        total_files,
        parsed_ok,
        parse_errors.len(),
        total_messages
    );
    for (path, err) in &parse_errors {
        eprintln!("  ERROR {:?}: {}", path, err);
    }
    assert!(parse_errors.is_empty(), "parser errored on real CEO files");
    assert!(total_files > 0, "no real CEO jsonl files found");
}

#[test]
#[ignore]
fn claude_code_capture_writes_real_atoms_to_temp_dir() {
    use tangerine_meeting_lib::personal_agents::claude_code::capture;
    let root = home_dir().join(".claude").join("projects");
    if !root.is_dir() {
        eprintln!("no ~/.claude/projects on this machine — skipping");
        return;
    }
    let tmp = std::env::temp_dir().join(format!(
        "tii_pa_realworld_{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();
    let result = capture(&tmp);
    eprintln!(
        "capture(): source={} written={} skipped={} errors={}",
        result.source,
        result.written,
        result.skipped,
        result.errors.len()
    );
    for e in &result.errors {
        eprintln!("  err: {}", e);
    }
    assert!(result.errors.is_empty(), "capture errored");
    assert!(result.written > 0, "no atoms written from real data");
    // Pick the first atom on disk and sanity-check its frontmatter.
    let atom_dir = tmp.join("claude-code");
    let mut sample: Option<PathBuf> = None;
    for e in fs::read_dir(&atom_dir).unwrap().flatten() {
        if e.path().extension().and_then(|s| s.to_str()) == Some("md") {
            sample = Some(e.path());
            break;
        }
    }
    let sample = sample.expect("at least one atom md file");
    let body = fs::read_to_string(&sample).unwrap();
    eprintln!("sample atom: {}", sample.display());
    eprintln!("first 600 chars of body:\n{}", &body.chars().take(600).collect::<String>());
    assert!(body.starts_with("---\n"), "missing yaml frontmatter");
    assert!(body.contains("source: claude-code\n"), "missing source field");
    assert!(body.contains("conversation_id:"), "missing conversation_id");
    assert!(body.contains("source_mtime_nanos:"), "missing mtime");
    assert!(
        body.contains("**User**:") || body.contains("**Assistant**:"),
        "missing role labels in body"
    );
    // Re-running capture is idempotent — second run writes 0 new atoms.
    let again = capture(&tmp);
    assert_eq!(again.written, 0, "second capture should be no-op");
    let _ = fs::remove_dir_all(&tmp);
}

/// Generates one sample atom at the canonical memory root so the user can
/// inspect what landed on disk. Picks the smallest real session by file
/// size to keep the atom readable.
#[test]
#[ignore]
fn claude_code_sample_atom_at_canonical_path() {
    let projects_root = home_dir().join(".claude").join("projects");
    if !projects_root.is_dir() {
        eprintln!("no ~/.claude/projects on this machine — skipping");
        return;
    }
    // Find the smallest session by size — readable, not multi-megabyte.
    let mut smallest: Option<(u64, PathBuf)> = None;
    for proj in fs::read_dir(&projects_root).unwrap().flatten() {
        if !proj.path().is_dir() {
            continue;
        }
        for entry in fs::read_dir(proj.path()).unwrap().flatten() {
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let m = match fs::metadata(&p) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let size = m.len();
            if size < 5000 {
                continue; // too tiny to be a real conversation
            }
            match &smallest {
                None => smallest = Some((size, p)),
                Some((cur, _)) if size < *cur => smallest = Some((size, p)),
                _ => {}
            }
        }
    }
    let (_size, src) = smallest.expect("at least one session > 5KB");
    eprintln!("sample source: {}", src.display());

    // Stage a fresh copy in a per-session sandbox, then run capture into a
    // canonical-shaped path. We do NOT write into the user's actual memory
    // root from a test — only into a sandboxed clone.
    let sandbox_root = std::env::temp_dir()
        .join("tii_pa_canonical_sample")
        .join(format!("{}", std::process::id()));
    let _ = fs::remove_dir_all(&sandbox_root);
    let stage_projects = sandbox_root.join("projects").join("sample-project");
    fs::create_dir_all(&stage_projects).unwrap();
    let staged = stage_projects.join(src.file_name().unwrap());
    fs::copy(&src, &staged).unwrap();

    // Mimic the canonical layout: <root>/personal/me/threads/<agent>/
    let canonical_threads = sandbox_root
        .join("personal")
        .join("me")
        .join("threads");
    fs::create_dir_all(&canonical_threads).unwrap();

    // We can't redirect claude_code::capture to use the staged source
    // (it always reads from `~/.claude/projects`), so call the parser
    // directly and render via the public surface.
    use tangerine_meeting_lib::personal_agents::{render_atom, system_time_to_nanos};
    let raw = fs::read_to_string(&src).unwrap();
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("sample");
    let mut atom = tangerine_meeting_lib::personal_agents::claude_code::parse_jsonl(&raw, stem)
        .expect("parse");
    let mtime = fs::metadata(&src).unwrap().modified().unwrap();
    atom.source_mtime_nanos = system_time_to_nanos(mtime);
    let target_dir = canonical_threads.join("claude-code");
    fs::create_dir_all(&target_dir).unwrap();
    let body = render_atom(&atom);
    let out_path = target_dir.join(format!("{}.md", atom.conversation_id));
    fs::write(&out_path, body).unwrap();

    // Sanity-check the on-disk file.
    let disk = fs::read_to_string(&out_path).unwrap();
    assert!(disk.starts_with("---\n"));
    assert!(disk.contains("source: claude-code\n"));
    assert!(disk.len() > 200, "atom suspiciously small");

    // Also drop a copy at the user's actual canonical path so the
    // operator can read it. This is the one and only write outside a
    // sandbox — and only if the dir already exists (we never create
    // `~/.tangerine-memory/...` from a test).
    let real_root = home_dir()
        .join(".tangerine-memory")
        .join("personal")
        .join("me")
        .join("threads")
        .join("claude-code");
    if real_root.parent().map(|p| p.is_dir()).unwrap_or(false) {
        fs::create_dir_all(&real_root).ok();
        let real_atom = real_root.join(format!("{}.md", atom.conversation_id));
        fs::write(&real_atom, &disk).ok();
        eprintln!("wrote canonical sample atom: {}", real_atom.display());
    }
    eprintln!("sandbox sample atom: {}", out_path.display());
    eprintln!(
        "atom: {} messages, started_at={:?}",
        atom.message_count, atom.started_at
    );
    // Leave the sandbox dir intact for inspection (the operator can rm it).
}
