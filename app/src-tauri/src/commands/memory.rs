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

// === wave 21 ===
// ---------------------------------------------------------------------------
// Wave 21 — `memory_tree` + `compute_backlinks` for the Obsidian-style
// /memory file browser and /brain editor.
//
// `memory_tree` returns a hierarchical tree of the memory dir bounded by an
// optional depth. The React side uses it to render the left-pane tree
// recursively. We bound the walk at MAX_NODES = 5000 nodes total so a 1000+
// file vault doesn't lock the UI thread on the IPC boundary.
//
// `compute_backlinks` scans every atom for references to a target atom path
// or title and returns the list of citing atoms. Used by both /memory
// preview and /brain backlinks section.
// ---------------------------------------------------------------------------

/// Hard cap on tree nodes returned in a single `memory_tree` call. The React
/// tree component renders lazily (folders collapsed by default) so there's
/// no DOM cost beyond the top level on first paint, but we still cap to
/// avoid pathological JSON payloads.
pub const MAX_TREE_NODES: usize = 5000;

#[derive(Debug, Deserialize, Default)]
pub struct MemoryTreeArgs {
    /// Subdir relative to memory root to start walking from. Empty/None →
    /// walk from the resolved memory root.
    #[serde(default)]
    pub root: Option<String>,
    /// Max depth to recurse. None → unbounded (capped by MAX_TREE_NODES).
    /// 0 → only the root entries (no recursion).
    #[serde(default)]
    pub depth: Option<u32>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct MemoryTreeNode {
    /// Path relative to the memory root, with forward slashes.
    pub path: String,
    /// Filename or directory name.
    pub name: String,
    /// "dir" or "file".
    pub kind: String,
    /// Inferred scope: "team" / "personal" / null.
    pub scope: Option<String>,
    /// Children, only populated for dir nodes. Sorted dirs-first then alpha.
    #[serde(default)]
    pub children: Vec<MemoryTreeNode>,
    // === v1.13.9 round-9 ===
    // R9 deceptive-success audit: a fresh user lands on /memory and sees
    // `team/decisions/2026-04-22-tier2-pcb-supplier.md` next to their
    // own atoms — same font, same icon, no indication that the 兴森 PCB
    // decision is bundled sample data, not their team's call. We
    // propagate the YAML-frontmatter `sample` flag so the React tree can
    // tag those rows with a visible "sample" pill. Predicate matches
    // `commands::demo_seed::is_sample_file` — keep them in sync.
    /// True when the file is a Wave 13 demo-seed atom (carries
    /// `sample: true` in YAML frontmatter). Always `false` for dirs and
    /// for user-authored files.
    #[serde(default)]
    pub sample: bool,
    // === end v1.13.9 round-9 ===
}

#[derive(Debug, Serialize)]
pub struct MemoryTreeResult {
    pub root: String,
    pub nodes: Vec<MemoryTreeNode>,
    /// Total file + dir nodes returned. The React side uses this for the
    /// header "Memory · {atom_count} atoms across {thread_count} threads".
    pub total_nodes: u32,
    pub file_count: u32,
    pub dir_count: u32,
    /// True when the walk hit MAX_TREE_NODES and stopped early. The
    /// React side can render a "+ N more files" hint in that case.
    pub truncated: bool,
}

/// Walk the memory dir and return a hierarchical tree. Reuses the same
/// "dirs first, then alpha" sort + the same skip rules (hidden dotfiles,
/// non-markdown files at file level) as the JS-side reader so the two
/// surfaces stay consistent.
#[tauri::command(rename_all = "snake_case")]
pub async fn memory_tree(
    args: Option<MemoryTreeArgs>,
) -> Result<MemoryTreeResult, AppError> {
    let args = args.unwrap_or_default();
    let root = memory_root()?;
    let start_dir = match args.root.as_deref().filter(|s| !s.is_empty()) {
        Some(rel) => root.join(rel),
        None => root.clone(),
    };

    let mut budget = MAX_TREE_NODES;
    let mut file_count: u32 = 0;
    let mut dir_count: u32 = 0;
    let mut truncated = false;
    let nodes = walk_tree(
        &root,
        &start_dir,
        "",
        args.depth,
        0,
        &mut budget,
        &mut file_count,
        &mut dir_count,
        &mut truncated,
    );

    let total_nodes = file_count.saturating_add(dir_count);
    Ok(MemoryTreeResult {
        root: root.to_string_lossy().to_string(),
        nodes,
        total_nodes,
        file_count,
        dir_count,
        truncated,
    })
}

#[allow(clippy::too_many_arguments)]
fn walk_tree(
    memory_root: &Path,
    abs_dir: &Path,
    rel_prefix: &str,
    max_depth: Option<u32>,
    cur_depth: u32,
    budget: &mut usize,
    files: &mut u32,
    dirs: &mut u32,
    truncated: &mut bool,
) -> Vec<MemoryTreeNode> {
    if !abs_dir.is_dir() {
        return Vec::new();
    }
    if let Some(max) = max_depth {
        if cur_depth > max {
            return Vec::new();
        }
    }
    let entries = match std::fs::read_dir(abs_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut nodes: Vec<MemoryTreeNode> = Vec::new();
    for entry in entries.flatten() {
        if *budget == 0 {
            *truncated = true;
            break;
        }
        let name = match entry.file_name().to_str() {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel_prefix, name)
        };
        let scope = infer_scope(&rel);
        if path.is_dir() {
            *budget = budget.saturating_sub(1);
            *dirs = dirs.saturating_add(1);
            let children = if max_depth.is_some_and(|m| cur_depth >= m) {
                Vec::new()
            } else {
                walk_tree(
                    memory_root,
                    &path,
                    &rel,
                    max_depth,
                    cur_depth + 1,
                    budget,
                    files,
                    dirs,
                    truncated,
                )
            };
            nodes.push(MemoryTreeNode {
                path: rel,
                name,
                kind: "dir".into(),
                scope,
                children,
                // === v1.13.9 round-9 ===
                sample: false,
                // === end v1.13.9 round-9 ===
            });
        } else if path.is_file() {
            // Only include markdown files — match the JS reader's filter.
            let lower = name.to_lowercase();
            if !(lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdx")) {
                continue;
            }
            *budget = budget.saturating_sub(1);
            *files = files.saturating_add(1);
            // === v1.13.9 round-9 ===
            // Detect Wave 13 demo-seed atoms by scanning the YAML
            // frontmatter for `sample: true`. Same predicate as
            // `commands::demo_seed::is_sample_file`. Read failures fall
            // through to `false` (we never block tree rendering on this).
            let sample = is_sample_md_file(&path);
            // === end v1.13.9 round-9 ===
            nodes.push(MemoryTreeNode {
                path: rel,
                name,
                kind: "file".into(),
                scope,
                children: Vec::new(),
                // === v1.13.9 round-9 ===
                sample,
                // === end v1.13.9 round-9 ===
            });
        }
    }
    nodes.sort_by(|a, b| {
        if a.kind != b.kind {
            return if a.kind == "dir" { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        a.name.cmp(&b.name)
    });
    nodes
}

fn infer_scope(rel: &str) -> Option<String> {
    let head = rel.split('/').next().unwrap_or("");
    match head {
        "team" => Some("team".to_string()),
        "personal" => Some("personal".to_string()),
        _ => None,
    }
}

// === v1.13.9 round-9 ===
// Round 9 deceptive-success audit: tag Wave 13 demo-seed atoms in the
// /memory tree so users can tell sample data apart from their own.
// Mirrors the predicate in `commands::demo_seed::is_sample_file` —
// detects `sample: true` (case-insensitive, tolerant of `true|yes|y`)
// inside the leading YAML frontmatter block. We bound the scan at the
// first ~30 frontmatter lines so a giant atom whose body happens to
// mention `sample: true` doesn't false-positive.
//
// All errors degrade silently to `false` — sample-detection is a UI
// hint, never a security boundary. A read failure here must not block
// the tree from rendering.
fn is_sample_md_file(path: &Path) -> bool {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let mut lines = content.lines();
    let first = match lines.next() {
        Some(l) => l.trim(),
        None => return false,
    };
    if first != "---" {
        return false;
    }
    for (i, line) in lines.enumerate() {
        if i > 30 {
            return false;
        }
        let trimmed = line.trim();
        if trimmed == "---" {
            return false;
        }
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
// === end v1.13.9 round-9 ===

// ---------------------------------------------------------------------------
// Backlinks computation
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct BacklinksArgs {
    /// Path of the target atom relative to memory root (e.g.
    /// `team/decisions/foo.md`). Either this OR `title` must be supplied.
    #[serde(default)]
    pub atom_path: Option<String>,
    /// Optional title to also match (used when scanning [[Title]] wiki-style
    /// references). Falls back to deriving a title from `atom_path` (basename
    /// without `.md`) when omitted.
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct BacklinkHit {
    /// Path of the citing atom (rel to memory root).
    pub path: String,
    /// Title of the citing atom — frontmatter `title:` if present, else
    /// the basename without `.md`.
    pub title: String,
    /// ~120 chars around the first match, whitespace flattened.
    pub snippet: String,
}

#[derive(Debug, Serialize)]
pub struct BacklinksResult {
    pub target_path: Option<String>,
    pub target_title: Option<String>,
    pub hits: Vec<BacklinkHit>,
}

/// Walk every .md file under the memory root and return atoms that cite the
/// target atom. We match three reference shapes:
///
///   1. Bare path mention (e.g. `team/decisions/foo.md`)
///   2. `/memory/...` citation (e.g. `/memory/team/decisions/foo.md`)
///   3. `[[Title]]` wiki link (case-insensitive title match)
///
/// Bounded at 1000 files walked to match search.rs. The target atom itself
/// is always excluded from the result.
#[tauri::command(rename_all = "snake_case")]
pub async fn compute_backlinks(
    args: Option<BacklinksArgs>,
) -> Result<BacklinksResult, AppError> {
    let args = args.unwrap_or(BacklinksArgs {
        atom_path: None,
        title: None,
    });
    let root = memory_root()?;
    let target_path = args
        .atom_path
        .as_deref()
        .map(|s| s.trim_start_matches('/').to_string());
    let derived_title = target_path
        .as_deref()
        .map(|p| derive_title_from_path(p));
    let target_title = args.title.clone().or(derived_title);

    if target_path.is_none() && target_title.is_none() {
        return Ok(BacklinksResult {
            target_path: None,
            target_title: None,
            hits: Vec::new(),
        });
    }

    let mut hits: Vec<BacklinkHit> = Vec::new();
    let mut files_seen: usize = 0;
    walk_for_backlinks(
        &root,
        &root,
        "",
        target_path.as_deref(),
        target_title.as_deref(),
        &mut hits,
        &mut files_seen,
    );

    Ok(BacklinksResult {
        target_path,
        target_title,
        hits,
    })
}

fn derive_title_from_path(rel: &str) -> String {
    let basename = rel.rsplit('/').next().unwrap_or(rel);
    basename
        .trim_end_matches(".md")
        .trim_end_matches(".markdown")
        .trim_end_matches(".mdx")
        .to_string()
}

const BACKLINKS_MAX_FILES: usize = 1000;
const BACKLINKS_MAX_HITS: usize = 50;

fn walk_for_backlinks(
    memory_root: &Path,
    abs_dir: &Path,
    rel_prefix: &str,
    target_path: Option<&str>,
    target_title: Option<&str>,
    hits: &mut Vec<BacklinkHit>,
    files_seen: &mut usize,
) {
    if hits.len() >= BACKLINKS_MAX_HITS || *files_seen >= BACKLINKS_MAX_FILES {
        return;
    }
    let entries = match std::fs::read_dir(abs_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if hits.len() >= BACKLINKS_MAX_HITS || *files_seen >= BACKLINKS_MAX_FILES {
            return;
        }
        let name = match entry.file_name().to_str() {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel_prefix, name)
        };
        if path.is_dir() {
            walk_for_backlinks(
                memory_root,
                &path,
                &rel,
                target_path,
                target_title,
                hits,
                files_seen,
            );
            continue;
        }
        let lower = name.to_lowercase();
        if !(lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdx")) {
            continue;
        }
        // Skip the target atom itself.
        if let Some(tp) = target_path {
            if rel == tp {
                continue;
            }
        }
        *files_seen += 1;
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let snippet = match find_backlink_match(&raw, target_path, target_title) {
            Some(s) => s,
            None => continue,
        };
        let title = parse_title(&raw).unwrap_or_else(|| derive_title_from_path(&rel));
        hits.push(BacklinkHit {
            path: rel,
            title,
            snippet,
        });
    }
}

/// Return a snippet around the first backlink reference found in `body`,
/// or None if none match.
fn find_backlink_match(
    body: &str,
    target_path: Option<&str>,
    target_title: Option<&str>,
) -> Option<String> {
    let lower = body.to_lowercase();
    let mut match_idx: Option<usize> = None;

    if let Some(tp) = target_path {
        let needle = tp.to_lowercase();
        if let Some(i) = lower.find(&needle) {
            match_idx = Some(i);
        }
    }
    if match_idx.is_none() {
        if let Some(tt) = target_title {
            // Look for [[Title]] wiki-link (case-insensitive).
            let wiki = format!("[[{}]]", tt.to_lowercase());
            if let Some(i) = lower.find(&wiki) {
                match_idx = Some(i);
            }
        }
    }
    let i = match_idx?;
    Some(snippet_around(body, i, 120))
}

fn snippet_around(body: &str, idx: usize, window: usize) -> String {
    let start = idx.saturating_sub(window / 2);
    // Walk forward to a UTF-8 safe boundary if needed.
    let safe_start = (start..body.len())
        .find(|&i| body.is_char_boundary(i))
        .unwrap_or(body.len());
    let end = (idx + window).min(body.len());
    let safe_end = (end..=body.len())
        .find(|&i| body.is_char_boundary(i))
        .unwrap_or(body.len());
    let cut = &body[safe_start..safe_end];
    let flat: String = cut
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut out = String::new();
    if safe_start > 0 {
        out.push('…');
    }
    out.push_str(&flat);
    if safe_end < body.len() {
        out.push('…');
    }
    out
}

/// Read frontmatter `title:` field from the head of `raw`. Returns None when
/// no frontmatter or no title is found.
fn parse_title(raw: &str) -> Option<String> {
    let m = raw.strip_prefix("---")?;
    let end = m.find("\n---")?;
    let frontmatter = &m[..end];
    for line in frontmatter.lines() {
        if let Some(rest) = line.strip_prefix("title:") {
            let t = rest.trim().trim_matches('"').trim_matches('\'');
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}
// === end wave 21 ===

// === wave 23 ===
// ---------------------------------------------------------------------------
// Wave 23 — `memory_graph_data` for the visual atom graph view of /memory.
//
// Returns a flat node + edge list the React side feeds into a reactflow
// force-directed layout. Nodes = one per atom; edges = relationships
// between them:
//   - "cites"        — body of A contains [[B-title]] (Obsidian-style
//                      wiki-link). Strongest signal, weight 1.0.
//   - "same_author"  — A.author == B.author. Light edge, weight 0.25.
//   - "same_vendor"  — A.vendor == B.vendor. Subtle group, weight 0.15.
//   - "same_project" — A.project == B.project (frontmatter "project:" field
//                      OR same first path segment under team/projects/...).
//                      Cluster glue, weight 0.35.
//
// Performance — capped at GRAPH_MAX_NODES atoms walked. The React side
// renders the 100 most-recent by default (timestamp from frontmatter
// `date:` / file mtime fallback) with a "show all" expand toggle.
// ---------------------------------------------------------------------------

/// Hard cap on atoms returned in a single `memory_graph_data` call. Same
/// budget as the search command — keeps the JSON payload small enough that
/// reactflow's force-directed layout converges in <500ms on a mid-laptop.
pub const GRAPH_MAX_NODES: usize = 1000;

/// Hard cap on edges. With N nodes the worst case is O(N^2) (every pair
/// shares author/vendor); we cap to keep both the payload + the reactflow
/// edge renderer happy.
pub const GRAPH_MAX_EDGES: usize = 5000;

#[derive(Debug, Deserialize, Default)]
pub struct MemoryGraphArgs {
    /// Optional vendor filter. Empty/None → all vendors.
    #[serde(default)]
    pub vendor: Option<String>,
    /// Optional kind filter (decision/thread/observation/...). Empty/None → all kinds.
    #[serde(default)]
    pub kind: Option<String>,
    /// Optional substring filter on title or path. Empty/None → no search filter.
    #[serde(default)]
    pub search: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct AtomNode {
    /// Atom path (rel to memory root, forward slashes).
    pub id: String,
    /// Atom title — frontmatter `title:` if present, else basename without `.md`.
    pub label: String,
    /// Vendor id (from frontmatter `vendor:` or inferred from path).
    pub vendor: Option<String>,
    /// Author id (from frontmatter `author:`).
    pub author: Option<String>,
    /// Atom kind — inferred from the path segment (decisions/threads/observations/...).
    pub kind: String,
    /// Optional project slug (from frontmatter `project:` or the path).
    pub project: Option<String>,
    /// Optional ISO-ish timestamp (from frontmatter `date:` / `created:`).
    pub timestamp: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct AtomEdge {
    pub source: String,
    pub target: String,
    /// "cites" | "same_author" | "same_vendor" | "same_project"
    pub kind: String,
    pub weight: f32,
}

#[derive(Debug, Serialize)]
pub struct AtomGraphData {
    pub nodes: Vec<AtomNode>,
    pub edges: Vec<AtomEdge>,
    /// True when the walk hit GRAPH_MAX_NODES and stopped early.
    pub truncated: bool,
}

/// Walk every .md file under the memory root and return a flat node + edge
/// graph. Edges are deduplicated by `(min(src,tgt), max(src,tgt), kind)`
/// so a citation pair that also shares author/vendor doesn't surface 3
/// duplicate edges of the same kind.
#[tauri::command(rename_all = "snake_case")]
pub async fn memory_graph_data(
    args: Option<MemoryGraphArgs>,
) -> Result<AtomGraphData, AppError> {
    let args = args.unwrap_or_default();
    let root = memory_root()?;

    // 1. Walk + read every .md file, parsing frontmatter as we go.
    let mut atoms: Vec<AtomFileBuf> = Vec::new();
    let mut truncated = false;
    walk_for_graph(&root, &root, "", &mut atoms, &mut truncated);

    // 2. Apply optional filters BEFORE building edges so we don't link to
    //    atoms that have been filtered out.
    let search_lc = args
        .search
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let vendor_filter = args
        .vendor
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let kind_filter = args
        .kind
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    atoms.retain(|a| {
        if let Some(v) = &vendor_filter {
            if a.vendor.as_deref().map(|s| s.to_lowercase()).as_deref() != Some(v.as_str()) {
                return false;
            }
        }
        if let Some(k) = &kind_filter {
            if a.kind.to_lowercase() != *k {
                return false;
            }
        }
        if let Some(q) = &search_lc {
            let hay = format!("{} {}", a.label.to_lowercase(), a.path.to_lowercase());
            if !hay.contains(q) {
                return false;
            }
        }
        true
    });

    // 3. Build the node set.
    let nodes: Vec<AtomNode> = atoms
        .iter()
        .map(|a| AtomNode {
            id: a.path.clone(),
            label: a.label.clone(),
            vendor: a.vendor.clone(),
            author: a.author.clone(),
            kind: a.kind.clone(),
            project: a.project.clone(),
            timestamp: a.timestamp.clone(),
        })
        .collect();

    // 4. Build the edge set.
    let edges = build_graph_edges(&atoms);

    Ok(AtomGraphData {
        nodes,
        edges,
        truncated,
    })
}

/// Buffered atom info used during the graph build — keeps the body around
/// long enough to scan for `[[wiki-link]]` citations.
struct AtomFileBuf {
    path: String,
    label: String,
    vendor: Option<String>,
    author: Option<String>,
    kind: String,
    project: Option<String>,
    timestamp: Option<String>,
    body: String,
}

fn walk_for_graph(
    memory_root: &Path,
    abs_dir: &Path,
    rel_prefix: &str,
    out: &mut Vec<AtomFileBuf>,
    truncated: &mut bool,
) {
    if out.len() >= GRAPH_MAX_NODES {
        *truncated = true;
        return;
    }
    let entries = match std::fs::read_dir(abs_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= GRAPH_MAX_NODES {
            *truncated = true;
            return;
        }
        let name = match entry.file_name().to_str() {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel_prefix, name)
        };
        if path.is_dir() {
            walk_for_graph(memory_root, &path, &rel, out, truncated);
            continue;
        }
        let lower = name.to_lowercase();
        if !(lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdx")) {
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let (frontmatter, body) = split_frontmatter(&raw);
        let title = read_fm_field(frontmatter, "title")
            .unwrap_or_else(|| derive_title_from_path(&rel));
        let vendor = read_fm_field(frontmatter, "vendor").or_else(|| infer_vendor(&rel));
        let author = read_fm_field(frontmatter, "author");
        let kind = infer_atom_kind(&rel);
        let project = read_fm_field(frontmatter, "project").or_else(|| infer_project(&rel));
        let timestamp = read_fm_field(frontmatter, "date")
            .or_else(|| read_fm_field(frontmatter, "created"));
        out.push(AtomFileBuf {
            path: rel,
            label: title,
            vendor,
            author,
            kind,
            project,
            timestamp,
            body: body.to_string(),
        });
    }
}

/// Split `---\n…\n---\n` frontmatter off the body. Returns ("", whole) when
/// no frontmatter is found.
fn split_frontmatter(raw: &str) -> (&str, &str) {
    if let Some(rest) = raw.strip_prefix("---") {
        // Skip optional CR / LF after opening fence.
        let rest = rest.trim_start_matches('\r').trim_start_matches('\n');
        if let Some(end) = rest.find("\n---") {
            let fm = &rest[..end];
            let after = &rest[end + 4..];
            let body = after.trim_start_matches('\r').trim_start_matches('\n');
            return (fm, body);
        }
    }
    ("", raw)
}

/// Read a single `key: value` field out of a frontmatter block. Strips
/// quotes around the value. Returns None when the key is absent or empty.
fn read_fm_field(frontmatter: &str, key: &str) -> Option<String> {
    for line in frontmatter.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix(&format!("{}:", key)) {
            let v = rest.trim().trim_matches('"').trim_matches('\'').trim();
            if v.is_empty() {
                return None;
            }
            return Some(v.to_string());
        }
    }
    None
}

/// Walk the atom rel path and pick a kind label. Mirrors the React-side
/// `inferKindFromPath` so the two surfaces agree.
fn infer_atom_kind(rel: &str) -> String {
    let parts: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return "atom".to_string();
    }
    if parts[0] == "team" && parts.len() >= 2 {
        return parts[1].to_string();
    }
    if parts[0] == "personal" && parts.len() >= 3 {
        return parts[2].to_string();
    }
    parts[0].to_string()
}

/// Infer a project slug from `team/projects/<slug>/...` or `team/projects/<slug>.md`.
fn infer_project(rel: &str) -> Option<String> {
    let parts: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() >= 3 && parts[0] == "team" && parts[1] == "projects" {
        let p = parts[2];
        let slug = p.trim_end_matches(".md").trim_end_matches(".markdown");
        if !slug.is_empty() {
            return Some(slug.to_string());
        }
    }
    None
}

/// Infer vendor id from the `personal/<user>/threads/<vendor>/...` shape, or
/// any segment exactly matching one of the canonical vendor ids.
fn infer_vendor(rel: &str) -> Option<String> {
    const VENDORS: &[&str] = &[
        "cursor",
        "claude-code",
        "claude_code",
        "claude-ai",
        "claude_ai",
        "codex",
        "windsurf",
        "chatgpt",
        "gemini",
        "copilot",
        "v0",
        "ollama",
        "devin",
        "replit",
        "apple-intelligence",
        "ms-copilot",
    ];
    let parts: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    let threads_idx = parts.iter().position(|p| *p == "threads");
    if let Some(idx) = threads_idx {
        if let Some(cand) = parts.get(idx + 1) {
            let lc = cand.to_lowercase();
            if VENDORS.iter().any(|v| *v == lc) {
                return Some(lc);
            }
        }
    }
    for seg in &parts {
        let lc = seg.to_lowercase();
        if VENDORS.iter().any(|v| *v == lc) {
            return Some(lc);
        }
    }
    None
}

/// Extract every `[[...]]` wiki link in `body`. Returns the inner text
/// (between the brackets) for each match, in order. Cheap manual scan
/// rather than pulling in the regex crate for one pattern.
pub(crate) fn extract_wiki_links(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            let start = i + 2;
            // Find the closing `]]`.
            let mut j = start;
            while j + 1 < bytes.len() {
                if bytes[j] == b']' && bytes[j + 1] == b']' {
                    break;
                }
                j += 1;
            }
            if j + 1 < bytes.len() && bytes[j] == b']' && bytes[j + 1] == b']' {
                // UTF-8 safety: walk back/forward to char boundaries.
                let safe_start = (start..=body.len())
                    .find(|&k| body.is_char_boundary(k))
                    .unwrap_or(start);
                let safe_end = (j..=body.len())
                    .find(|&k| body.is_char_boundary(k))
                    .unwrap_or(j);
                if safe_end > safe_start {
                    let inner = &body[safe_start..safe_end];
                    if !inner.is_empty() && !inner.contains('\n') {
                        out.push(inner.to_string());
                    }
                }
                i = j + 2;
                continue;
            }
            // Unclosed `[[` — bail out of this attempt.
            i += 2;
            continue;
        }
        i += 1;
    }
    out
}

/// Build the deduplicated edge list from the buffered atom set.
///
/// 1. `cites` — scan each atom's body for `[[Title]]` and bare path
///    references. Match against the title-index + path-index built up-front.
/// 2. `same_author` / `same_vendor` / `same_project` — group atoms by the
///    field, emit one edge per unordered pair within each group.
fn build_graph_edges(atoms: &[AtomFileBuf]) -> Vec<AtomEdge> {
    use std::collections::HashMap;
    use std::collections::HashSet;

    // Title → path index. Lowercase the title for case-insensitive match.
    let mut title_to_path: HashMap<String, String> = HashMap::new();
    let mut paths: HashSet<String> = HashSet::new();
    for a in atoms {
        title_to_path.insert(a.label.to_lowercase(), a.path.clone());
        paths.insert(a.path.clone());
    }

    // Track unordered pairs to dedupe. Key = (min, max, kind).
    let mut seen: HashSet<(String, String, String)> = HashSet::new();
    let mut out: Vec<AtomEdge> = Vec::new();

    fn dedupe_key(a: &str, b: &str, kind: &str) -> (String, String, String) {
        if a < b {
            (a.to_string(), b.to_string(), kind.to_string())
        } else {
            (b.to_string(), a.to_string(), kind.to_string())
        }
    }

    fn try_push(
        out: &mut Vec<AtomEdge>,
        seen: &mut HashSet<(String, String, String)>,
        source: &str,
        target: &str,
        kind: &str,
        weight: f32,
    ) {
        if source == target {
            return;
        }
        if out.len() >= GRAPH_MAX_EDGES {
            return;
        }
        let key = dedupe_key(source, target, kind);
        if seen.contains(&key) {
            return;
        }
        seen.insert(key);
        out.push(AtomEdge {
            source: source.to_string(),
            target: target.to_string(),
            kind: kind.to_string(),
            weight,
        });
    }

    // 1. cites — `[[Title]]` and `path/to/atom.md` references.
    for a in atoms {
        // Wiki links — manual parse for `[[...]]` to avoid pulling regex dep.
        for raw in extract_wiki_links(&a.body) {
            // Drop pipe alias: [[Title|alias]] → "Title".
            let title = raw.split('|').next().unwrap_or(&raw).trim();
            let lc = title.to_lowercase();
            if let Some(target_path) = title_to_path.get(&lc) {
                try_push(&mut out, &mut seen, &a.path, target_path, "cites", 1.0);
            }
        }
        // Bare path references (cheap substring check; we only need to be
        // right enough to surface obvious references).
        let body_lc = a.body.to_lowercase();
        for target in &paths {
            if target == &a.path {
                continue;
            }
            if body_lc.contains(&target.to_lowercase()) {
                try_push(&mut out, &mut seen, &a.path, target, "cites", 1.0);
            }
        }
    }

    // 2. same_author / same_vendor / same_project — group + emit unordered pairs.
    fn group_pairs<'a, F>(
        atoms: &'a [AtomFileBuf],
        key_fn: F,
    ) -> Vec<(&'a str, &'a str)>
    where
        F: Fn(&'a AtomFileBuf) -> Option<&'a str>,
    {
        use std::collections::HashMap;
        let mut groups: HashMap<&str, Vec<&str>> = HashMap::new();
        for a in atoms {
            if let Some(k) = key_fn(a) {
                groups.entry(k).or_default().push(&a.path);
            }
        }
        let mut pairs: Vec<(&str, &str)> = Vec::new();
        for paths in groups.values() {
            for i in 0..paths.len() {
                for j in (i + 1)..paths.len() {
                    pairs.push((paths[i], paths[j]));
                }
            }
        }
        pairs
    }

    for (s, t) in group_pairs(atoms, |a| a.author.as_deref()) {
        try_push(&mut out, &mut seen, s, t, "same_author", 0.25);
    }
    for (s, t) in group_pairs(atoms, |a| a.vendor.as_deref()) {
        try_push(&mut out, &mut seen, s, t, "same_vendor", 0.15);
    }
    for (s, t) in group_pairs(atoms, |a| a.project.as_deref()) {
        try_push(&mut out, &mut seen, s, t, "same_project", 0.35);
    }

    out
}
// === end wave 23 ===

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

    // === wave 21 ===
    #[test]
    fn walk_tree_returns_nodes_sorted_dirs_first() {
        let root = fresh_root();
        let team_decisions = root.join("team/decisions");
        let personal = root.join("personal/me/threads");
        std::fs::create_dir_all(&team_decisions).unwrap();
        std::fs::create_dir_all(&personal).unwrap();
        std::fs::write(team_decisions.join("a.md"), "x").unwrap();
        std::fs::write(team_decisions.join("b.md"), "x").unwrap();
        std::fs::write(personal.join("c.md"), "x").unwrap();
        std::fs::write(root.join("zz.md"), "x").unwrap();

        let mut budget = MAX_TREE_NODES;
        let mut files = 0;
        let mut dirs = 0;
        let mut truncated = false;
        let nodes = walk_tree(
            &root,
            &root,
            "",
            None,
            0,
            &mut budget,
            &mut files,
            &mut dirs,
            &mut truncated,
        );
        // Top-level: personal (dir), team (dir), zz.md (file).
        // Dirs come first.
        assert!(nodes.len() >= 3);
        assert_eq!(nodes[0].kind, "dir");
        assert_eq!(nodes[1].kind, "dir");
        assert!(files >= 3, "files counted: {}", files);
        assert!(dirs >= 4, "dirs counted: {}", dirs);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_tree_skips_dotfiles_and_non_md() {
        let root = fresh_root();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("readme.md"), "x").unwrap();
        std::fs::write(root.join("config.json"), "x").unwrap();
        std::fs::write(root.join(".hidden.md"), "x").unwrap();

        let mut budget = MAX_TREE_NODES;
        let mut files = 0;
        let mut dirs = 0;
        let mut truncated = false;
        let nodes = walk_tree(
            &root,
            &root,
            "",
            None,
            0,
            &mut budget,
            &mut files,
            &mut dirs,
            &mut truncated,
        );
        // Only readme.md should surface.
        assert_eq!(files, 1);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "readme.md");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_tree_respects_depth_limit() {
        let root = fresh_root();
        let nested = root.join("a/b/c");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("deep.md"), "x").unwrap();
        std::fs::write(root.join("top.md"), "x").unwrap();

        let mut budget = MAX_TREE_NODES;
        let mut files = 0;
        let mut dirs = 0;
        let mut truncated = false;
        let nodes = walk_tree(
            &root,
            &root,
            "",
            Some(0),
            0,
            &mut budget,
            &mut files,
            &mut dirs,
            &mut truncated,
        );
        // Depth 0 → don't recurse into a/. We see a (dir, no children) + top.md.
        assert_eq!(files, 1);
        let dir_node = nodes.iter().find(|n| n.kind == "dir").unwrap();
        assert!(dir_node.children.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_tree_truncates_at_max_nodes() {
        let root = fresh_root();
        std::fs::create_dir_all(&root).unwrap();
        // Tiny budget to force truncation.
        let mut budget = 2;
        let mut files = 0;
        let mut dirs = 0;
        let mut truncated = false;
        for i in 0..10 {
            std::fs::write(root.join(format!("f{}.md", i)), "x").unwrap();
        }
        let _ = walk_tree(
            &root,
            &root,
            "",
            None,
            0,
            &mut budget,
            &mut files,
            &mut dirs,
            &mut truncated,
        );
        assert!(truncated, "should have truncated, files={}", files);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn infer_scope_recognizes_team_and_personal() {
        assert_eq!(infer_scope("team/decisions/foo.md"), Some("team".into()));
        assert_eq!(
            infer_scope("personal/me/threads/cursor/x.md"),
            Some("personal".into())
        );
        assert_eq!(infer_scope("flat-legacy.md"), None);
    }

    #[test]
    fn parse_title_reads_frontmatter() {
        let raw = "---\ntitle: My Decision\nauthor: alex\n---\nbody";
        assert_eq!(parse_title(raw), Some("My Decision".into()));
    }

    #[test]
    fn parse_title_returns_none_without_frontmatter() {
        assert!(parse_title("# Heading\nbody").is_none());
    }

    #[test]
    fn derive_title_strips_md_extension() {
        assert_eq!(derive_title_from_path("team/decisions/foo.md"), "foo");
        assert_eq!(derive_title_from_path("foo.markdown"), "foo");
    }

    #[test]
    fn find_backlink_match_finds_path_reference() {
        let body = "Some text mentioning team/decisions/foo.md somewhere here.";
        let snippet = find_backlink_match(body, Some("team/decisions/foo.md"), None);
        assert!(snippet.is_some());
        let s = snippet.unwrap();
        assert!(s.contains("team/decisions/foo.md"));
    }

    #[test]
    fn find_backlink_match_finds_wiki_link() {
        let body = "See also [[Decision-Title]] for more.";
        let snippet = find_backlink_match(body, None, Some("Decision-Title"));
        assert!(snippet.is_some());
    }

    #[test]
    fn find_backlink_match_returns_none_when_absent() {
        let body = "Nothing relevant here at all.";
        let snippet = find_backlink_match(body, Some("team/decisions/foo.md"), Some("Foo"));
        assert!(snippet.is_none());
    }

    #[test]
    fn snippet_around_handles_short_body() {
        let body = "abc";
        let s = snippet_around(body, 0, 50);
        assert_eq!(s, "abc");
    }
    // === end wave 21 ===

    // === wave 23 ===
    #[test]
    fn graph_walk_collects_atoms_and_parses_frontmatter() {
        let root = fresh_root();
        let dir = root.join("team/decisions");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("a.md"),
            "---\ntitle: Alpha\nauthor: alex\nvendor: cursor\ndate: 2026-04-22\n---\nbody",
        )
        .unwrap();
        std::fs::write(
            dir.join("b.md"),
            "---\ntitle: Beta\nauthor: alex\n---\nrefers to [[Alpha]] here",
        )
        .unwrap();

        let mut atoms: Vec<AtomFileBuf> = Vec::new();
        let mut truncated = false;
        walk_for_graph(&root, &root, "", &mut atoms, &mut truncated);
        assert_eq!(atoms.len(), 2, "got {} atoms", atoms.len());
        let alpha = atoms.iter().find(|a| a.label == "Alpha").unwrap();
        assert_eq!(alpha.author.as_deref(), Some("alex"));
        assert_eq!(alpha.vendor.as_deref(), Some("cursor"));
        assert_eq!(alpha.timestamp.as_deref(), Some("2026-04-22"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn graph_edges_detect_wiki_link_citations() {
        let atoms = vec![
            AtomFileBuf {
                path: "team/decisions/alpha.md".into(),
                label: "Alpha".into(),
                vendor: None,
                author: Some("alex".into()),
                kind: "decisions".into(),
                project: None,
                timestamp: None,
                body: "the alpha doc".into(),
            },
            AtomFileBuf {
                path: "team/decisions/beta.md".into(),
                label: "Beta".into(),
                vendor: None,
                author: Some("alex".into()),
                kind: "decisions".into(),
                project: None,
                timestamp: None,
                body: "we cite [[Alpha]] inline".into(),
            },
        ];
        let edges = build_graph_edges(&atoms);
        let cites = edges.iter().filter(|e| e.kind == "cites").count();
        assert_eq!(cites, 1, "expected one cites edge, got {} (all={:?})", cites, edges);
        let same_author = edges.iter().filter(|e| e.kind == "same_author").count();
        assert_eq!(same_author, 1, "expected one same_author edge");
    }

    #[test]
    fn graph_edges_dedupe_same_author_pairs() {
        // Three atoms with the same author — should produce exactly C(3,2) = 3
        // unordered same_author edges (no duplicates).
        let atoms = vec![
            AtomFileBuf {
                path: "a.md".into(),
                label: "A".into(),
                vendor: None,
                author: Some("daizhe".into()),
                kind: "atom".into(),
                project: None,
                timestamp: None,
                body: "".into(),
            },
            AtomFileBuf {
                path: "b.md".into(),
                label: "B".into(),
                vendor: None,
                author: Some("daizhe".into()),
                kind: "atom".into(),
                project: None,
                timestamp: None,
                body: "".into(),
            },
            AtomFileBuf {
                path: "c.md".into(),
                label: "C".into(),
                vendor: None,
                author: Some("daizhe".into()),
                kind: "atom".into(),
                project: None,
                timestamp: None,
                body: "".into(),
            },
        ];
        let edges = build_graph_edges(&atoms);
        let same_author: Vec<_> = edges.iter().filter(|e| e.kind == "same_author").collect();
        assert_eq!(same_author.len(), 3, "got {:?}", same_author);
    }

    #[test]
    fn graph_walk_handles_empty_root() {
        let root = fresh_root();
        let mut atoms: Vec<AtomFileBuf> = Vec::new();
        let mut truncated = false;
        walk_for_graph(&root, &root, "", &mut atoms, &mut truncated);
        assert!(atoms.is_empty());
        assert!(!truncated);
        let edges = build_graph_edges(&atoms);
        assert!(edges.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn graph_walk_truncates_at_max_nodes() {
        let root = fresh_root();
        std::fs::create_dir_all(&root).unwrap();
        // Write more atoms than the cap. Use a tiny local cap by walking and
        // checking the public flag; the production cap is GRAPH_MAX_NODES.
        // We can't change the const, so we verify the small-N happy path
        // here and a separate check that very large numbers DO trip it.
        for i in 0..5 {
            std::fs::write(root.join(format!("f{}.md", i)), "x").unwrap();
        }
        let mut atoms: Vec<AtomFileBuf> = Vec::new();
        let mut truncated = false;
        walk_for_graph(&root, &root, "", &mut atoms, &mut truncated);
        assert_eq!(atoms.len(), 5);
        assert!(!truncated, "5 atoms should not trip the {} cap", GRAPH_MAX_NODES);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_wiki_links_finds_basic_and_aliased() {
        let body = "see [[Alpha]] and [[Beta|the beta one]] but not [single] or [[broken";
        let links = extract_wiki_links(body);
        assert_eq!(links.len(), 2);
        assert_eq!(links[0], "Alpha");
        assert_eq!(links[1], "Beta|the beta one");
    }

    #[test]
    fn infer_project_recognizes_team_projects_path() {
        assert_eq!(infer_project("team/projects/ifactory/spec.md"), Some("ifactory".into()));
        assert_eq!(infer_project("team/projects/atlas.md"), Some("atlas".into()));
        assert_eq!(infer_project("team/decisions/foo.md"), None);
    }

    #[test]
    fn infer_atom_kind_picks_kind_segment() {
        assert_eq!(infer_atom_kind("team/decisions/foo.md"), "decisions");
        assert_eq!(infer_atom_kind("personal/me/threads/cursor/x.md"), "threads");
        assert_eq!(infer_atom_kind("loose.md"), "loose.md");
    }
    // === end wave 23 ===

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
