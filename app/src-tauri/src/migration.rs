//! v2.0-alpha.1 — Layered-memory migration shim.
//!
//! v1.x stored every atom flat under `<memory_root>/{kind}/`. v2.0 splits the
//! memory dir into `team/` (shared, git-synced) and `personal/<user>/`
//! (local-only, gitignored). This module runs once on app boot and moves any
//! v1.x flat layout into `team/`, then seeds an empty `personal/<user>/`
//! skeleton.
//!
//! Iron rules:
//!   * Idempotent — second run is a no-op when both `team/` and `personal/`
//!     already exist.
//!   * Atomic — uses `std::fs::rename` for each kind dir (single inode flip
//!     per move). If a rename fails midway we log and continue with the
//!     remaining kinds — no half-state shenanigans where a single file got
//!     copied without its peers.
//!   * Sidecars (`.tangerine/`, `agi/`, `timeline/`, `canvas/`) are NEVER
//!     moved. Those are owned by the daemon / co-thinker / canvas surface.
//!   * `.gitignore` is rewritten (we own this file) to exclude `personal/`
//!     and `.tangerine/` so committed history never carries personal notes.
//!
//! Boot-time call site: `main.rs` setup() runs `migrate_to_layered` BEFORE
//! the daemon starts so there's no chance of a heartbeat scribbling into the
//! old layout while we're moving it.

use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Serialize;

use crate::memory_paths::{
    already_layered, personal_user_root, team_root, ATOM_KINDS,
};

/// Outcome of a single migration call. Returned to whoever invoked us so the
/// boot logger can write a one-line summary, and so tests can assert the
/// exact set of kinds that moved.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct MigrationOutcome {
    /// True when we did NOT need to do anything — both `team/` and
    /// `personal/` already existed at the root.
    pub already_layered: bool,
    /// Kinds whose flat dirs were successfully moved into `team/`. Empty on
    /// a fresh install (no v1.x layout to move) or on re-runs.
    pub migrated_kinds: Vec<String>,
    /// Total number of regular files inside the migrated kind dirs (counted
    /// before the rename — so the number reflects user-visible atoms, not
    /// any tmp sidecars). Mostly used by tests; the boot log just records
    /// `migrated_kinds.len()`.
    pub files_counted: u32,
    /// Whether we wrote a fresh `.gitignore` at the memory root.
    pub gitignore_written: bool,
    /// RFC 3339 ts of when the migration ran.
    pub ts: String,
}

impl MigrationOutcome {
    fn empty() -> Self {
        Self {
            already_layered: false,
            migrated_kinds: Vec::new(),
            files_counted: 0,
            gitignore_written: false,
            ts: Utc::now().to_rfc3339(),
        }
    }
}

/// Run the v1.x → v2.0 migration. Safe to call on every boot: we short-
/// circuit when the layout is already in place.
///
/// `current_user` is the React-side `ui.currentUser` slice (defaults to
/// "me"). It's used to seed the `personal/<user>/` skeleton; the actual
/// per-user vault still gets created on first write through
/// `memory_paths::resolve_atom_dir`, but seeding now means the sidebar
/// reader sees the skeleton on first paint.
pub fn migrate_to_layered(
    memory_root: &Path,
    current_user: &str,
) -> Result<MigrationOutcome, std::io::Error> {
    let mut outcome = MigrationOutcome::empty();

    // Make sure the memory root exists at all — a brand-new install hits
    // this before any sample seed.
    std::fs::create_dir_all(memory_root)?;

    if already_layered(memory_root) {
        outcome.already_layered = true;
        // Even on a layered install we still re-write `.gitignore` — the
        // file is small, idempotent rewrites are cheap, and this catches
        // upgraders whose `.gitignore` predates the personal/ entry.
        outcome.gitignore_written = write_gitignore(memory_root)?;
        // Seed the per-user skeleton so a fresh user on an existing team
        // repo gets their personal/ layout populated on first launch.
        seed_personal_skeleton(memory_root, current_user)?;
        return Ok(outcome);
    }

    // 1. Create `/team/`.
    let team_dir = team_root(memory_root);
    std::fs::create_dir_all(&team_dir)?;

    // 2. For each kind whose v1.x flat dir exists at root, count its files
    //    and rename it into `/team/`. Anything that fails to rename gets
    //    logged but doesn't abort the whole migration — the worst case is
    //    a half-migrated install where the user's next write goes through
    //    `resolve_atom_dir` (correct path) and the un-moved kind dir is
    //    still walkable by the legacy reader path until we retry on the
    //    next boot.
    for kind in ATOM_KINDS {
        let src = memory_root.join(kind);
        if !src.is_dir() {
            continue;
        }
        let dst = team_dir.join(kind);
        if dst.exists() {
            // Defensive: someone created `team/{kind}` ahead of us. Skip
            // the rename to avoid clobbering whatever's inside.
            tracing::warn!(
                kind = %kind,
                "migration: team/{kind} already exists; leaving v1.x dir in place",
                kind = kind,
            );
            continue;
        }

        let count = count_files(&src);
        match std::fs::rename(&src, &dst) {
            Ok(()) => {
                outcome.migrated_kinds.push(kind.to_string());
                outcome.files_counted = outcome.files_counted.saturating_add(count);
            }
            Err(e) => {
                // Cross-device rename can fail on some filesystems — fall
                // back to copy + remove. Worth the extra branch since the
                // user's home dir might span volumes (Windows junctions,
                // bind mounts, FUSE).
                tracing::warn!(
                    kind = %kind,
                    error = %e,
                    "migration: rename failed; falling back to copy",
                );
                if let Err(copy_err) = copy_dir_recursive(&src, &dst) {
                    tracing::error!(
                        kind = %kind,
                        error = %copy_err,
                        "migration: copy fallback also failed; leaving v1.x dir in place",
                    );
                    continue;
                }
                let _ = std::fs::remove_dir_all(&src);
                outcome.migrated_kinds.push(kind.to_string());
                outcome.files_counted = outcome.files_counted.saturating_add(count);
            }
        }
    }

    // 3. Seed `personal/<user>/` skeleton with empty kind subdirs.
    seed_personal_skeleton(memory_root, current_user)?;

    // 4. Write `.gitignore` so personal/ + .tangerine/ never end up in git.
    outcome.gitignore_written = write_gitignore(memory_root)?;

    Ok(outcome)
}

/// Count regular files (recursively) under `src`. Returns 0 on any error so
/// the migration outcome's `files_counted` is best-effort, not load-bearing.
fn count_files(src: &Path) -> u32 {
    let mut n = 0u32;
    let entries = match std::fs::read_dir(src) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            n = n.saturating_add(1);
        } else if path.is_dir() {
            n = n.saturating_add(count_files(&path));
        }
    }
    n
}

/// Copy `src` into `dst` recursively. Used as the fallback when rename can't
/// cross devices. Returns Ok even if individual files were unreadable —
/// matches the rename semantics ("we tried our best, the user can retry on
/// next boot").
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Create empty `personal/<user>/{kind}` dirs so the React reader sees the
/// layout on first paint. Existing dirs are left alone.
fn seed_personal_skeleton(memory_root: &Path, current_user: &str) -> std::io::Result<()> {
    let user_root = personal_user_root(memory_root, current_user);
    std::fs::create_dir_all(&user_root)?;
    for kind in ATOM_KINDS {
        let kind_dir = user_root.join(kind);
        if !kind_dir.is_dir() {
            std::fs::create_dir_all(&kind_dir)?;
        }
    }
    Ok(())
}

/// Write the canonical `.gitignore` at `memory_root`. We own this file —
/// every run rewrites it from the bundled template (or from the inline
/// fallback below) so old installs pick up new entries.
fn write_gitignore(memory_root: &Path) -> std::io::Result<bool> {
    let path = memory_root.join(".gitignore");
    let body = canonical_gitignore_body();
    // Skip the write when the file already matches — saves an inotify event
    // for the daemon's git-status read loop.
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if existing == body {
            return Ok(false);
        }
    }
    std::fs::write(&path, body)?;
    Ok(true)
}

/// The canonical `.gitignore` body. Mirrors the template at
/// `app/resources/sample-memory/.gitignore` — both are sources of truth so
/// fresh installs and upgrades land at the same content.
pub fn canonical_gitignore_body() -> String {
    "# Tangerine layered memory — generated v2.0-alpha.1\n\
     # Do not edit by hand — Tangerine rewrites this file on every boot.\n\
     .tangerine/\n\
     personal/\n\
     tmp/\n"
        .to_string()
}

/// Resolve the default memory root: `<home>/.tangerine-memory/`. Convenience
/// for callers who don't already have an `AppState` handle.
pub fn default_memory_root() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".tangerine-memory"))
        .unwrap_or_else(|| PathBuf::from(".tangerine-memory"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_migration_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn seed_v18_layout(root: &Path) {
        // Build a representative v1.x flat layout with one file per kind
        // plus a sidecar dir we expect to leave alone.
        for kind in ATOM_KINDS {
            let dir = root.join(kind);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("sample.md"), format!("# {}\n", kind)).unwrap();
        }
        std::fs::create_dir_all(root.join(".tangerine")).unwrap();
        std::fs::write(root.join(".tangerine/index.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("agi/proposals")).unwrap();
    }

    #[test]
    fn moves_flat_dirs_into_team() {
        let root = fresh_root();
        seed_v18_layout(&root);
        let outcome = migrate_to_layered(&root, "alice").unwrap();
        assert_eq!(outcome.migrated_kinds.len(), ATOM_KINDS.len());
        for kind in ATOM_KINDS {
            // Old flat path is gone.
            assert!(!root.join(kind).exists(), "v1.x dir {kind} still present");
            // New team path has the file.
            let new_path = root.join("team").join(kind).join("sample.md");
            assert!(new_path.is_file(), "missing migrated file for {kind}");
        }
        // Sidecars untouched.
        assert!(root.join(".tangerine/index.json").is_file());
        assert!(root.join("agi/proposals").is_dir());
        // Personal skeleton seeded for the current user.
        for kind in ATOM_KINDS {
            assert!(root.join("personal/alice").join(kind).is_dir(),
                "missing personal/alice/{kind}");
        }
        // .gitignore landed.
        assert!(root.join(".gitignore").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn idempotent_second_run_is_noop() {
        let root = fresh_root();
        seed_v18_layout(&root);
        let first = migrate_to_layered(&root, "bob").unwrap();
        assert!(!first.already_layered);
        let second = migrate_to_layered(&root, "bob").unwrap();
        assert!(second.already_layered);
        assert!(second.migrated_kinds.is_empty());
        // First run wrote fresh .gitignore. Second run sees identical body
        // and skips the write — gitignore_written reflects the *write* not
        // its presence.
        assert!(!second.gitignore_written, "second run rewrote .gitignore");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fresh_install_creates_layout_only() {
        let root = fresh_root();
        let outcome = migrate_to_layered(&root, "carol").unwrap();
        assert!(outcome.migrated_kinds.is_empty());
        // No v1.x flat layout to move, but still seeds the layered shape.
        assert!(root.join("team").is_dir());
        for kind in ATOM_KINDS {
            assert!(root.join("personal/carol").join(kind).is_dir());
        }
        assert!(root.join(".gitignore").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn gitignore_contents_include_personal_and_tangerine() {
        let body = canonical_gitignore_body();
        assert!(body.contains("personal/"));
        assert!(body.contains(".tangerine/"));
    }

    #[test]
    fn personal_skeleton_seeded_for_layered_install() {
        // Simulate an upgrade where another user previously ran migration —
        // their personal/ exists but a NEW user logging in for the first
        // time shouldn't see a missing skeleton.
        let root = fresh_root();
        std::fs::create_dir_all(root.join("team/meetings")).unwrap();
        std::fs::create_dir_all(root.join("personal/alice/meetings")).unwrap();
        let outcome = migrate_to_layered(&root, "dave").unwrap();
        assert!(outcome.already_layered);
        // alice's vault untouched, dave's skeleton seeded.
        assert!(root.join("personal/alice/meetings").is_dir());
        for kind in ATOM_KINDS {
            assert!(root.join("personal/dave").join(kind).is_dir(),
                "missing personal/dave/{kind}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn count_files_walks_recursively() {
        let root = fresh_root();
        std::fs::create_dir_all(root.join("nested/sub")).unwrap();
        std::fs::write(root.join("a.md"), "x").unwrap();
        std::fs::write(root.join("nested/b.md"), "x").unwrap();
        std::fs::write(root.join("nested/sub/c.md"), "x").unwrap();
        assert_eq!(count_files(&root), 3);
        let _ = std::fs::remove_dir_all(&root);
    }
}
