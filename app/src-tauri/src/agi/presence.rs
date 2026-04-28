// === wave 1.13-D ===
//! v1.13 Wave 1.13-D — git-mediated team-presence layer.
//!
//! Real-time presence ("see what teammates are looking at right now") only
//! works if every team member's machine can see what every other team
//! member's machine is doing. v1.13 ships **Path B** (git-mediated): each
//! user app writes its own presence file under
//! `<memory_root>/.tangerine/presence/{user}.json` once every 10 seconds
//! when the user is active; the existing v1.10 `git_sync` layer pushes
//! that file along with everything else, and on the next pull the remote
//! presence files land on disk where the reader half of this module picks
//! them up.
//!
//! Path A (LAN UDP discovery + peer-to-peer ws) is the future-enhancement
//! lane (v1.13.1+). We stub the `/presence` ws path in `ws_server.rs` so
//! the wire shape is reserved, but the React client only consumes the
//! git-mediated reader for v1.13.
//!
//! Layout:
//!   * `PresenceInfo` — the on-disk JSON shape, mirrors
//!     `app/src/components/presence/PresenceProvider.tsx::PresenceInfo`.
//!   * `presence_dir` / `presence_path` — file-layout helpers.
//!   * `write_local_presence` — heartbeat-side writer. Soft-fails (logged
//!     `tracing::warn!`) so a bad disk never blocks the heartbeat or atom
//!     write that called it. CEO rule: presence write failures must NOT
//!     cascade.
//!   * `read_active_presences` — reader applying a TTL filter so stale
//!     entries (offline teammate, machine sleeping) drop out cleanly.
//!   * `prune_stale` — best-effort GC for entries older than 24h. Called
//!     by the daemon at boot so a long-offline teammate's file doesn't
//!     stay forever.
//!
//! Wave 1.13-A owns Identity (UserProfile / TeamMember / team_roster).
//! When their roster module lands, the React `TeammateAvatar` component
//! reads the roster to render the right initials / gravatar; this module
//! only knows about the `user` string (matches roster's `alias` field).

#![allow(dead_code)]

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::commands::AppError;

/// On-disk presence shape.
///
/// One file per teammate at `<memory_root>/.tangerine/presence/{user}.json`.
/// Files are tiny (a few hundred bytes) so writing the whole blob each
/// heartbeat is cheaper than appending a JSONL log — the reader only ever
/// needs the freshest state per user.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PresenceInfo {
    /// The teammate's alias — same string as `team_roster.alias` (Wave
    /// 1.13-A). The React side joins on this to render avatars.
    pub user: String,
    /// React-router pathname the teammate is currently viewing.
    /// Examples: `/today`, `/memory`, `/brain`, `/canvas/foo`.
    pub current_route: String,
    /// Atom path being viewed if the teammate is on an atom-preview surface
    /// (Wave 21 — `/memory` tree click → atom preview). Relative to the
    /// memory root. `None` for non-atom routes.
    pub active_atom: Option<String>,
    /// Most recent action type, e.g. `route_change`, `atom_open`, `edit`.
    /// Free-form string — the reader treats it as opaque label text.
    pub action_type: Option<String>,
    /// ISO 8601 timestamp of the heartbeat that wrote this file. Used by
    /// `read_active_presences` to apply the TTL filter and by the React
    /// reader to render "last active 12 s ago".
    pub last_active: String,
    /// ISO 8601 timestamp of when the user joined this session — bumps
    /// only on app start. Lets the React side display "online for 2 h".
    pub started_at: String,
}

impl PresenceInfo {
    /// Construct a fresh presence record. `last_active` defaults to now.
    pub fn new(user: impl Into<String>, current_route: impl Into<String>) -> Self {
        let now = Utc::now().to_rfc3339();
        Self {
            user: user.into(),
            current_route: current_route.into(),
            active_atom: None,
            action_type: None,
            last_active: now.clone(),
            started_at: now,
        }
    }
}

/// Resolve the presence directory under the memory root.
pub fn presence_dir(memory_root: &Path) -> PathBuf {
    memory_root.join(".tangerine").join("presence")
}

/// Resolve the absolute path for one user's presence file.
pub fn presence_path(memory_root: &Path, user: &str) -> PathBuf {
    presence_dir(memory_root).join(format!("{}.json", sanitize_user(user)))
}

/// Strip path separators / control chars from the user string before it
/// becomes part of a filename. The roster's alias field is already
/// constrained to safe characters (Wave 1.13-A), but defence-in-depth so
/// a malformed alias from an old client can never escape the dir.
fn sanitize_user(user: &str) -> String {
    user.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect::<String>()
        .trim_matches('.')
        .to_string()
}

/// Atomically write one user's presence file.
///
/// === v1.14.6 round-7 === — error-propagation tightening.
/// Pre-R7 this swallowed *all* I/O errors and always returned `Ok(())`.
/// R7 audit caught the silent mode masking PermissionDenied / quota /
/// keychain-locked-mount errors so the user never knew their presence
/// file wasn't being shared. Now:
///   * Hard errors (`PermissionDenied`, `ReadOnlyFilesystem` and friends)
///     propagate up through `Result<(), AppError>` so the React side
///     can surface a one-shot toast.
///   * Soft errors (transient `Other` / `Interrupted` / serialize fail
///     on a single tick) still warn-log and return `Ok(())` so the
///     heartbeat keeps ticking.
/// `presence_emit` swallows the propagated error after telemetry so the
/// React render path is still safe (CEO rule: presence write failures
/// must not cascade) but the Rust observability layer finally has a
/// signal it can act on.
///
/// Defensive write strategy: write to `<file>.tmp` then rename. Avoids a
/// reader on another machine seeing a half-written JSON blob if the git
/// sync ticker happens to fire mid-write (race window is tiny but real).
pub fn write_local_presence(memory_root: &Path, info: &PresenceInfo) -> Result<(), AppError> {
    let path = presence_path(memory_root, &info.user);
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            tracing::warn!(
                dir = %parent.display(),
                error = %e,
                "presence: mkdir failed"
            );
            // === v1.14.6 round-7 === — propagate hard FS errors so the
            // caller can surface them. Soft errors (Interrupted, Other)
            // still soft-fail to keep the heartbeat resilient.
            if is_hard_fs_error(&e) {
                return Err(AppError::internal(
                    "presence_write_mkdir",
                    format!("{}: {}", parent.display(), e),
                ));
            }
            return Ok(());
        }
    }

    let json = match serde_json::to_string_pretty(info) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, user = %info.user, "presence: serialize failed");
            return Ok(());
        }
    };

    let tmp = path.with_extension("json.tmp");
    {
        let mut f = match OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp)
        {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!(
                    path = %tmp.display(),
                    error = %e,
                    "presence: open tmp failed"
                );
                // === v1.14.6 round-7 === — same hard-error split.
                if is_hard_fs_error(&e) {
                    return Err(AppError::internal(
                        "presence_write_open",
                        format!("{}: {}", tmp.display(), e),
                    ));
                }
                return Ok(());
            }
        };
        if let Err(e) = f.write_all(json.as_bytes()) {
            tracing::warn!(error = %e, "presence: write tmp failed");
            if is_hard_fs_error(&e) {
                return Err(AppError::internal(
                    "presence_write_payload",
                    format!("{}: {}", tmp.display(), e),
                ));
            }
            return Ok(());
        }
    }

    if let Err(e) = fs::rename(&tmp, &path) {
        tracing::warn!(
            from = %tmp.display(),
            to = %path.display(),
            error = %e,
            "presence: rename failed"
        );
        // Best-effort cleanup; ignore errors on cleanup itself.
        let _ = fs::remove_file(&tmp);
        if is_hard_fs_error(&e) {
            return Err(AppError::internal(
                "presence_write_rename",
                format!("{}->{}: {}", tmp.display(), path.display(), e),
            ));
        }
    }
    Ok(())
}

// === v1.14.6 round-7 ===
/// Split FS errors into "user needs to know" vs "transient — keep ticking".
/// Hard = PermissionDenied (keychain-locked mount on macOS, ACL on Win32),
/// ReadOnlyFilesystem (root partition mounted RO), StorageFull (disk full
/// or quota). These are the failure modes a user CAN act on (unlock
/// keychain, remount RW, free disk).
/// Soft = Interrupted / Other / WouldBlock — keep heartbeat resilient.
/// Conservative variant set so we compile against the project's pinned
/// Rust 1.89 toolchain without depending on still-unstable variants.
fn is_hard_fs_error(e: &std::io::Error) -> bool {
    use std::io::ErrorKind;
    matches!(
        e.kind(),
        ErrorKind::PermissionDenied
            | ErrorKind::ReadOnlyFilesystem
            | ErrorKind::StorageFull
    )
}
// === end v1.14.6 round-7 ===

/// Read every presence file under `<memory_root>/.tangerine/presence/`
/// whose `last_active` is within `ttl` of now. Returns newest-first.
///
/// Soft-fail semantics: a malformed JSON file (older client schema, half-
/// written file, etc.) is silently skipped — presence is observational, a
/// single bad file shouldn't break the entire read.
pub fn read_active_presences(
    memory_root: &Path,
    ttl: Duration,
    exclude_user: Option<&str>,
) -> Vec<PresenceInfo> {
    let dir = presence_dir(memory_root);
    let entries = match fs::read_dir(&dir) {
        Ok(it) => it,
        Err(_) => return Vec::new(),
    };

    let cutoff = Utc::now() - ttl;
    let mut out: Vec<PresenceInfo> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let info: PresenceInfo = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(skip) = exclude_user {
            if info.user == skip {
                continue;
            }
        }
        if let Ok(parsed) = DateTime::parse_from_rfc3339(&info.last_active) {
            if parsed.with_timezone(&Utc) < cutoff {
                continue;
            }
        }
        out.push(info);
    }

    // Newest-first by last_active. Entries with unparsable timestamps sort
    // to the end (we already filtered out stale ones above).
    out.sort_by(|a, b| {
        let pa = DateTime::parse_from_rfc3339(&a.last_active).ok();
        let pb = DateTime::parse_from_rfc3339(&b.last_active).ok();
        pb.cmp(&pa)
    });
    out
}

/// Best-effort: delete presence files older than 24 h. Called by the
/// daemon at boot so a long-departed teammate's stale file doesn't stay
/// forever in git history's HEAD checkout.
pub fn prune_stale(memory_root: &Path, max_age_hours: i64) -> u32 {
    let dir = presence_dir(memory_root);
    let entries = match fs::read_dir(&dir) {
        Ok(it) => it,
        Err(_) => return 0,
    };
    let cutoff = Utc::now() - Duration::hours(max_age_hours);
    let mut deleted = 0u32;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let info: PresenceInfo = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => {
                // Malformed — purge so the dir self-heals.
                if fs::remove_file(&path).is_ok() {
                    deleted += 1;
                }
                continue;
            }
        };
        if let Ok(parsed) = DateTime::parse_from_rfc3339(&info.last_active) {
            if parsed.with_timezone(&Utc) < cutoff {
                if fs::remove_file(&path).is_ok() {
                    deleted += 1;
                }
            }
        }
    }
    deleted
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_presence_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn write_and_read_round_trip_returns_record() {
        let root = tmp_root();
        let mut info = PresenceInfo::new("daizhe", "/memory");
        info.active_atom = Some("team/decisions/2026-04-27-presence.md".into());
        info.action_type = Some("atom_open".into());
        write_local_presence(&root, &info).unwrap();

        // Reader sees ourselves when no exclusion filter.
        let active = read_active_presences(&root, Duration::seconds(60), None);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].user, "daizhe");
        assert_eq!(active[0].current_route, "/memory");
        assert_eq!(
            active[0].active_atom.as_deref(),
            Some("team/decisions/2026-04-27-presence.md")
        );
        assert_eq!(active[0].action_type.as_deref(), Some("atom_open"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ttl_filter_drops_stale_entries() {
        let root = tmp_root();
        // Fresh teammate.
        let fresh = PresenceInfo::new("hongyu", "/brain");
        write_local_presence(&root, &fresh).unwrap();

        // Stale teammate — write a file by hand with last_active = 5 min ago.
        let stale = PresenceInfo {
            user: "alice".into(),
            current_route: "/today".into(),
            active_atom: None,
            action_type: None,
            last_active: (Utc::now() - Duration::minutes(5)).to_rfc3339(),
            started_at: (Utc::now() - Duration::minutes(30)).to_rfc3339(),
        };
        write_local_presence(&root, &stale).unwrap();

        // 60s TTL → only `hongyu` survives.
        let active = read_active_presences(&root, Duration::seconds(60), None);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].user, "hongyu");

        // 10-minute TTL → both survive.
        let active = read_active_presences(&root, Duration::minutes(10), None);
        assert_eq!(active.len(), 2);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn exclude_user_filter_omits_self() {
        let root = tmp_root();
        write_local_presence(&root, &PresenceInfo::new("daizhe", "/today")).unwrap();
        write_local_presence(&root, &PresenceInfo::new("hongyu", "/brain")).unwrap();
        write_local_presence(&root, &PresenceInfo::new("alice", "/memory")).unwrap();

        let teammates = read_active_presences(&root, Duration::seconds(60), Some("daizhe"));
        assert_eq!(teammates.len(), 2);
        assert!(teammates.iter().all(|p| p.user != "daizhe"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn multiple_users_returned_newest_first() {
        let root = tmp_root();
        // Manually stamp last_active so we control ordering deterministically.
        for (user, route, ago_secs) in [
            ("alice", "/today", 30i64),
            ("bob", "/canvas", 5i64),
            ("daizhe", "/memory", 15i64),
        ] {
            let info = PresenceInfo {
                user: user.into(),
                current_route: route.into(),
                active_atom: None,
                action_type: None,
                last_active: (Utc::now() - Duration::seconds(ago_secs)).to_rfc3339(),
                started_at: (Utc::now() - Duration::minutes(60)).to_rfc3339(),
            };
            write_local_presence(&root, &info).unwrap();
        }

        let active = read_active_presences(&root, Duration::seconds(60), None);
        assert_eq!(active.len(), 3);
        assert_eq!(active[0].user, "bob"); // 5s ago — newest
        assert_eq!(active[1].user, "daizhe"); // 15s
        assert_eq!(active[2].user, "alice"); // 30s

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_stale_removes_old_files_keeps_fresh() {
        let root = tmp_root();
        // Fresh — keep.
        write_local_presence(&root, &PresenceInfo::new("daizhe", "/today")).unwrap();
        // Stale (48h ago) — prune.
        let stale = PresenceInfo {
            user: "departed".into(),
            current_route: "/memory".into(),
            active_atom: None,
            action_type: None,
            last_active: (Utc::now() - Duration::hours(48)).to_rfc3339(),
            started_at: (Utc::now() - Duration::hours(48)).to_rfc3339(),
        };
        write_local_presence(&root, &stale).unwrap();

        let removed = prune_stale(&root, 24);
        assert_eq!(removed, 1);

        // Fresh file is still there.
        let active = read_active_presences(&root, Duration::hours(72), None);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].user, "daizhe");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn malformed_json_is_silently_skipped() {
        let root = tmp_root();
        // Real entry.
        write_local_presence(&root, &PresenceInfo::new("daizhe", "/today")).unwrap();
        // Junk file — must not crash the read path.
        let dir = presence_dir(&root);
        std::fs::write(dir.join("junk.json"), "not real json {").unwrap();

        let active = read_active_presences(&root, Duration::seconds(60), None);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].user, "daizhe");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sanitize_user_strips_path_separators() {
        // Defence-in-depth — alias field is already constrained, but if a
        // future client mis-stamps it we never escape the presence dir.
        let p = presence_path(Path::new("/tmp/mem"), "../../etc/passwd");
        // After sanitize, `..` becomes empty; the user becomes "etcpasswd".
        let last = p.file_name().unwrap().to_string_lossy().to_string();
        assert!(!last.contains("/"));
        assert!(!last.contains(".."));
        assert!(last.ends_with(".json"));
    }

    // === v1.14.6 round-7 ===
    #[test]
    fn hard_fs_error_classifier_matches_actionable_kinds() {
        use std::io::{Error, ErrorKind};
        // Hard — user can act on these.
        assert!(is_hard_fs_error(&Error::new(
            ErrorKind::PermissionDenied,
            "ACL"
        )));
        assert!(is_hard_fs_error(&Error::new(
            ErrorKind::ReadOnlyFilesystem,
            "ro mount"
        )));
        assert!(is_hard_fs_error(&Error::new(
            ErrorKind::StorageFull,
            "disk full"
        )));
        // Soft — heartbeat keeps ticking.
        assert!(!is_hard_fs_error(&Error::new(
            ErrorKind::Interrupted,
            "EINTR"
        )));
        assert!(!is_hard_fs_error(&Error::new(
            ErrorKind::WouldBlock,
            "would block"
        )));
        assert!(!is_hard_fs_error(&Error::new(ErrorKind::Other, "misc")));
    }
    // === end v1.14.6 round-7 ===
}
// === end wave 1.13-D ===
