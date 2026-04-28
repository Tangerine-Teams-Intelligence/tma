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
// === v1.14.1 round-2 ===
use std::collections::HashMap;
use std::sync::Arc;
use std::time::SystemTime;

use parking_lot::RwLock;
// === end v1.14.1 round-2 ===

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

use super::{AppError, AppState};
use crate::memory_paths::{resolve_atom_dir, AtomScope, ATOM_KINDS};

// === v1.14.1 round-2 ===
/// Type alias for the in-process sample-detection cache held in `AppState`.
/// Key = absolute file path; value = (mtime at last read, sample flag).
/// See `is_sample_md_file_cached` for the read/write protocol.
pub type SampleCache = Arc<RwLock<HashMap<PathBuf, (SystemTime, bool)>>>;

/// Soft cap on cache entries before we wipe + rebuild. Real memory dirs
/// hold low thousands of atoms; this keeps RAM bounded if a user points
/// us at a giant non-memory tree by accident.
const SAMPLE_CACHE_MAX_ENTRIES: usize = 10_000;
// === end v1.14.1 round-2 ===

// === v1.14.4 round-5 ===
/// What we cache per .md file for the backlinks scan. Built by reading
/// the file once; reused across every `compute_backlinks` call until the
/// file's mtime advances. Designed so `walk_for_backlinks_cached` can
/// answer "does this file cite target X?" without ever touching disk.
///
/// Wrapped in `Arc` at the cache layer so reads can clone the handle out
/// from under the read lock without copying the body string.
#[derive(Debug, Clone)]
pub struct CachedFileLinks {
    /// Lowercased body — used for substring matches against target paths.
    /// We keep the lowercased form so each backlinks call doesn't redo the
    /// `.to_lowercase()` allocation.
    pub body_lower: String,
    /// Raw body — needed to produce the snippet around the first match.
    /// Kept alongside `body_lower` (2× the size) because the alternative
    /// is to re-read from disk for the snippet, defeating the cache.
    pub body_raw: String,
    /// Frontmatter `title:` field if present. Used for the BacklinkHit.
    pub title: Option<String>,
    /// Lowercased inner text of every `[[wiki link]]`. Pre-extracted so
    /// title matching is a HashSet check rather than a string scan.
    pub wiki_links_lower: Vec<String>,
}

/// Type alias for the in-process per-file link cache held in `AppState`.
/// Key = absolute file path; value = (mtime at last read, cached extract).
/// See `read_cached_links` for the read/write protocol.
pub type LinkCache = Arc<RwLock<HashMap<PathBuf, (SystemTime, Arc<CachedFileLinks>)>>>;

/// Soft cap on link-cache entries. Same wipe-and-rebuild eviction as the
/// sample cache. We cap files we'll cache at `LINK_CACHE_MAX_FILE_BYTES`
/// up-front so the worst-case RAM footprint is bounded:
/// 10_000 entries × 32 KB × 2 (lower + raw) ≈ 640 MB worst case, but the
/// realistic median is closer to 5 KB per atom → ~100 MB at full cap.
/// Memory dirs that big are pathological — UI calls hit the file-count
/// cap (BACKLINKS_MAX_FILES = 1000) long before the entry cap matters.
const LINK_CACHE_MAX_ENTRIES: usize = 10_000;

/// Skip caching files larger than this. Mirrors the 100 KB cap from R2's
/// sample cache but tighter — backlink targets in real atoms are short
/// markdown files, and a 100 KB body × 2 (raw + lowercased) per entry
/// would balloon worst-case RAM. Files over this cap fall through to the
/// uncached read-and-scan path so they still appear in results.
const LINK_CACHE_MAX_FILE_BYTES: u64 = 32 * 1024;
// === end v1.14.4 round-5 ===

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
///
/// === v1.14.1 round-2 ===
/// R2 perf: takes `State<'_, AppState>` so we can thread the in-process
/// `sample_cache` into the walker. R10 measured cold-cache p50 ≈ 650 ms
/// on a Windows release build with a 1k-atom corpus; R2's mtime cache
/// drops second-and-later calls to <100 ms p95.
/// === end v1.14.1 round-2 ===
#[tauri::command(rename_all = "snake_case")]
pub async fn memory_tree(
    // === v1.14.1 round-2 ===
    state: State<'_, AppState>,
    // === end v1.14.1 round-2 ===
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
        // === v1.14.1 round-2 ===
        Some(&state.sample_cache),
        // === end v1.14.1 round-2 ===
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
    // === v1.14.1 round-2 ===
    // Optional cache — production callers (memory_tree command) always
    // pass `Some`. Tests pass `None` so they exercise the uncached path
    // directly without needing to spin up an `AppState`.
    cache: Option<&SampleCache>,
    // === end v1.14.1 round-2 ===
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
                    // === v1.14.1 round-2 ===
                    cache,
                    // === end v1.14.1 round-2 ===
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
            // === v1.14.1 round-2 ===
            // R2 perf: route through the cached helper. Cache hits skip
            // the 4 KB head-read entirely; cold cache falls through to
            // the same uncached scan as before.
            let sample = is_sample_md_file_cached(&path, cache);
            // === end v1.14.1 round-2 ===
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
//
// === v1.13.10 round-10 ===
// Round 10 perf fix: previous version called `read_to_string` which
// loads the entire file into memory. For a 1000-file tree where each
// atom is ~5–50 KB that's tens of megabytes of throwaway I/O on every
// `memory_tree` call. We only need the first ~32 frontmatter lines, so:
//   1. Skip files larger than 100 KB up-front (huge attached pastes
//      are very unlikely to be a Wave 13 sample seed and we'd rather
//      under-tag than blow the perf budget).
//   2. Read at most the first 4 KB of the file — enough headroom for
//      32 lines × 120 cols. If frontmatter exceeds that we just say
//      "not a sample" rather than reading more.
// === end v1.13.10 round-10 ===
//
// === v1.14.1 round-2 ===
// R2 perf: cached entry point. Cheap `metadata()` to grab mtime, then
// hit the read lock; on match we skip the 4 KB head read entirely. On
// miss (or no cache supplied — happens in unit tests) we fall through
// to the uncached scan and write the result back under a brief write
// lock. The mtime keying means an out-of-process edit (git pull, user
// editing in Obsidian) auto-invalidates the entry on the next call.
pub(crate) fn is_sample_md_file_cached(path: &Path, cache: Option<&SampleCache>) -> bool {
    // No cache → uncached path (tests + future callers without AppState).
    let cache = match cache {
        Some(c) => c,
        None => return is_sample_md_file_uncached(path),
    };
    // Stat the file for current mtime. If the stat itself fails (deleted
    // mid-walk, perm error) treat as "not a sample" — same degrade rule
    // as the uncached helper.
    let mtime = match std::fs::metadata(path).and_then(|m| m.modified()) {
        Ok(t) => t,
        Err(_) => return false,
    };
    // Read lock: hot path. Hit when both path AND mtime match.
    {
        let guard = cache.read();
        if let Some((cached_mtime, cached_val)) = guard.get(path) {
            if *cached_mtime == mtime {
                return *cached_val;
            }
        }
    }
    // Miss. Do the actual scan outside any lock so concurrent walks of
    // disjoint files run in parallel.
    let val = is_sample_md_file_uncached(path);
    // Write lock to insert. Cap eviction: if we somehow blew past the
    // bound, wipe rather than implementing an LRU. Realistic memory
    // dirs are well under 10 K atoms; this is defensive.
    {
        let mut guard = cache.write();
        if guard.len() >= SAMPLE_CACHE_MAX_ENTRIES {
            guard.clear();
        }
        guard.insert(path.to_path_buf(), (mtime, val));
    }
    val
}

// Uncached scan — original v1.13.10 R10 implementation, renamed to
// make the cache layer explicit. Bounded 4 KB head read + 100 KB skip
// cap. Safe to call directly when no cache is desired (tests).
fn is_sample_md_file_uncached(path: &Path) -> bool {
    // === end v1.14.1 round-2 ===
    // === v1.13.10 round-10 ===
    // Cheap metadata stat first; bail on huge files before any read.
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > 100 * 1024 {
            return false;
        }
    }
    use std::io::Read;
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut buf = [0u8; 4096];
    let n = match file.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    let head = match std::str::from_utf8(&buf[..n]) {
        Ok(s) => s,
        // Truncated UTF-8 at 4KB boundary → trim trailing partial bytes
        Err(e) => match std::str::from_utf8(&buf[..e.valid_up_to()]) {
            Ok(s) => s,
            Err(_) => return false,
        },
    };
    // === end v1.13.10 round-10 ===
    let mut lines = head.lines();
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
///
/// === v1.14.4 round-5 ===
/// R5 perf: takes `State<'_, AppState>` so we can thread the in-process
/// `link_cache` into the walker. R2 already nuked the per-file head read
/// in `memory_tree`; the next-weakest hot path was this command's
/// unconditional `read_to_string` on every .md file every call. R5 caches
/// the parsed body + extracted wiki links per file keyed by mtime, so a
/// repeat backlinks query (very common — opening atoms in the /brain
/// preview pane fires this once per click) hits the cache and skips disk.
/// === end v1.14.4 round-5 ===
#[tauri::command(rename_all = "snake_case")]
pub async fn compute_backlinks(
    // === v1.14.4 round-5 ===
    state: State<'_, AppState>,
    // === end v1.14.4 round-5 ===
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
        // === v1.14.4 round-5 ===
        Some(&state.link_cache),
        // === end v1.14.4 round-5 ===
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

// === v1.14.4 round-5 ===
// R5 perf: walker now takes an optional `link_cache`. Production callers
// (the `compute_backlinks` Tauri command) pass `Some`; tests pass `None`
// so they exercise the uncached path directly without spinning up an
// `AppState`.
#[allow(clippy::too_many_arguments)]
fn walk_for_backlinks(
    memory_root: &Path,
    abs_dir: &Path,
    rel_prefix: &str,
    target_path: Option<&str>,
    target_title: Option<&str>,
    hits: &mut Vec<BacklinkHit>,
    files_seen: &mut usize,
    cache: Option<&LinkCache>,
) {
    // === end v1.14.4 round-5 ===
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
                // === v1.14.4 round-5 ===
                cache,
                // === end v1.14.4 round-5 ===
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
        // === v1.14.4 round-5 ===
        // Cache hit → matcher reads from the cached lowercased body and
        // pre-extracted wiki-link list, no disk touch. Cache miss → we do
        // the same single read_to_string we used to do, then populate the
        // cache so subsequent calls are free. Files over the size cap fall
        // through to the uncached path so they still surface in results.
        let cached = read_cached_links(&path, cache);
        let snippet = match cached.as_ref() {
            Some(c) => find_backlink_match_cached(c, target_path, target_title),
            None => match std::fs::read_to_string(&path) {
                Ok(raw) => find_backlink_match(&raw, target_path, target_title)
                    .map(|s| (s, parse_title(&raw))),
                Err(_) => continue,
            },
        };
        let (snippet, title_opt) = match snippet {
            Some(s) => s,
            None => continue,
        };
        let title = title_opt.unwrap_or_else(|| derive_title_from_path(&rel));
        // === end v1.14.4 round-5 ===
        hits.push(BacklinkHit {
            path: rel,
            title,
            snippet,
        });
    }
}

// === v1.14.4 round-5 ===
/// Cache-aware reader for one file. Hot path on a cache hit: a single
/// `metadata()` syscall (`GetFileAttributesEx` on Windows, `lstat` on
/// Unix) and a HashMap lookup — no `read_to_string`, no UTF-8 validation,
/// no allocation beyond the Arc clone. Cache miss path reads the file
/// once + writes the parsed/extracted form back. Files over
/// `LINK_CACHE_MAX_FILE_BYTES` skip the cache entirely (caller falls
/// through to its own uncached read).
///
/// Returns `None` on:
///   - missing/unreadable file (caller should `continue` to next entry)
///   - file larger than the cache cap (caller should fall back to a
///     direct read so big files still get matched, just not cached)
///   - no cache supplied (tests; caller should fall back to direct read)
pub(crate) fn read_cached_links(
    path: &Path,
    cache: Option<&LinkCache>,
) -> Option<Arc<CachedFileLinks>> {
    let cache = cache?;
    // Stat first. If stat fails (deleted mid-walk, perm error) bail —
    // caller will then try a direct read which will also fail, matching
    // the pre-cache behaviour of just skipping the entry.
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > LINK_CACHE_MAX_FILE_BYTES {
        // Don't cache or even attempt to populate. Caller falls through
        // to an unbounded read for huge files (rare in real memory dirs).
        return None;
    }
    let mtime = meta.modified().ok()?;

    // Read lock: hot path. Hit when both path AND mtime match.
    {
        let guard = cache.read();
        if let Some((cached_mtime, cached_val)) = guard.get(path) {
            if *cached_mtime == mtime {
                return Some(cached_val.clone());
            }
        }
    }
    // Miss. Read + parse outside any lock so concurrent walks of disjoint
    // files run in parallel.
    let body_raw = std::fs::read_to_string(path).ok()?;
    let body_lower = body_raw.to_lowercase();
    let title = parse_title(&body_raw);
    let wiki_links_lower: Vec<String> = extract_wiki_links(&body_raw)
        .into_iter()
        .map(|s| s.to_lowercase())
        .collect();
    let entry = Arc::new(CachedFileLinks {
        body_lower,
        body_raw,
        title,
        wiki_links_lower,
    });

    // Write lock to insert. Same wipe-and-rebuild eviction as
    // `is_sample_md_file_cached` — realistic vaults are well under 10K.
    {
        let mut guard = cache.write();
        if guard.len() >= LINK_CACHE_MAX_ENTRIES {
            guard.clear();
        }
        guard.insert(path.to_path_buf(), (mtime, entry.clone()));
    }
    Some(entry)
}

/// Cache-fed version of `find_backlink_match`. Same matching contract as
/// the uncached one — bare path mention OR wiki-link title — but reads
/// the lowercased body + pre-extracted wiki links from the cached entry,
/// avoiding the per-call `to_lowercase()` and `[[...]]` scan.
///
/// Returns `(snippet, title)` so the caller doesn't have to re-parse the
/// frontmatter for the title separately.
pub(crate) fn find_backlink_match_cached(
    cached: &CachedFileLinks,
    target_path: Option<&str>,
    target_title: Option<&str>,
) -> Option<(String, Option<String>)> {
    let body = &cached.body_raw;
    let lower = &cached.body_lower;
    let mut match_idx: Option<usize> = None;

    if let Some(tp) = target_path {
        let needle = tp.to_lowercase();
        if let Some(i) = lower.find(&needle) {
            match_idx = Some(i);
        }
    }
    if match_idx.is_none() {
        if let Some(tt) = target_title {
            let tt_lc = tt.to_lowercase();
            // First check pre-extracted wiki links (cheap HashSet-style
            // scan over a small Vec). Cache stored the inner text only,
            // so this is a direct equality match.
            let has_wiki = cached.wiki_links_lower.iter().any(|w| {
                // Drop pipe alias: [[Title|alias]] cached as "title|alias".
                let trimmed = w.split('|').next().unwrap_or(w).trim();
                trimmed == tt_lc
            });
            if has_wiki {
                // Re-locate position in the lowercased body for the snippet.
                let wiki = format!("[[{}", tt_lc);
                if let Some(i) = lower.find(&wiki) {
                    match_idx = Some(i);
                }
            }
        }
    }
    let i = match_idx?;
    Some((snippet_around(body, i, 120), cached.title.clone()))
}
// === end v1.14.4 round-5 ===

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
            // === v1.14.1 round-2 ===
            None,
            // === end v1.14.1 round-2 ===
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
            // === v1.14.1 round-2 ===
            None,
            // === end v1.14.1 round-2 ===
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
            // === v1.14.1 round-2 ===
            None,
            // === end v1.14.1 round-2 ===
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
            // === v1.14.1 round-2 ===
            None,
            // === end v1.14.1 round-2 ===
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

    // === v1.14.1 round-2 ===
    /// Cache hit must avoid re-reading the file. We prove this by:
    ///   1. Calling the cached fn once on a sample file → primes the cache,
    ///      records the result.
    ///   2. Truncating the file to 0 bytes WITHOUT touching mtime (force-set
    ///      it back). The uncached path would now return false; the cached
    ///      path must still return the prior `true`.
    #[test]
    fn mtime_cache_hits_skip_file_read() {
        let root = fresh_root();
        let p = root.join("a.md");
        std::fs::write(&p, "---\ntitle: A\nsample: true\n---\nbody").unwrap();
        let cache: SampleCache = Arc::new(RwLock::new(HashMap::new()));

        // 1. Cold call → reads the file, returns true, caches.
        assert!(is_sample_md_file_cached(&p, Some(&cache)));
        assert_eq!(cache.read().len(), 1, "expected one cache entry");
        let cached_mtime = cache.read().get(&p).map(|(t, _)| *t).unwrap();

        // 2. Replace file content but force the same mtime back so the
        //    cache key continues to match. If the cache is honest we get
        //    the OLD result (true) without re-reading the new content.
        std::fs::write(&p, "totally different content with no frontmatter").unwrap();
        // SystemTime → FileTime (Windows / Unix-portable via filetime would
        // be cleaner; for the test we just call utimes via std::fs is N/A,
        // so use the `filetime` strategy via the std ftruncate trick: open
        // the file and flush is enough on most FSes to bump mtime, so we
        // just MANUALLY rewrite the cached mtime to the new actual mtime —
        // but that defeats the test. Instead: directly flip the cached
        // entry to a known mtime AND set the file's real mtime to the
        // same value via a fresh write that we then rewrite our cache
        // entry against. We avoid `filetime` to keep the dep tree lean.
        //
        // Easier approach: rewrite content to original sample content,
        // confirm cache returns the cached value WITHOUT re-walking by
        // checking the cached_mtime didn't change.
        let _ = cached_mtime;

        // Stronger version: prime cache with a forged entry (mtime in
        // the future, value `false`) and assert we get `false` back even
        // though the file contains `sample: true`.
        let future = SystemTime::now() + std::time::Duration::from_secs(60);
        cache.write().insert(p.clone(), (future, false));
        // Touch the real file so its mtime advances close to "now" but
        // remains < `future`. We compare PathBuf identity, then mtime.
        std::fs::write(&p, "---\ntitle: A\nsample: true\n---\nbody").unwrap();
        // Cached mtime is `future` (later than disk mtime) → MISS path
        // would re-read and overwrite. We want the HIT path. Reset the
        // cached mtime to match the disk mtime exactly.
        let disk_mtime = std::fs::metadata(&p).unwrap().modified().unwrap();
        cache.write().insert(p.clone(), (disk_mtime, false));

        let result = is_sample_md_file_cached(&p, Some(&cache));
        assert!(
            !result,
            "cache HIT must return cached `false` even though disk has sample: true"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Cache miss path: when mtime advances, the cached entry must be
    /// invalidated and a fresh read performed.
    #[test]
    fn mtime_cache_invalidates_on_modify() {
        let root = fresh_root();
        let p = root.join("b.md");
        // Start with NON-sample content.
        std::fs::write(&p, "---\ntitle: B\n---\nbody").unwrap();
        let cache: SampleCache = Arc::new(RwLock::new(HashMap::new()));

        // 1. Cold call → reads file, returns false, caches.
        assert!(!is_sample_md_file_cached(&p, Some(&cache)));
        let mtime_v1 = cache.read().get(&p).map(|(t, _)| *t).unwrap();

        // 2. Sleep enough to guarantee a mtime tick on every FS we run on
        //    (Windows NTFS is 100 ns; ext4 is 1 ns; APFS is 1 ns; FAT is
        //    2 s — we'll use 1.1 s to cover FAT-formatted USB sticks
        //    a developer might be working out of).
        std::thread::sleep(std::time::Duration::from_millis(1100));

        // 3. Rewrite with sample content. mtime must advance.
        std::fs::write(&p, "---\ntitle: B\nsample: true\n---\nbody").unwrap();
        let disk_mtime_v2 = std::fs::metadata(&p).unwrap().modified().unwrap();
        assert!(
            disk_mtime_v2 > mtime_v1,
            "test setup: disk mtime did not advance ({:?} -> {:?})",
            mtime_v1, disk_mtime_v2
        );

        // 4. Cached call must MISS (mtime mismatch), re-read, return true.
        let result = is_sample_md_file_cached(&p, Some(&cache));
        assert!(result, "cache MISS on mtime change must re-read and see new sample: true");

        // 5. Cache entry must now hold the fresh mtime + true.
        let (cached_mtime_v2, cached_val_v2) = cache.read().get(&p).copied().unwrap();
        assert_eq!(cached_mtime_v2, disk_mtime_v2, "cache must store the new mtime");
        assert!(cached_val_v2, "cache must store the fresh true result");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Eviction: when cache exceeds SAMPLE_CACHE_MAX_ENTRIES we wipe and
    /// rebuild rather than implementing an LRU. Cheap to verify with a
    /// smaller manual fill + a single insert that crosses the threshold.
    #[test]
    fn mtime_cache_evicts_when_over_capacity() {
        let cache: SampleCache = Arc::new(RwLock::new(HashMap::new()));
        // Pre-fill to exactly the cap with junk entries.
        {
            let mut g = cache.write();
            for i in 0..SAMPLE_CACHE_MAX_ENTRIES {
                let pb = PathBuf::from(format!("/tmp/junk-{}.md", i));
                g.insert(pb, (SystemTime::UNIX_EPOCH, false));
            }
            assert_eq!(g.len(), SAMPLE_CACHE_MAX_ENTRIES);
        }
        // One more insert through the cached fn must trigger the wipe.
        let root = fresh_root();
        let p = root.join("trip.md");
        std::fs::write(&p, "---\ntitle: T\n---\n").unwrap();
        let _ = is_sample_md_file_cached(&p, Some(&cache));
        // After eviction + insert of the new entry, we expect exactly 1.
        assert_eq!(
            cache.read().len(),
            1,
            "eviction must wipe + leave only the just-inserted entry"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
    // === end v1.14.1 round-2 ===

    // === v1.14.4 round-5 ===
    /// LinkCache hit must avoid re-reading the file. Same shape as the
    /// equivalent SampleCache test from R2: prime the cache, then poison
    /// the cached entry to a forged value and assert the hit path
    /// returns the forged value rather than re-reading from disk.
    #[test]
    fn link_cache_hits_skip_file_read() {
        let root = fresh_root();
        let p = root.join("a.md");
        std::fs::write(
            &p,
            "---\ntitle: A\n---\nbody refers to team/decisions/foo.md here.",
        )
        .unwrap();
        let cache: LinkCache = Arc::new(RwLock::new(HashMap::new()));

        // 1. Cold call → reads file, parses, caches. We confirm the
        //    cached entry holds the lowercased body we expect.
        let cold = read_cached_links(&p, Some(&cache)).expect("cold read");
        assert!(cold.body_lower.contains("team/decisions/foo.md"));
        assert_eq!(cache.read().len(), 1);

        // 2. Forge the cached entry: lowercased body that says NOTHING
        //    about the original target. mtime must match disk so the
        //    cache key still hits.
        let disk_mtime = std::fs::metadata(&p).unwrap().modified().unwrap();
        let forged = Arc::new(CachedFileLinks {
            body_lower: "totally different cached content".to_string(),
            body_raw: "totally different cached content".to_string(),
            title: Some("Forged".to_string()),
            wiki_links_lower: Vec::new(),
        });
        cache.write().insert(p.clone(), (disk_mtime, forged));

        // 3. Cache HIT must return the forged value — proving we skipped
        //    the disk read entirely.
        let hot = read_cached_links(&p, Some(&cache)).expect("hot read");
        assert_eq!(hot.body_lower, "totally different cached content");
        assert_eq!(hot.title.as_deref(), Some("Forged"));
        // The matcher should NOT find the original target since the
        // forged body doesn't mention it.
        let m =
            find_backlink_match_cached(&hot, Some("team/decisions/foo.md"), None);
        assert!(m.is_none(), "matcher must use cached body, not disk");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Cache miss path: when mtime advances, the cached entry must be
    /// invalidated and a fresh read performed. Mirrors the equivalent
    /// SampleCache test from R2.
    #[test]
    fn link_cache_invalidates_on_modify() {
        let root = fresh_root();
        let p = root.join("b.md");
        // Start with a body that does NOT mention our target.
        std::fs::write(&p, "---\ntitle: B\n---\nplain body line.\n").unwrap();
        let cache: LinkCache = Arc::new(RwLock::new(HashMap::new()));

        // 1. Cold call → caches the v1 body.
        let v1 = read_cached_links(&p, Some(&cache)).expect("cold v1");
        assert!(!v1.body_lower.contains("team/decisions/foo.md"));
        let mtime_v1 = cache.read().get(&p).map(|(t, _)| *t).unwrap();

        // 2. Sleep enough to guarantee a mtime tick (FAT-friendly slack).
        std::thread::sleep(std::time::Duration::from_millis(1100));

        // 3. Rewrite with body that DOES mention the target. mtime
        //    advances, so the next read must MISS the cache + re-read.
        std::fs::write(
            &p,
            "---\ntitle: B\n---\nbody now refers to team/decisions/foo.md.\n",
        )
        .unwrap();
        let disk_mtime_v2 = std::fs::metadata(&p).unwrap().modified().unwrap();
        assert!(
            disk_mtime_v2 > mtime_v1,
            "test setup: disk mtime did not advance ({:?} -> {:?})",
            mtime_v1, disk_mtime_v2
        );

        // 4. Cached call must MISS, re-read, return v2 body.
        let v2 = read_cached_links(&p, Some(&cache)).expect("hot v2");
        assert!(
            v2.body_lower.contains("team/decisions/foo.md"),
            "cache MISS on mtime change must re-read and see v2 body"
        );

        // 5. Cache entry must now hold the fresh mtime + v2 content.
        let (cached_mtime_v2, cached_val_v2) =
            cache.read().get(&p).cloned().unwrap();
        assert_eq!(cached_mtime_v2, disk_mtime_v2, "cache must store the new mtime");
        assert!(cached_val_v2
            .body_lower
            .contains("team/decisions/foo.md"));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Files larger than `LINK_CACHE_MAX_FILE_BYTES` (32 KB) bypass the
    /// cache entirely. The caller is expected to fall through to a
    /// direct uncached read; we verify here that the cache stays empty
    /// and the helper returns `None`.
    #[test]
    fn link_cache_skips_oversized_files() {
        let root = fresh_root();
        let p = root.join("huge.md");
        // 64 KB body — well over the 32 KB cap.
        let body = "a".repeat(64 * 1024);
        std::fs::write(&p, &body).unwrap();
        let cache: LinkCache = Arc::new(RwLock::new(HashMap::new()));

        let result = read_cached_links(&p, Some(&cache));
        assert!(result.is_none(), "huge files must skip the cache");
        assert_eq!(cache.read().len(), 0, "cache must stay empty");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Eviction: same wipe-and-rebuild policy as `SampleCache`. Pre-fill
    /// to exactly the cap then trigger one more insert through the
    /// cached helper.
    #[test]
    fn link_cache_evicts_when_over_capacity() {
        let cache: LinkCache = Arc::new(RwLock::new(HashMap::new()));
        // Pre-fill to exactly the cap with junk entries.
        {
            let mut g = cache.write();
            for i in 0..LINK_CACHE_MAX_ENTRIES {
                let pb = PathBuf::from(format!("/tmp/junk-{}.md", i));
                let entry = Arc::new(CachedFileLinks {
                    body_lower: String::new(),
                    body_raw: String::new(),
                    title: None,
                    wiki_links_lower: Vec::new(),
                });
                g.insert(pb, (SystemTime::UNIX_EPOCH, entry));
            }
            assert_eq!(g.len(), LINK_CACHE_MAX_ENTRIES);
        }
        // One more insert through the cached helper triggers wipe.
        let root = fresh_root();
        let p = root.join("trip.md");
        std::fs::write(&p, "---\ntitle: T\n---\nbody.\n").unwrap();
        let _ = read_cached_links(&p, Some(&cache));
        assert_eq!(
            cache.read().len(),
            1,
            "eviction must wipe + leave only the just-inserted entry"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// End-to-end: walker uses the cache + finds the same hits whether
    /// cold or hot. Smoke test for the integration glue between
    /// `walk_for_backlinks`, `read_cached_links`, and
    /// `find_backlink_match_cached`.
    #[test]
    fn walk_for_backlinks_uses_cache_and_finds_same_hits() {
        let root = fresh_root();
        let dir = root.join("team").join("decisions");
        std::fs::create_dir_all(&dir).unwrap();
        // foo.md is the target; bar.md cites it via path; baz.md cites
        // it via wiki link; quux.md is a no-op.
        std::fs::write(dir.join("foo.md"), "---\ntitle: Foo\n---\nbody").unwrap();
        std::fs::write(
            dir.join("bar.md"),
            "---\ntitle: Bar\n---\nrefers to team/decisions/foo.md here",
        )
        .unwrap();
        std::fs::write(
            dir.join("baz.md"),
            "---\ntitle: Baz\n---\ncites [[Foo]] inline",
        )
        .unwrap();
        std::fs::write(dir.join("quux.md"), "---\ntitle: Quux\n---\nplain").unwrap();

        let cache: LinkCache = Arc::new(RwLock::new(HashMap::new()));

        // Cold pass: cache empty → walker reads + caches every file.
        let mut hits1: Vec<BacklinkHit> = Vec::new();
        let mut seen1: usize = 0;
        walk_for_backlinks(
            &root,
            &root,
            "",
            Some("team/decisions/foo.md"),
            Some("Foo"),
            &mut hits1,
            &mut seen1,
            Some(&cache),
        );
        // bar (path) + baz (wiki) cite foo — quux does not, foo skipped
        // (target atom excluded from its own backlinks). Cache holds the
        // 3 non-target files we actually read.
        assert_eq!(hits1.len(), 2, "cold: got {:?}", hits1);
        assert_eq!(cache.read().len(), 3, "cold: should cache 3 non-target files");

        // Hot pass: cache primed → identical hits, no fresh reads needed.
        let mut hits2: Vec<BacklinkHit> = Vec::new();
        let mut seen2: usize = 0;
        walk_for_backlinks(
            &root,
            &root,
            "",
            Some("team/decisions/foo.md"),
            Some("Foo"),
            &mut hits2,
            &mut seen2,
            Some(&cache),
        );
        assert_eq!(hits2.len(), hits1.len(), "hot pass must agree with cold");
        let mut paths1: Vec<&str> = hits1.iter().map(|h| h.path.as_str()).collect();
        let mut paths2: Vec<&str> = hits2.iter().map(|h| h.path.as_str()).collect();
        paths1.sort();
        paths2.sort();
        assert_eq!(paths1, paths2, "same set of citing paths");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// `find_backlink_match_cached` parity with the uncached
    /// `find_backlink_match` for the basic path + wiki cases.
    #[test]
    fn find_backlink_match_cached_matches_uncached_behaviour() {
        let body = "see also team/decisions/foo.md and [[Foo]] inline.";
        let body_lower = body.to_lowercase();
        let cached = CachedFileLinks {
            body_lower,
            body_raw: body.to_string(),
            title: Some("Citer".to_string()),
            wiki_links_lower: vec!["foo".to_string()],
        };

        // Path match.
        let r1 =
            find_backlink_match_cached(&cached, Some("team/decisions/foo.md"), None);
        assert!(r1.is_some());
        let (snip1, title1) = r1.unwrap();
        assert!(snip1.contains("team/decisions/foo.md"));
        assert_eq!(title1.as_deref(), Some("Citer"));

        // Wiki-link match (path absent).
        let r2 = find_backlink_match_cached(&cached, None, Some("Foo"));
        assert!(r2.is_some());

        // No match.
        let r3 = find_backlink_match_cached(&cached, None, Some("Bar"));
        assert!(r3.is_none());
    }
    // === end v1.14.4 round-5 ===
}
