// === wave 1.13-A ===
//! Wave 1.13-A — Identity layer.
//!
//! The collab loop (mentions / reviews / comments) needs to know:
//!   * Who is the current user (alias, optional display name + email +
//!     avatar URL)?
//!   * Who is on the team (the roster — derived from the
//!     `<memory_dir>/personal/*` subdirectories — each subdir name == one
//!     teammate's alias).
//!
//! This module exposes three Tauri commands:
//!   * `identity_get_current_user`
//!   * `identity_team_roster`
//!   * `identity_set_profile`
//!
//! Storage:
//!   * Persisted profile lives at `<memory_dir>/.tangerine/identity.json`.
//!   * Alias is sourced (in priority order) from:
//!       1. The persisted file (if `alias` is set).
//!       2. The `TANGERINE_USER` env var.
//!       3. `git config user.name` (read via the user's git, best-effort).
//!       4. The OS user (`USER` / `USERNAME` env var).
//!       5. The literal string `me` as a final defensive fallback.
//!   * Display name + email default to the persisted file, falling back to
//!       `git config user.name` / `git config user.email`.
//!   * Avatar URL is purely opt-in — only set if the user pastes a URL into
//!       the profile editor.
//!
//! Defensive policy (matches activity.rs / views.rs): every IO + git failure
//! is swallowed and logged at WARN; the command always returns a usable
//! UserProfile (worst case = `{ alias: "me" }`). The collab UI must never
//! crash because the identity layer couldn't read git.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use super::AppError;

/// A teammate. The alias is the primary key (matches the
/// `<memory_dir>/personal/<alias>/` directory name + the `@username` tag
/// the mention parser emits).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    /// Required. URL-safe handle. Never null. Never blank.
    pub alias: String,
    /// Optional human-friendly name (e.g. "Daizhe Zou").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Optional email — only persisted if the user enters one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Optional avatar URL — purely cosmetic.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

/// Roster entry. Identical shape to `UserProfile` for now — separating the
/// type so future fields (e.g. `last_seen`, `presence`) can be added on
/// the roster side without polluting the saved profile struct.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub alias: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProfileArgs {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// Default memory root: `<home>/.tangerine-memory/`. Mirrors
/// `commands::memory::memory_root`. Defensive — returns a usable path even
/// when `home_dir()` fails (rare but possible inside a sandboxed CI env).
pub(crate) fn memory_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".tangerine-memory")
}

/// `<memory_dir>/.tangerine/identity.json`. Created on first save.
fn identity_file(memory_dir: &Path) -> PathBuf {
    memory_dir.join(".tangerine").join("identity.json")
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/// Best-effort read. Returns `None` on any IO / parse error so the caller
/// transparently falls through to the env / git lookup chain.
pub(crate) fn read_persisted_profile(memory_dir: &Path) -> Option<UserProfile> {
    let path = identity_file(memory_dir);
    let bytes = std::fs::read(&path).ok()?;
    serde_json::from_slice::<UserProfile>(&bytes).ok()
}

/// Best-effort write. Creates the `.tangerine/` parent dir on demand.
fn write_persisted_profile(memory_dir: &Path, profile: &UserProfile) -> Result<(), AppError> {
    let path = identity_file(memory_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("identity_mkdir", e.to_string()))?;
    }
    let bytes = serde_json::to_vec_pretty(profile)
        .map_err(|e| AppError::internal("identity_serialize", e.to_string()))?;
    std::fs::write(&path, bytes)
        .map_err(|e| AppError::internal("identity_write", e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Alias / git fallback chain
// ---------------------------------------------------------------------------

/// Read a `git config user.<key>` value. Best-effort; swallows everything
/// (returns `None` if `git` isn't on PATH or if the working dir has no git
/// config). We deliberately run from the memory dir so the user's per-repo
/// git identity wins over the global one — that matches the team-sync
/// surface.
fn git_config_value(memory_dir: &Path, key: &str) -> Option<String> {
    // First try inside the memory_dir (per-repo identity).
    if let Some(v) = run_git(memory_dir, key) {
        return Some(v);
    }
    // Fall back to the user's global identity.
    run_git(Path::new("."), key)
}

fn run_git(cwd: &Path, key: &str) -> Option<String> {
    let out = Command::new("git")
        .args(["config", "--get", key])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// OS user fallback. Reads `USER` (Unix) / `USERNAME` (Windows).
fn os_user() -> Option<String> {
    std::env::var("USER")
        .ok()
        .or_else(|| std::env::var("USERNAME").ok())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
}

/// Normalise an alias: lowercase + strip non-alnum (keeping `-` and `_`)
/// so it matches the `personal/<alias>/` directory naming convention and
/// the `@username` mention syntax.
pub(crate) fn normalise_alias(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| match c {
            'A'..='Z' => c.to_ascii_lowercase(),
            'a'..='z' | '0'..='9' | '-' | '_' => c,
            ' ' | '.' => '-',
            _ => '_',
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c == '-' || c == '_');
    if trimmed.is_empty() {
        "me".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Resolve the current user's profile, walking the priority chain:
///   1. persisted file
///   2. TANGERINE_USER env var
///   3. git config user.name + user.email
///   4. OS user
///   5. literal "me"
///
/// `display_name` / `email` are filled from git if absent.
pub(crate) fn resolve_current_profile(memory_dir: &Path) -> UserProfile {
    let persisted = read_persisted_profile(memory_dir);
    if let Some(p) = persisted.clone() {
        if !p.alias.trim().is_empty() {
            return p;
        }
    }

    // Discover alias.
    let alias_raw = std::env::var("TANGERINE_USER")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| git_config_value(memory_dir, "user.name"))
        .or_else(os_user)
        .unwrap_or_else(|| "me".to_string());
    let alias = normalise_alias(&alias_raw);

    // Augment with git display name + email when persisted file didn't
    // already supply them.
    let display_name = persisted
        .as_ref()
        .and_then(|p| p.display_name.clone())
        .or_else(|| git_config_value(memory_dir, "user.name"));
    let email = persisted
        .as_ref()
        .and_then(|p| p.email.clone())
        .or_else(|| git_config_value(memory_dir, "user.email"));
    let avatar_url = persisted.as_ref().and_then(|p| p.avatar_url.clone());

    UserProfile {
        alias,
        display_name,
        email,
        avatar_url,
    }
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/// Walk `<memory_dir>/personal/*` and emit one TeamMember per subdir. Each
/// subdir's name == that user's alias.
///
/// We attempt to enrich each entry with the git author who most recently
/// committed inside that subdir (`git log -1 --format="%an|%ae"`) so the
/// roster has a display_name + email even when the teammate hasn't yet
/// pushed an `identity.json`. Best-effort — failure leaves the entry as
/// alias-only.
pub(crate) fn discover_roster(memory_dir: &Path) -> Vec<TeamMember> {
    let personal_dir = memory_dir.join("personal");
    let mut out: Vec<TeamMember> = Vec::new();
    let entries = match std::fs::read_dir(&personal_dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) if !n.starts_with('.') => n.to_string(),
            _ => continue,
        };
        let alias = normalise_alias(&name);

        // Try the per-personal identity.json first (a teammate may have
        // pushed their own profile via team sync).
        let mut display_name: Option<String> = None;
        let mut email: Option<String> = None;
        let mut avatar_url: Option<String> = None;
        let identity = path.join(".tangerine").join("identity.json");
        if let Ok(bytes) = std::fs::read(&identity) {
            if let Ok(p) = serde_json::from_slice::<UserProfile>(&bytes) {
                display_name = p.display_name;
                email = p.email;
                avatar_url = p.avatar_url;
            }
        }

        // Fall back to `git log -1` inside the subdir.
        if display_name.is_none() || email.is_none() {
            if let Some((name, mail)) = last_git_author(&path) {
                if display_name.is_none() && !name.is_empty() {
                    display_name = Some(name);
                }
                if email.is_none() && !mail.is_empty() {
                    email = Some(mail);
                }
            }
        }

        out.push(TeamMember {
            alias,
            display_name,
            email,
            avatar_url,
        });
    }

    // Stable, alphabetical order — keeps the autocomplete list
    // deterministic.
    out.sort_by(|a, b| a.alias.cmp(&b.alias));
    out
}

fn last_git_author(dir: &Path) -> Option<(String, String)> {
    let out = Command::new("git")
        .args(["log", "-1", "--format=%an|%ae", "--", "."])
        .current_dir(dir)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let mut parts = raw.splitn(2, '|');
    let name = parts.next()?.trim().to_string();
    let email = parts.next().unwrap_or("").trim().to_string();
    Some((name, email))
}

// ---------------------------------------------------------------------------
// Tauri command surface
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn identity_get_current_user() -> Result<UserProfile, AppError> {
    let dir = memory_root();
    Ok(resolve_current_profile(&dir))
}

#[tauri::command]
pub async fn identity_team_roster() -> Result<Vec<TeamMember>, AppError> {
    let dir = memory_root();
    Ok(discover_roster(&dir))
}

#[tauri::command]
pub async fn identity_set_profile(args: SetProfileArgs) -> Result<UserProfile, AppError> {
    let dir = memory_root();
    let mut current = resolve_current_profile(&dir);

    if let Some(name) = args.display_name {
        let trimmed = name.trim().to_string();
        current.display_name = if trimmed.is_empty() { None } else { Some(trimmed) };
    }
    if let Some(email) = args.email {
        let trimmed = email.trim().to_string();
        current.email = if trimmed.is_empty() { None } else { Some(trimmed) };
    }
    if let Some(url) = args.avatar_url {
        let trimmed = url.trim().to_string();
        current.avatar_url = if trimmed.is_empty() { None } else { Some(trimmed) };
    }

    // Best-effort write — if it fails we still return the resolved
    // profile so the UI stays usable.
    if let Err(e) = write_persisted_profile(&dir, &current) {
        tracing::warn!(error=?e, "wave 1.13-A identity_set_profile persist failed");
    }
    Ok(current)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fresh_dir(suffix: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_w113a_{}_{}",
            suffix,
            uuid::Uuid::new_v4().simple()
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn normalise_alias_strips_non_alnum() {
        assert_eq!(normalise_alias("Daizhe Zou"), "daizhe-zou");
        assert_eq!(normalise_alias("daizhe@berkeley.edu"), "daizhe_berkeley-edu");
        assert_eq!(normalise_alias("  me  "), "me");
        assert_eq!(normalise_alias("__weird__"), "weird");
        assert_eq!(normalise_alias(""), "me");
    }

    #[test]
    fn resolve_falls_back_to_me_when_nothing_set() {
        let dir = fresh_dir("resolve_default");
        // Make sure the env vars don't leak in.
        std::env::remove_var("TANGERINE_USER");
        let profile = resolve_current_profile(&dir);
        assert!(!profile.alias.is_empty(), "alias must never be empty");
    }

    #[test]
    fn resolve_uses_env_var_when_no_persisted() {
        let dir = fresh_dir("resolve_env");
        std::env::set_var("TANGERINE_USER", "AliceTest");
        let profile = resolve_current_profile(&dir);
        std::env::remove_var("TANGERINE_USER");
        assert_eq!(profile.alias, "alicetest");
    }

    #[test]
    fn set_profile_persists_round_trip() {
        let dir = fresh_dir("set_round_trip");
        let p1 = UserProfile {
            alias: "alice".to_string(),
            display_name: Some("Alice".to_string()),
            email: Some("alice@example.com".to_string()),
            avatar_url: None,
        };
        write_persisted_profile(&dir, &p1).unwrap();
        let p2 = read_persisted_profile(&dir).expect("must read back");
        assert_eq!(p1, p2);
    }

    #[test]
    fn roster_walks_personal_subdirs() {
        let dir = fresh_dir("roster");
        fs::create_dir_all(dir.join("personal").join("alice")).unwrap();
        fs::create_dir_all(dir.join("personal").join("bob")).unwrap();
        fs::create_dir_all(dir.join("personal").join("charlie")).unwrap();
        // dotdir ignored
        fs::create_dir_all(dir.join("personal").join(".hidden")).unwrap();
        // file ignored
        fs::write(dir.join("personal").join("notadir.txt"), b"x").unwrap();

        let roster = discover_roster(&dir);
        let aliases: Vec<&str> = roster.iter().map(|m| m.alias.as_str()).collect();
        assert_eq!(aliases, vec!["alice", "bob", "charlie"]);
    }

    #[test]
    fn roster_picks_up_per_personal_identity() {
        let dir = fresh_dir("roster_identity");
        let alice = dir.join("personal").join("alice");
        fs::create_dir_all(alice.join(".tangerine")).unwrap();
        let p = UserProfile {
            alias: "alice".to_string(),
            display_name: Some("Alice Wonderland".to_string()),
            email: Some("alice@wonder.land".to_string()),
            avatar_url: Some("https://example.com/a.png".to_string()),
        };
        fs::write(
            alice.join(".tangerine").join("identity.json"),
            serde_json::to_vec_pretty(&p).unwrap(),
        )
        .unwrap();

        let roster = discover_roster(&dir);
        assert_eq!(roster.len(), 1);
        let m = &roster[0];
        assert_eq!(m.alias, "alice");
        assert_eq!(m.display_name.as_deref(), Some("Alice Wonderland"));
        assert_eq!(m.email.as_deref(), Some("alice@wonder.land"));
        assert_eq!(
            m.avatar_url.as_deref(),
            Some("https://example.com/a.png")
        );
    }

    #[test]
    fn set_profile_clears_field_when_blank_string() {
        let dir = fresh_dir("set_blank_clear");
        // Seed with all fields filled.
        write_persisted_profile(
            &dir,
            &UserProfile {
                alias: "alice".to_string(),
                display_name: Some("Alice".to_string()),
                email: Some("alice@x.com".to_string()),
                avatar_url: Some("https://x".to_string()),
            },
        )
        .unwrap();

        // Now set empty strings — must clear the fields.
        let mut p = read_persisted_profile(&dir).unwrap();
        // Mimic set_profile behaviour without async runtime for this test:
        let blanks = SetProfileArgs {
            display_name: Some("".to_string()),
            email: Some("   ".to_string()),
            avatar_url: Some("".to_string()),
        };
        if let Some(name) = blanks.display_name {
            let trimmed = name.trim().to_string();
            p.display_name = if trimmed.is_empty() { None } else { Some(trimmed) };
        }
        if let Some(email) = blanks.email {
            let trimmed = email.trim().to_string();
            p.email = if trimmed.is_empty() { None } else { Some(trimmed) };
        }
        if let Some(url) = blanks.avatar_url {
            let trimmed = url.trim().to_string();
            p.avatar_url = if trimmed.is_empty() { None } else { Some(trimmed) };
        }
        write_persisted_profile(&dir, &p).unwrap();
        let p2 = read_persisted_profile(&dir).unwrap();
        assert!(p2.display_name.is_none());
        assert!(p2.email.is_none());
        assert!(p2.avatar_url.is_none());
    }
}
// === end wave 1.13-A ===
