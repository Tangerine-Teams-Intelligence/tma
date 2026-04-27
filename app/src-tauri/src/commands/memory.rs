//! Perf (API_SURFACE_SPEC §5): `resolve_memory_root` / `list_atoms` are read
//! commands → 50 ms p95. `init_memory_with_samples` is a write command → 200 ms
//! p95 (bundled sample copy is < 50 small files).
//!
//! Memory layer commands.
//!
//! `resolve_memory_root` returns the absolute path to the user's memory dir
//! (`<home>/.tangerine-memory/`). The frontend uses this instead of guessing
//! `$HOME` via brittle string handling.
//!
//! `init_memory_with_samples` is called on first-run when the memory dir is
//! empty. It copies the bundled sample files (under `<resource>/sample-memory/`)
//! into the user's memory dir so the Memory browser shows a populated tree
//! immediately. Returns the resolved root path so the caller can refresh.
//!
//! `list_atoms` walks the union of `<root>/team/{kind}/` and
//! `<root>/personal/<user>/{kind}/` and returns one entry per atom, decorated
//! with the scope tag (`"team" | "personal"`) so the React tree can render a
//! subtle indicator for personal notes. v1.x callers that bypass `list_atoms`
//! (the React-side `walkMemoryTree` reader) keep working — this command is
//! the v2.0 shape, and the tree reader is updated to call into it once the
//! frontend lights up the personal-vault toggle.
//!
//! All commands are idempotent and never crash on missing dirs / permission
//! errors — they degrade to a no-op + return the path so the UI stays usable.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use super::AppError;
use crate::memory_paths::{resolve_atom_dir, AtomScope, ATOM_KINDS};

/// Default memory root: `<home>/.tangerine-memory/`. Created on demand.
fn memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

#[derive(Debug, Serialize)]
pub struct MemoryRootInfo {
    pub path: String,
    pub exists: bool,
    pub is_empty: bool,
}

#[tauri::command]
pub async fn resolve_memory_root() -> Result<MemoryRootInfo, AppError> {
    let root = memory_root()?;
    let exists = root.is_dir();
    let is_empty = if exists {
        match std::fs::read_dir(&root) {
            Ok(mut it) => it.next().is_none(),
            Err(_) => true,
        }
    } else {
        true
    };
    Ok(MemoryRootInfo {
        path: root.to_string_lossy().to_string(),
        exists,
        is_empty,
    })
}

#[derive(Debug, Serialize)]
pub struct InitMemoryResult {
    /// Resolved memory root.
    pub path: String,
    /// True when sample files were just copied. False when the dir was already
    /// populated (or copy failed silently — see `error`).
    pub seeded: bool,
    /// Number of files copied. 0 when `seeded` is false.
    pub copied: u32,
    /// Optional error when copy failed but we still resolved a path.
    pub error: Option<String>,
}

#[tauri::command]
pub async fn init_memory_with_samples<R: Runtime>(
    app: AppHandle<R>,
) -> Result<InitMemoryResult, AppError> {
    let root = memory_root()?;
    let path_str = root.to_string_lossy().to_string();

    // mkdir -p the memory root (no-op if it exists).
    if let Err(e) = std::fs::create_dir_all(&root) {
        return Ok(InitMemoryResult {
            path: path_str,
            seeded: false,
            copied: 0,
            error: Some(format!("mkdir failed: {}", e)),
        });
    }

    // Only seed if user-facing folders are all empty/missing — never overwrite
    // the user's own files. We check ONLY the user-facing memory folders
    // (meetings, decisions, people, projects, threads, glossary), NOT sidecar
    // dirs (.tangerine, timeline) which the daemon writes on first heartbeat.
    // Without this, the daemon racing the seed effect would pre-populate
    // those sidecars and cause us to skip the actual sample seeding.
    const USER_FACING: &[&str] = &[
        "meetings",
        "decisions",
        "people",
        "projects",
        "threads",
        "glossary",
    ];
    let mut user_dirs_have_content = false;
    for folder in USER_FACING {
        let p = root.join(folder);
        if p.is_dir() {
            if let Ok(mut it) = std::fs::read_dir(&p) {
                if it.next().is_some() {
                    user_dirs_have_content = true;
                    break;
                }
            }
        }
    }
    if user_dirs_have_content {
        return Ok(InitMemoryResult {
            path: path_str,
            seeded: false,
            copied: 0,
            error: None,
        });
    }

    // Resolve the bundled sample dir from the Tauri resource dir. In `tauri
    // dev` this is the source `resources/`; in installed builds it's the
    // app-relative resource dir set by the bundle config.
    let resource_dir = match app.path().resource_dir() {
        Ok(r) => r,
        Err(e) => {
            return Ok(InitMemoryResult {
                path: path_str,
                seeded: false,
                copied: 0,
                error: Some(format!("resource_dir failed: {}", e)),
            });
        }
    };
    let sample_root = resource_dir.join("resources").join("sample-memory");
    let sample_root = if sample_root.is_dir() {
        sample_root
    } else {
        // Fallback for `cargo tauri dev` where resources/ may live one level up
        // from the resource_dir. Try the dev path before giving up.
        resource_dir.join("sample-memory")
    };

    if !sample_root.is_dir() {
        return Ok(InitMemoryResult {
            path: path_str,
            seeded: false,
            copied: 0,
            error: Some(format!(
                "sample-memory dir not found at {}",
                sample_root.display()
            )),
        });
    }

    let mut copied: u32 = 0;
    if let Err(e) = copy_dir_recursive(&sample_root, &root, &mut copied) {
        return Ok(InitMemoryResult {
            path: path_str,
            seeded: false,
            copied,
            error: Some(format!("copy failed: {}", e)),
        });
    }

    Ok(InitMemoryResult {
        path: path_str,
        seeded: true,
        copied,
        error: None,
    })
}

fn copy_dir_recursive(src: &Path, dst: &Path, count: &mut u32) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&from, &to, count)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)?;
            *count += 1;
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ResetSamplesArgs {
    pub confirm: bool,
}

// ---------------------------------------------------------------------------
// v2.0-alpha.1 — `list_atoms` unions team/ + personal/<user>/.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Default)]
pub struct ListAtomsArgs {
    /// User alias for the personal-vault lookup. Omit to use "me".
    #[serde(default)]
    pub current_user: Option<String>,
    /// When false, skip the personal vault entirely (used by the optional
    /// `personalDirEnabled = false` toggle on the React side). Defaults to
    /// true so the union view is the standard.
    #[serde(default = "default_true")]
    pub include_personal: bool,
    /// Which kinds to walk. Empty → every kind in `ATOM_KINDS`.
    #[serde(default)]
    pub kinds: Vec<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct AtomEntry {
    /// Path relative to the memory root, with forward slashes.
    pub rel_path: String,
    /// Atom kind ("meetings" / "decisions" / ...).
    pub kind: String,
    /// "team" | "personal".
    pub scope: String,
    /// File name with .md suffix.
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct ListAtomsResult {
    pub root: String,
    pub atoms: Vec<AtomEntry>,
    /// True when the personal vault was included in the walk.
    pub personal_included: bool,
}

/// Walk the team and (optionally) personal vaults under the resolved memory
/// root, returning one `AtomEntry` per .md file. Missing dirs are silently
/// skipped — a brand-new install with no atoms yet returns an empty list,
/// which is the same contract `walkMemoryTree` exposes on the frontend.
#[tauri::command(rename_all = "snake_case")]
pub async fn list_atoms(
    args: Option<ListAtomsArgs>,
) -> Result<ListAtomsResult, AppError> {
    let args = args.unwrap_or_default();
    let root = memory_root()?;
    let user = args
        .current_user
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("me");

    let kinds: Vec<&str> = if args.kinds.is_empty() {
        ATOM_KINDS.to_vec()
    } else {
        // Filter user-supplied kinds against the canonical set so a typo
        // doesn't read an arbitrary subdir.
        args.kinds
            .iter()
            .filter_map(|k| ATOM_KINDS.iter().find(|&&canon| canon == k.as_str()).copied())
            .collect()
    };

    let mut atoms: Vec<AtomEntry> = Vec::new();
    for kind in &kinds {
        // Team
        let team_dir = resolve_atom_dir(&root, AtomScope::Team, user, kind);
        collect_atoms_into(&root, &team_dir, kind, AtomScope::Team, &mut atoms);
        // Personal
        if args.include_personal {
            let personal_dir = resolve_atom_dir(&root, AtomScope::Personal, user, kind);
            collect_atoms_into(&root, &personal_dir, kind, AtomScope::Personal, &mut atoms);
        }
    }

    // Stable order: kind asc, then scope asc (team before personal alphabetically),
    // then name asc.
    atoms.sort_by(|a, b| {
        a.kind
            .cmp(&b.kind)
            .then_with(|| a.scope.cmp(&b.scope))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(ListAtomsResult {
        root: root.to_string_lossy().to_string(),
        atoms,
        personal_included: args.include_personal,
    })
}

/// Recursively collect .md files under `dir`, building rel paths from
/// `memory_root`. Missing dirs are no-ops so partial layouts don't error.
fn collect_atoms_into(
    memory_root: &Path,
    dir: &Path,
    kind: &str,
    scope: AtomScope,
    out: &mut Vec<AtomEntry>,
) {
    if !dir.is_dir() {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            // Nested subdirs (e.g. threads/email/, threads/voice/) — recurse.
            collect_atoms_into(memory_root, &path, kind, scope, out);
            continue;
        }
        if !name.to_lowercase().ends_with(".md") {
            continue;
        }
        let rel = match path.strip_prefix(memory_root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        out.push(AtomEntry {
            rel_path: rel,
            kind: kind.to_string(),
            scope: scope.as_str().to_string(),
            name,
        });
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
            "tii_memcmd_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn collect_atoms_walks_kind_dir() {
        let root = fresh_root();
        let dir = root.join("team/meetings");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "x").unwrap();
        std::fs::write(dir.join("b.md"), "x").unwrap();
        std::fs::write(dir.join(".hidden.md"), "x").unwrap();

        let mut atoms: Vec<AtomEntry> = Vec::new();
        collect_atoms_into(&root, &dir, "meetings", AtomScope::Team, &mut atoms);
        assert_eq!(atoms.len(), 2, "got {:?}", atoms);
        for a in &atoms {
            assert_eq!(a.scope, "team");
            assert_eq!(a.kind, "meetings");
            assert!(a.rel_path.starts_with("team/meetings/"));
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn collect_atoms_handles_missing_dir() {
        let root = fresh_root();
        let mut atoms: Vec<AtomEntry> = Vec::new();
        collect_atoms_into(
            &root,
            &root.join("does/not/exist"),
            "meetings",
            AtomScope::Team,
            &mut atoms,
        );
        assert!(atoms.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn collect_atoms_recurses_into_subdirs() {
        // threads/email/foo.md and threads/voice/bar.md should both surface.
        let root = fresh_root();
        let email = root.join("team/threads/email");
        let voice = root.join("team/threads/voice");
        std::fs::create_dir_all(&email).unwrap();
        std::fs::create_dir_all(&voice).unwrap();
        std::fs::write(email.join("foo.md"), "x").unwrap();
        std::fs::write(voice.join("bar.md"), "x").unwrap();
        let mut atoms: Vec<AtomEntry> = Vec::new();
        collect_atoms_into(&root, &root.join("team/threads"), "threads", AtomScope::Team, &mut atoms);
        assert_eq!(atoms.len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }
}
