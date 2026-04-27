//! v2.0-alpha.1 — Memory dir layered path resolution.
//!
//! v1.x stored every atom flat under `<memory_root>/{kind}/`. v2.0 introduces a
//! two-tier layout so the user can keep personal scratch separate from the
//! shared team vault:
//!
//! ```text
//! <memory_root>/
//!   team/
//!     meetings/  decisions/  people/  projects/  threads/  glossary/
//!   personal/
//!     <user>/
//!       meetings/  decisions/  people/  projects/  threads/  glossary/
//!   .tangerine/   ← daemon sidecar, untouched
//!   agi/          ← co-thinker sidecar, untouched
//!   timeline/     ← daemon-built index, untouched
//!   canvas/       ← canvas surface, untouched
//! ```
//!
//! `/team/` is what gets committed to git. `/personal/<user>/` is local-only
//! and listed in `.gitignore`. The `migration::migrate_to_layered` helper
//! moves any v1.x flat dirs into `/team/` on first launch — see that module
//! for the migration rules.
//!
//! Backward compat: writers that haven't been updated to take an `AtomScope`
//! parameter keep using `resolve_legacy_root`, which now returns the
//! `<memory_root>/team/<kind>` path. Readers (e.g. `commands::memory`) walk
//! the union of `team/` + `personal/<user>/` so atoms from both surfaces
//! show up in the tree, decorated with their scope.

use std::path::{Path, PathBuf};

/// Every kind of atom the memory layer tracks. Used by both writers (to pick
/// a target dir) and the migration shim (to know which v1.x flat dirs to
/// move into `team/`).
pub const ATOM_KINDS: &[&str] = &[
    "meetings",
    "decisions",
    "people",
    "projects",
    "threads",
    "glossary",
];

/// Sidecar dirs that stay at the memory_root and are NOT migrated into
/// `team/`. The daemon, the co-thinker engine, and the canvas surface own
/// these — they are not user atoms.
pub const SIDECAR_DIRS: &[&str] = &[
    ".tangerine",
    "agi",
    "timeline",
    "canvas",
    // Voice + email tmp dirs that may accidentally appear at root level on a
    // legacy install. Listed for completeness; migration leaves them alone
    // anyway (they only land at root when the install was misconfigured).
    "tmp",
];

/// Where an atom lives. Per spec §6 v2.0-alpha.1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtomScope {
    /// Shared team vault — committed to git, visible to everyone in the team
    /// repo. The default scope for new writes from connectors that aren't
    /// inherently personal.
    Team,
    /// Current user's private vault — never committed to git. Only visible
    /// inside this install. Phase 2 will add a "promote to team" UI.
    Personal,
}

impl AtomScope {
    /// String tag used as a frontmatter `scope:` field and in the `MemoryNode`
    /// metadata returned to the React side.
    pub fn as_str(&self) -> &'static str {
        match self {
            AtomScope::Team => "team",
            AtomScope::Personal => "personal",
        }
    }
}

/// Resolve `<memory_root>/{team|personal/<user>}/{kind}` for a given scope.
///
/// `current_user` is only used when `scope == Personal`. We slug-validate
/// here to avoid path traversal (`..`, embedded slashes) since the user
/// alias is plumbed through from the React side via the
/// `ui.currentUser` zustand slice.
pub fn resolve_atom_dir(
    memory_root: &Path,
    scope: AtomScope,
    current_user: &str,
    kind: &str,
) -> PathBuf {
    match scope {
        AtomScope::Team => memory_root.join("team").join(kind),
        AtomScope::Personal => {
            let safe_user = sanitize_user(current_user);
            memory_root.join("personal").join(safe_user).join(kind)
        }
    }
}

/// v1.x flat layout: `<memory_root>/{kind}`. After migration this path no
/// longer exists; this helper is kept for the test suite and for callers that
/// haven't taken the AtomScope-aware path yet (the migration moves the dir
/// out from under them, which intentionally surfaces a "missing dir" error
/// the next time they try to write — they should switch to
/// `resolve_atom_dir`).
pub fn resolve_legacy_root(memory_root: &Path, kind: &str) -> PathBuf {
    memory_root.join(kind)
}

/// Resolve the personal-vault root for a given user — used when we want to
/// list every kind of atom the user has stashed locally without iterating
/// `ATOM_KINDS` ourselves.
pub fn personal_user_root(memory_root: &Path, current_user: &str) -> PathBuf {
    let safe_user = sanitize_user(current_user);
    memory_root.join("personal").join(safe_user)
}

/// `<memory_root>/team/`. Created on first migration tick.
pub fn team_root(memory_root: &Path) -> PathBuf {
    memory_root.join("team")
}

/// True when both `/team/` AND `/personal/` already exist at the memory root.
/// The migration shim short-circuits when this is true so re-runs are no-op.
pub fn already_layered(memory_root: &Path) -> bool {
    team_root(memory_root).is_dir() && memory_root.join("personal").is_dir()
}

/// Sanitize a user alias for use as a path segment. Allows ASCII alphanumeric,
/// `-`, `_`, and any non-ASCII letter (so Chinese / Cyrillic aliases survive).
/// Anything else collapses to `-`. Empty results fall back to `me`.
fn sanitize_user(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_dash = true;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
            last_dash = false;
        } else if c.is_alphanumeric() {
            // Keep non-ASCII letters (UTF-8 file names work on Win 1909+).
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        return "me".to_string();
    }
    trimmed
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        PathBuf::from("/tmp/memroot")
    }

    #[test]
    fn resolve_team_dir() {
        let p = resolve_atom_dir(&root(), AtomScope::Team, "anyone", "meetings");
        assert_eq!(p, PathBuf::from("/tmp/memroot/team/meetings"));
    }

    #[test]
    fn resolve_personal_dir_uses_user() {
        let p = resolve_atom_dir(&root(), AtomScope::Personal, "alice", "threads");
        assert_eq!(p, PathBuf::from("/tmp/memroot/personal/alice/threads"));
    }

    #[test]
    fn resolve_personal_dir_sanitizes_user() {
        // `..` cannot escape the personal/ subtree.
        let p = resolve_atom_dir(&root(), AtomScope::Personal, "../../etc", "threads");
        assert_eq!(p, PathBuf::from("/tmp/memroot/personal/etc/threads"));
        // Empty user falls back to "me".
        let p2 = resolve_atom_dir(&root(), AtomScope::Personal, "", "threads");
        assert_eq!(p2, PathBuf::from("/tmp/memroot/personal/me/threads"));
    }

    #[test]
    fn legacy_root_is_flat() {
        let p = resolve_legacy_root(&root(), "meetings");
        assert_eq!(p, PathBuf::from("/tmp/memroot/meetings"));
    }

    #[test]
    fn already_layered_true_when_both_dirs_exist() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_paths_layered_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(tmp.join("team")).unwrap();
        std::fs::create_dir_all(tmp.join("personal")).unwrap();
        assert!(already_layered(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn already_layered_false_when_either_missing() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_paths_unlayered_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(tmp.join("team")).unwrap();
        // `personal/` missing
        assert!(!already_layered(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn sanitize_keeps_non_ascii_letters() {
        let out = sanitize_user("张三");
        assert_eq!(out, "张三");
    }

    #[test]
    fn atom_scope_as_str() {
        assert_eq!(AtomScope::Team.as_str(), "team");
        assert_eq!(AtomScope::Personal.as_str(), "personal");
    }
}
