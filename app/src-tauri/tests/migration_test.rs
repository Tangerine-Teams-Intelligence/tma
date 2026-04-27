//! v2.0-alpha.1 — Layered-memory migration acceptance tests.
//!
//! Two acceptance gates per V2_0_SPEC.md §6 v2.0-alpha.1:
//!   1. v1.x layout still loads after migration (atoms surface under
//!      `/team/`, the reader walk returns the same set as before).
//!   2. `/personal/` is never staged for git: `.gitignore` carries the entry
//!      and the actual files don't show up in `git status`.
//!
//! Plus a few sanity checks: idempotent re-runs and personal-vault scope
//! routing for voice notes (since voice notes are the only writer that
//! defaults to `AtomScope::Personal` in the v2.0-alpha.1 cut).

use std::path::{Path, PathBuf};
use std::process::Command;

use tangerine_meeting_lib::memory_paths::{ATOM_KINDS, AtomScope, resolve_atom_dir};
use tangerine_meeting_lib::migration::{
    canonical_gitignore_body, migrate_to_layered,
};
use tangerine_meeting_lib::sources::voice_notes::{
    build_voice_atom, voice_threads_dir_for, voice_threads_dir_legacy,
};

fn fresh_root(label: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "tii_migration_test_{}_{}",
        label,
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn seed_v18_layout(root: &Path) {
    // One file per kind dir + a sidecar.
    for kind in ATOM_KINDS {
        let dir = root.join(kind);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("sample.md"), format!("# {}\n\nseeded\n", kind)).unwrap();
    }
    // Daemon sidecar — must NOT be migrated.
    std::fs::create_dir_all(root.join(".tangerine")).unwrap();
    std::fs::write(root.join(".tangerine/index.json"), "{}").unwrap();
    // AGI co-thinker sidecar — must NOT be migrated.
    std::fs::create_dir_all(root.join("agi/proposals")).unwrap();
    std::fs::write(root.join("agi/co-thinker.md"), "brain doc\n").unwrap();
}

/// Walk every .md file under a tree and return rel paths (forward slashes).
/// Excludes sidecar dirs (`.tangerine/`, `agi/`, `timeline/`, `canvas/`) since
/// those aren't user atoms — they belong to the daemon / co-thinker / canvas
/// surface and the migration leaves them untouched.
fn walk_md(root: &Path) -> Vec<String> {
    const SKIP: &[&str] = &[".tangerine", "agi", "timeline", "canvas", "tmp"];
    let mut out: Vec<String> = Vec::new();
    walk_md_into(root, root, &mut out, SKIP);
    out.sort();
    out
}

fn walk_md_into(base: &Path, dir: &Path, out: &mut Vec<String>, skip: &[&str]) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if path.is_dir() {
            // Skip sidecars when we're at the top of the walk (i.e. their
            // parent is `base`). Keeps nested dirs like `team/threads/email/`
            // walkable.
            if path.parent() == Some(base) && skip.contains(&name_str.as_ref()) {
                continue;
            }
            walk_md_into(base, &path, out, skip);
        } else if path.is_file() {
            if path.extension().and_then(|s| s.to_str()) == Some("md") {
                if let Ok(rel) = path.strip_prefix(base) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
}

#[test]
fn test_v18_layout_loads_after_migration() {
    let root = fresh_root("v18_loads");
    seed_v18_layout(&root);

    // Pre-migration: every kind has its `sample.md` at root level.
    let before = walk_md(&root);
    assert_eq!(before.len(), ATOM_KINDS.len());

    let outcome = migrate_to_layered(&root, "alice").expect("migrate ok");
    assert!(!outcome.already_layered, "first run shouldn't be no-op");
    assert_eq!(outcome.migrated_kinds.len(), ATOM_KINDS.len());

    // Post-migration: every kind file lives under team/, every former
    // root path is gone.
    for kind in ATOM_KINDS {
        let team_path = root.join("team").join(kind).join("sample.md");
        assert!(team_path.is_file(), "missing team/{kind}/sample.md");
        let legacy_path = root.join(kind).join("sample.md");
        assert!(!legacy_path.exists(), "legacy {kind}/sample.md still present");
    }

    // Sidecars untouched.
    assert!(root.join(".tangerine/index.json").is_file());
    assert!(root.join("agi/co-thinker.md").is_file());

    // The same set of atoms is reachable via the layered reader path —
    // we synthesize the equivalent of `list_atoms` here without going
    // through a Tauri runtime.
    let mut union: Vec<String> = Vec::new();
    for kind in ATOM_KINDS {
        let team = resolve_atom_dir(&root, AtomScope::Team, "alice", kind);
        if team.is_dir() {
            for entry in std::fs::read_dir(&team).unwrap().flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if name.ends_with(".md") {
                        union.push(format!("team/{}/{}", kind, name));
                    }
                }
            }
        }
    }
    union.sort();
    assert_eq!(union.len(), ATOM_KINDS.len(), "got {:?}", union);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn test_personal_dir_never_in_git_remote() {
    let root = fresh_root("gitignore");
    seed_v18_layout(&root);
    let outcome = migrate_to_layered(&root, "bob").expect("migrate ok");
    assert!(outcome.gitignore_written, "expected fresh .gitignore");

    // .gitignore content includes the canonical body.
    let gi = std::fs::read_to_string(root.join(".gitignore")).unwrap();
    assert_eq!(gi, canonical_gitignore_body());
    assert!(gi.contains("personal/"));
    assert!(gi.contains(".tangerine/"));

    // Drop a fake personal-vault file so we can verify git status filters it.
    let personal = root.join("personal/bob/threads/voice");
    std::fs::create_dir_all(&personal).unwrap();
    std::fs::write(personal.join("note.md"), "secret\n").unwrap();

    // If `git` is on PATH, init a repo and check status — `personal/note.md`
    // must not appear in the untracked list. Not every CI worker has git,
    // so we degrade gracefully when the binary is missing.
    let git_available = Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !git_available {
        // Fallback assertion: the .gitignore body alone is enough proof
        // that a downstream `git status` would skip personal/.
        let _ = std::fs::remove_dir_all(&root);
        return;
    }

    let init = Command::new("git")
        .arg("init")
        .arg(".")
        .current_dir(&root)
        .output()
        .expect("git init");
    assert!(init.status.success(), "git init failed: {:?}", init);

    let status = Command::new("git")
        .args(["status", "--porcelain", "--ignored"])
        .current_dir(&root)
        .output()
        .expect("git status");
    let stdout = String::from_utf8_lossy(&status.stdout).to_string();
    // The personal entry should appear under `!!` (ignored) or not at all,
    // never under `??` (untracked) — that's what would have been
    // committable by accident.
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("??") && trimmed.contains("personal/") {
            panic!("personal/ leaked as untracked: {}", stdout);
        }
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn test_migration_idempotent() {
    let root = fresh_root("idempotent");
    seed_v18_layout(&root);
    let first = migrate_to_layered(&root, "carol").expect("first migrate");
    assert!(!first.already_layered);

    // Second run is a no-op for kind moves.
    let second = migrate_to_layered(&root, "carol").expect("second migrate");
    assert!(second.already_layered);
    assert!(second.migrated_kinds.is_empty());

    // .gitignore on disk still matches the canonical body — we don't tear
    // it apart between runs.
    let gi = std::fs::read_to_string(root.join(".gitignore")).unwrap();
    assert_eq!(gi, canonical_gitignore_body());

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn test_voice_notes_writes_to_personal() {
    // We don't spin up Whisper in this test — instead we exercise the path
    // helper that the Tauri command uses, plus the atom builder, to verify
    // the resulting file lands under personal/ and not under the legacy
    // flat threads/voice path.
    let root = fresh_root("voice");
    let _ = migrate_to_layered(&root, "dave").unwrap();

    let user = "dave";
    let dir = voice_threads_dir_for(&root, user);
    std::fs::create_dir_all(&dir).unwrap();
    let body = build_voice_atom(
        &chrono::Utc::now(),
        3.5,
        "hello world",
        "audio/webm",
    );
    let path = dir.join("2026-04-26-1342.md");
    std::fs::write(&path, &body).unwrap();

    // Path lives under personal/, NOT the legacy flat dir.
    assert!(path.starts_with(root.join("personal").join(user).join("threads").join("voice")));
    assert!(!path.starts_with(voice_threads_dir_legacy(&root)));
    assert!(path.is_file());
    let on_disk = std::fs::read_to_string(&path).unwrap();
    assert!(on_disk.contains("source: voice-notes"));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn test_migration_seeds_personal_skeleton() {
    let root = fresh_root("skeleton");
    seed_v18_layout(&root);
    let _ = migrate_to_layered(&root, "eve").unwrap();
    // Every kind dir under personal/eve/ exists and is empty.
    for kind in ATOM_KINDS {
        let p = root.join("personal/eve").join(kind);
        assert!(p.is_dir(), "missing skeleton for {kind}");
        let entries: Vec<_> = std::fs::read_dir(&p).unwrap().flatten().collect();
        assert!(entries.is_empty(), "personal/eve/{kind} should start empty");
    }
    let _ = std::fs::remove_dir_all(&root);
}
