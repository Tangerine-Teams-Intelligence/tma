// === wave 13 ===
//! Wave 13 — demo seed for the populated-app first-launch experience.
//!
//! Wave 12+14 lesson: a fresh user installing the app and landing on /today
//! sees "0 ATOMS TODAY" / "Nothing captured yet" / empty graph. Without
//! context for what a populated app *looks* like, the user assumes broken or
//! worthless and bounces. Wave 13 fixes this with a richer sample dataset
//! that gets installed automatically on truly-fresh first launch (no
//! `~/.tangerine-memory/` at all, or it exists but is wholly empty), and a
//! "Showing sample team data" banner the user can dismiss or replace via
//! the existing GitInitBanner / SetupWizard flows.
//!
//! This module sits next to `commands::memory::init_memory_with_samples`.
//! That older flow copies a tiny 3-file flat-layout seed (decisions/ +
//! meetings/ at the memory root). It runs on every install. Wave 13's
//! `demo_seed_install` copies the *richer* layered-layout sample tree
//! (`team/co-thinker.md`, `team/decisions/<date>-<slug>.md`,
//! `team/timeline/<date>.md`, `personal/<user>/threads/<vendor>/...`,
//! `agi/observations/<date>.md`) and is gated behind the `is_demo` store
//! flag. The two flows do NOT overlap — Wave 13 writes paths the older
//! flow never touched.
//!
//! Three commands:
//!   - `demo_seed_check`   → `{ is_demo, sample_count }`  (read-only)
//!   - `demo_seed_install` → `{ ok, copied_files }`       (idempotent copy)
//!   - `demo_seed_clear`   → `{ removed_files }`          (drops `sample: true` files)
//!
//! Resource resolution mirrors `init_memory_with_samples`: we look under
//! `<resource_dir>/resources/sample-memory/` first (installed builds), with
//! a fallback to `<resource_dir>/sample-memory/` for `cargo tauri dev`.
//!
//! Sample-flagged-only cleanup is critical so a user who has been running
//! the app for weeks and replaced the seed with real content doesn't lose
//! their team data when they hit "Hide" on the demo banner. Every file we
//! seed has `sample: true` in its YAML frontmatter, and `demo_seed_clear`
//! only removes files that still carry that flag (i.e. unmodified seed).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use super::AppError;

/// Default memory root: `<home>/.tangerine-memory/`. Mirrors the resolver
/// in `commands::memory` — we duplicate the helper here to keep this
/// module independent of the older flat-layout seeder (Wave 12 / Wave 14
/// may rename / move that one and we don't want a transitive break).
fn memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// Resolve the bundled sample dir from the Tauri resource dir. Two
/// candidate paths: the installed-build location under `resources/`, and
/// the dev-only location directly under `resource_dir`. Returns the first
/// that exists; `None` when neither does (e.g. mis-bundled install).
fn resolve_sample_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let installed = resource_dir.join("resources").join("sample-memory");
    if installed.is_dir() {
        return Some(installed);
    }
    let dev = resource_dir.join("sample-memory");
    if dev.is_dir() {
        return Some(dev);
    }
    None
}

#[derive(Debug, Serialize)]
pub struct DemoSeedCheckResult {
    /// Mirrors the React store's `ui.demoMode` flag — but the source of
    /// truth here is "are sample files actually on disk?" So we report
    /// `true` whenever the memory root contains at least one seeded file.
    pub is_demo: bool,
    /// Number of files under the memory root that carry `sample: true`
    /// in their YAML frontmatter. Used by the React banner / Settings
    /// page to render "12 sample files installed — clear them?"
    pub sample_count: u32,
}

/// Read-only check — count sample-flagged files under the memory root.
/// Always succeeds; missing memory root returns `{is_demo: false, count: 0}`.
#[tauri::command]
pub async fn demo_seed_check() -> Result<DemoSeedCheckResult, AppError> {
    let root = memory_root()?;
    if !root.is_dir() {
        return Ok(DemoSeedCheckResult {
            is_demo: false,
            sample_count: 0,
        });
    }
    let count = count_sample_files(&root);
    Ok(DemoSeedCheckResult {
        is_demo: count > 0,
        sample_count: count,
    })
}

#[derive(Debug, Serialize)]
pub struct DemoSeedInstallResult {
    /// True when the copy attempt completed without error (even if 0 files
    /// were copied because the seed was already present). False when the
    /// resource dir / sample dir / memory root were unreachable.
    pub ok: bool,
    /// Number of new files written. 0 on a re-run that found everything
    /// already present.
    pub copied_files: u32,
    /// Optional human-readable error when `ok` is false.
    pub error: Option<String>,
}

/// Idempotent install — copy every file under `resources/sample-memory/`
/// into the memory root. Files that already exist (by path) are skipped.
/// This makes the command safe to re-call (e.g. on every cold launch
/// when the user is in demo mode).
#[tauri::command]
pub async fn demo_seed_install<R: Runtime>(
    app: AppHandle<R>,
) -> Result<DemoSeedInstallResult, AppError> {
    let root = memory_root()?;
    if let Err(e) = std::fs::create_dir_all(&root) {
        return Ok(DemoSeedInstallResult {
            ok: false,
            copied_files: 0,
            error: Some(format!("mkdir failed: {}", e)),
        });
    }

    let sample_root = match resolve_sample_dir(&app) {
        Some(p) => p,
        None => {
            return Ok(DemoSeedInstallResult {
                ok: false,
                copied_files: 0,
                error: Some("sample-memory dir not found in resources".to_string()),
            });
        }
    };

    let mut copied: u32 = 0;
    if let Err(e) = copy_demo_recursive(&sample_root, &root, &mut copied) {
        return Ok(DemoSeedInstallResult {
            ok: false,
            copied_files: copied,
            error: Some(format!("copy failed: {}", e)),
        });
    }

    Ok(DemoSeedInstallResult {
        ok: true,
        copied_files: copied,
        error: None,
    })
}

#[derive(Debug, Serialize)]
pub struct DemoSeedClearResult {
    /// Number of files removed (only files carrying `sample: true` in
    /// YAML frontmatter; user-modified or user-authored files are left
    /// untouched).
    pub removed_files: u32,
}

/// Remove every file under the memory root whose YAML frontmatter carries
/// `sample: true`. User content (no frontmatter, or `sample` absent /
/// false) is untouched. Empty dirs left after removal are pruned so the
/// memory tree doesn't keep ghost folders.
#[tauri::command]
pub async fn demo_seed_clear() -> Result<DemoSeedClearResult, AppError> {
    let root = memory_root()?;
    if !root.is_dir() {
        return Ok(DemoSeedClearResult { removed_files: 0 });
    }
    let mut removed: u32 = 0;
    remove_sample_files(&root, &mut removed);
    prune_empty_dirs(&root);
    Ok(DemoSeedClearResult {
        removed_files: removed,
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Idempotent file-only recursive copy. Files that already exist at the
/// destination are skipped (we never overwrite — the user's edits to a
/// previously-seeded file are sacred). Empty dirs are created on demand.
fn copy_demo_recursive(src: &Path, dst: &Path, count: &mut u32) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_demo_recursive(&from, &to, count)?;
        } else if ty.is_file() {
            // Skip dotfiles like .gitignore that ship in the resource bundle —
            // they're for git hygiene, not for the user's memory tree.
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with('.') {
                    continue;
                }
            }
            if to.exists() {
                continue;
            }
            std::fs::copy(&from, &to)?;
            *count += 1;
        }
    }
    Ok(())
}

/// Walk the memory root and count every file that carries `sample: true`
/// in its YAML frontmatter. Non-markdown files are skipped (sample data
/// only ships .md). Errors from individual file reads are swallowed —
/// the count is a UI hint, not a security boundary.
fn count_sample_files(root: &Path) -> u32 {
    let mut n: u32 = 0;
    walk_files(root, &mut |path| {
        if is_sample_file(path) {
            n += 1;
        }
    });
    n
}

/// Walk the memory root and remove every file that carries `sample: true`
/// in its frontmatter. See `count_sample_files` for the predicate; same
/// rules apply.
fn remove_sample_files(root: &Path, removed: &mut u32) {
    walk_files(root, &mut |path| {
        if is_sample_file(path) {
            if std::fs::remove_file(path).is_ok() {
                *removed += 1;
            }
        }
    });
}

/// True when the file's first ~30 lines contain `sample: true` inside a
/// YAML frontmatter block (lines bounded by `---` markers). We only scan
/// the head of the file so a giant transcript with the substring buried
/// in body text doesn't false-positive.
fn is_sample_file(path: &Path) -> bool {
    if path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md"))
        != Some(true)
    {
        return false;
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    // Frontmatter must start at line 0 with `---`. If not, no frontmatter.
    let mut lines = content.lines();
    let first = match lines.next() {
        Some(l) => l.trim(),
        None => return false,
    };
    if first != "---" {
        return false;
    }
    // Scan up to 30 frontmatter lines for `sample: true`. Bail at the
    // closing `---`.
    for (i, line) in lines.enumerate() {
        if i > 30 {
            return false;
        }
        let trimmed = line.trim();
        if trimmed == "---" {
            return false;
        }
        // Tolerant match: accept `sample: true`, `sample:true`,
        // `sample : true` and the YAML bool aliases the user may
        // have hand-edited.
        let lower = trimmed.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("sample") {
            let rest = rest.trim_start();
            if let Some(rest) = rest.strip_prefix(':') {
                let val = rest.trim();
                if val == "true" || val == "yes" || val == "y" {
                    return true;
                }
            }
        }
    }
    false
}

/// Generic file-walker that calls `cb` for every regular file under
/// `root`. Hidden dirs (.tangerine etc.) are walked too — the demo seed
/// doesn't write into them, but a user who manually placed a sample
/// inside them (rare but possible) should still be reachable by clear.
fn walk_files(root: &Path, cb: &mut impl FnMut(&Path)) {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let ty = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ty.is_dir() {
            walk_files(&path, cb);
        } else if ty.is_file() {
            cb(&path);
        }
    }
}

/// Best-effort cleanup — remove any directory under `root` that became
/// empty after `demo_seed_clear` ran. We never remove `root` itself.
fn prune_empty_dirs(root: &Path) {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e.collect::<Vec<_>>(),
        Err(_) => return,
    };
    for entry in entries.into_iter().flatten() {
        let path = entry.path();
        let ty = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ty.is_dir() {
            continue;
        }
        // Recurse first so we prune leaves before parents.
        prune_empty_dirs(&path);
        if let Ok(mut it) = std::fs::read_dir(&path) {
            if it.next().is_none() {
                let _ = std::fs::remove_dir(&path);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_demoseed_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_sample(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let content = format!("---\nsample: true\nauthor: tangerine\n---\n\n{}\n", body);
        std::fs::write(path, content).unwrap();
    }

    fn write_user(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        // No frontmatter — pure user note.
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn install_copies_files_to_empty_root() {
        // Stage a fake sample-memory dir + a fake memory root, run the copy
        // helper directly (the Tauri command can't run without an AppHandle).
        let src = fresh_root();
        let dst = fresh_root();
        write_sample(
            &src.join("team/decisions/sample-a.md"),
            "decision a body",
        );
        write_sample(
            &src.join("team/decisions/sample-b.md"),
            "decision b body",
        );
        write_sample(
            &src.join("personal/alex/threads/cursor/c.md"),
            "thread c body",
        );

        let mut count: u32 = 0;
        copy_demo_recursive(&src, &dst, &mut count).unwrap();
        assert_eq!(count, 3);
        assert!(dst.join("team/decisions/sample-a.md").exists());
        assert!(dst.join("personal/alex/threads/cursor/c.md").exists());

        // Cleanup
        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dst);
    }

    #[test]
    fn install_is_idempotent() {
        // Run twice — second run copies 0 files because every dest already
        // exists. User edits are preserved (we never overwrite).
        let src = fresh_root();
        let dst = fresh_root();
        write_sample(&src.join("team/decisions/x.md"), "v1 body");

        let mut c1: u32 = 0;
        copy_demo_recursive(&src, &dst, &mut c1).unwrap();
        assert_eq!(c1, 1);

        // Edit the dest file to simulate user edits.
        std::fs::write(dst.join("team/decisions/x.md"), "EDITED BY USER").unwrap();

        // Re-run.
        let mut c2: u32 = 0;
        copy_demo_recursive(&src, &dst, &mut c2).unwrap();
        assert_eq!(c2, 0, "second copy should skip existing files");
        let after = std::fs::read_to_string(dst.join("team/decisions/x.md")).unwrap();
        assert_eq!(after, "EDITED BY USER", "user edit must survive re-run");

        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dst);
    }

    #[test]
    fn clear_removes_only_sample_flagged_files() {
        // Plant 2 sample-flagged + 2 user-authored files. Clear should
        // remove only the sample-flagged pair. Empty dirs left behind
        // are pruned.
        let root = fresh_root();
        write_sample(&root.join("team/decisions/sample-1.md"), "");
        write_sample(&root.join("team/timeline/sample-2.md"), "");
        write_user(&root.join("team/decisions/my-real-decision.md"), "real");
        write_user(&root.join("team/people/my-real-person.md"), "real");

        let pre = count_sample_files(&root);
        assert_eq!(pre, 2);

        let mut removed: u32 = 0;
        remove_sample_files(&root, &mut removed);
        prune_empty_dirs(&root);
        assert_eq!(removed, 2);

        // User files must survive.
        assert!(root.join("team/decisions/my-real-decision.md").exists());
        assert!(root.join("team/people/my-real-person.md").exists());
        // Sample files must be gone.
        assert!(!root.join("team/decisions/sample-1.md").exists());
        assert!(!root.join("team/timeline/sample-2.md").exists());
        // Empty timeline/ dir should have been pruned.
        assert!(!root.join("team/timeline").exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn count_returns_zero_on_missing_root() {
        // Pointing at a non-existent path returns 0 without panicking. The
        // public `demo_seed_check` command short-circuits on `!is_dir()`,
        // so this test exercises the lower-level walker on a present-but-
        // empty directory to confirm the same.
        let root = fresh_root();
        assert_eq!(count_sample_files(&root), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn is_sample_file_requires_frontmatter_at_top() {
        // Body containing the substring `sample: true` must not match —
        // the predicate only inspects the YAML frontmatter at line 0.
        let root = fresh_root();
        let p = root.join("decoy.md");
        std::fs::write(
            &p,
            "# header\n\nlater in the body: sample: true happens here\n",
        )
        .unwrap();
        assert!(!is_sample_file(&p), "body match must not count");

        let p2 = root.join("real-sample.md");
        std::fs::write(&p2, "---\nsample: true\n---\n\nbody\n").unwrap();
        assert!(is_sample_file(&p2));

        let p3 = root.join("non-sample.md");
        std::fs::write(&p3, "---\nsample: false\nauthor: alex\n---\n\nbody\n").unwrap();
        assert!(!is_sample_file(&p3));

        let _ = std::fs::remove_dir_all(&root);
    }
}
// === end wave 13 ===
