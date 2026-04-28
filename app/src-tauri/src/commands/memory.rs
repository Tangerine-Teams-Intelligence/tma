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
            });
        } else if path.is_file() {
            // Only include markdown files — match the JS reader's filter.
            let lower = name.to_lowercase();
            if !(lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdx")) {
                continue;
            }
            *budget = budget.saturating_sub(1);
            *files = files.saturating_add(1);
            nodes.push(MemoryTreeNode {
                path: rel,
                name,
                kind: "file".into(),
                scope,
                children: Vec::new(),
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
