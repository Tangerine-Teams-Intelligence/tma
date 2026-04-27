//! v3.5 §5.2 — Enterprise audit log (Wave 2: HMAC chain + region routing + export).
//!
//! Append-only, per-day JSONL log of every state-mutating action. Mirrors
//! the existing `agi::telemetry` storage pattern but with stricter
//! immutability:
//!
//!   `~/.tangerine-memory/.tangerine/audit/{YYYY-MM-DD}.jsonl`
//!
//! ## Region routing
//!
//! v3.5 wave 2 reads the daemon-local region preference from
//! `~/.tangerine-memory/.tangerine/region.txt` (default `"us-east"` when the
//! file is missing or empty). The accepted values are `"china"`, `"us-east"`,
//! `"us-west"`, `"eu-west"`. Real per-tenant region routing (per spec §4.2 /
//! §5.3) lights up in the enterprise production cut once the per-tenant
//! Postgres / S3 isolation lands; this file-based stub is enough to lock
//! the IPC contract and let the admin console show the correct region.
//!
//! ## HMAC chain (tamper detection)
//!
//! Each entry carries a SHA-256 HMAC of the form:
//!
//!   `chain_n = HMAC(secret, prev_chain || canonical(entry_n_without_chain))`
//!
//! `prev_chain` is the empty string for the first entry of the day. The
//! daemon-local secret lives at
//! `~/.tangerine-memory/.tangerine/audit_secret` (32 random bytes generated
//! on first use, mode 0600 on POSIX). `verify_chain` walks a slice of
//! `AuditEntry`s and re-computes each chain hash to detect tampering.
//!
//! HMAC is computed by hand (HMAC-SHA-256 is 9 lines of code with `sha2`)
//! to avoid pulling in the `hmac` crate just for one call site — keeps the
//! dep tree lean per the deployment iron rules.
//!
//! ## Append semantics
//!
//! Each event is one JSON object on one line, written via
//! `OpenOptions::new().append(true)`. POSIX `O_APPEND` writes shorter than
//! `PIPE_BUF` are atomic on every platform we ship — same model as
//! `agi::telemetry::append_event`. The HMAC chain is computed before the
//! append fires, so a partial write leaves the chain re-verifiable up to
//! the last successfully-written entry.
//!
//! ## Export (SOC 2)
//!
//! `export_window` walks every entry between two UTC dates inclusive and
//! returns them sorted by `ts`. The Tauri command surface (`audit_log_export`)
//! is the SOC 2 audit-evidence pull endpoint — the auditor passes a date
//! range, the daemon returns the entries with their HMAC chain intact so
//! the auditor can re-verify tamper-freeness offline.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::commands::AppError;

/// Default region stamped onto entries when no `region.txt` is present. Matches
/// the historical stub default so existing on-disk JSONL files remain
/// re-verifiable after this upgrade.
pub const DEFAULT_REGION: &str = "us-east";

/// Canonical region values accepted by `region.txt`. Anything else falls back
/// to `DEFAULT_REGION` so a typo in the config file can't tank the daemon.
const VALID_REGIONS: &[&str] = &["china", "us-east", "us-west", "eu-west"];

/// One audit log entry. Field names mirror the TypeScript shape that
/// `app/src/lib/tauri.ts` exports for the React-side admin console. The
/// `payload` field is JSON so the writer never has to be rebuilt for a
/// new action type.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuditEntry {
    /// ISO 8601 timestamp. The writer stamps this on the way in if
    /// `Option::None`.
    pub ts: DateTime<Utc>,
    /// User alias performing the action.
    pub user: String,
    /// Action name. Free-form string — see `V3_5_SPEC.md` §5.2 for the
    /// initial taxonomy (`auth.login`, `brain.write`, `template.install`,
    /// `branding.update`, ...).
    pub action: String,
    /// Resource the action targets (atom id, template id, tenant id, ...).
    pub resource: String,
    /// Optional client IP. Stub mode lets the caller stamp this; real
    /// production reads from the inbound HTTP request.
    pub ip: Option<String>,
    /// Optional User-Agent string.
    pub user_agent: Option<String>,
    /// Region the entry was written in. Read from
    /// `~/.tangerine-memory/.tangerine/region.txt`; default `us-east`.
    pub region: String,
    /// HMAC-SHA-256 chain hash. `chain_n = HMAC(secret, prev_chain || canon)`
    /// where `canon` is the canonical JSON of the entry sans this field. The
    /// first entry of the day is computed with `prev_chain = ""`. Stored as
    /// a lowercase hex string. Empty when the writer pre-dates the chain.
    #[serde(default)]
    pub chain: String,
}

/// What the writer accepts. Lets the caller omit `ts`, `region`, and `chain`
/// so the writer can stamp them deterministically — keeps the IPC contract
/// consistent with the production cut.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntryInput {
    pub user: String,
    pub action: String,
    pub resource: String,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

fn tangerine_dir(memory_root: &Path) -> Result<PathBuf, AppError> {
    let dir = memory_root.join(".tangerine");
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal("audit_mkdir", e.to_string()))?;
    Ok(dir)
}

fn audit_dir(memory_root: &Path) -> Result<PathBuf, AppError> {
    let dir = tangerine_dir(memory_root)?.join("audit");
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal("audit_mkdir", e.to_string()))?;
    Ok(dir)
}

fn day_file(memory_root: &Path, day: NaiveDate) -> Result<PathBuf, AppError> {
    Ok(audit_dir(memory_root)?.join(format!("{}.jsonl", day)))
}

fn region_path(memory_root: &Path) -> Result<PathBuf, AppError> {
    Ok(tangerine_dir(memory_root)?.join("region.txt"))
}

fn secret_path(memory_root: &Path) -> Result<PathBuf, AppError> {
    Ok(tangerine_dir(memory_root)?.join("audit_secret"))
}

/// Read the configured region from `region.txt`. Falls back to the default
/// when the file is missing, empty, or contains an unrecognized value. Never
/// errors — region-reading must be infallible from the daemon's perspective
/// since every audit append depends on it.
pub fn read_region(memory_root: &Path) -> String {
    let path = match region_path(memory_root) {
        Ok(p) => p,
        Err(_) => return DEFAULT_REGION.to_string(),
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(v) => v,
        Err(_) => return DEFAULT_REGION.to_string(),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return DEFAULT_REGION.to_string();
    }
    if VALID_REGIONS.iter().any(|v| *v == trimmed) {
        trimmed.to_string()
    } else {
        DEFAULT_REGION.to_string()
    }
}

/// Persist a new region preference. Returns the canonical region string the
/// daemon will use going forward. Invalid values are rejected with a
/// `User`-tagged error so the React-side admin console can surface the typo.
pub fn write_region(memory_root: &Path, region: &str) -> Result<String, AppError> {
    let trimmed = region.trim();
    if !VALID_REGIONS.iter().any(|v| *v == trimmed) {
        return Err(AppError::user(
            "audit_bad_region",
            format!(
                "region '{}' not in {{china,us-east,us-west,eu-west}}",
                trimmed
            ),
        ));
    }
    let path = region_path(memory_root)?;
    std::fs::write(&path, trimmed)
        .map_err(|e| AppError::internal("audit_region_write", e.to_string()))?;
    Ok(trimmed.to_string())
}

/// Read or generate the daemon-local audit secret. Generated lazily on first
/// audit write, persisted to disk so the chain survives a daemon restart. We
/// hand-roll this with `rand` (already a direct dep) to avoid a dedicated
/// key-management crate — fine for stub mode; the production cut moves the
/// secret into the OS keychain via the existing `keyring` dep.
fn read_or_create_secret(memory_root: &Path) -> Result<Vec<u8>, AppError> {
    let path = secret_path(memory_root)?;
    if path.exists() {
        let raw = std::fs::read(&path)
            .map_err(|e| AppError::internal("audit_secret_read", e.to_string()))?;
        if !raw.is_empty() {
            return Ok(raw);
        }
    }
    use rand::RngCore;
    let mut buf = vec![0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    std::fs::write(&path, &buf)
        .map_err(|e| AppError::internal("audit_secret_write", e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(buf)
}

// ---------------------------------------------------------------------------
// HMAC-SHA-256 (hand-rolled, no `hmac` crate)
// ---------------------------------------------------------------------------

const HMAC_BLOCK: usize = 64;

fn hmac_sha256(secret: &[u8], message: &[u8]) -> [u8; 32] {
    // Per RFC 2104 — fold the secret to <= block size, then ipad/opad.
    let mut key = if secret.len() > HMAC_BLOCK {
        let mut h = Sha256::new();
        h.update(secret);
        h.finalize().to_vec()
    } else {
        secret.to_vec()
    };
    key.resize(HMAC_BLOCK, 0);
    let mut ipad = [0x36u8; HMAC_BLOCK];
    let mut opad = [0x5cu8; HMAC_BLOCK];
    for i in 0..HMAC_BLOCK {
        ipad[i] ^= key[i];
        opad[i] ^= key[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_digest);
    let out = outer.finalize();
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&out);
    bytes
}

/// Compute the chain hash for one entry. `prev_chain` is the hex chain hash
/// of the previous entry, or the empty string for the first entry of the
/// day. The entry's own `chain` field is excluded from the hashed canonical
/// form (otherwise the hash would depend on itself).
fn compute_chain(secret: &[u8], prev_chain: &str, entry: &AuditEntry) -> Result<String, AppError> {
    let mut canon = entry.clone();
    canon.chain = String::new();
    let canon_json = serde_json::to_string(&canon)
        .map_err(|e| AppError::internal("audit_canon_serialize", e.to_string()))?;
    let mut msg = Vec::with_capacity(prev_chain.len() + 1 + canon_json.len());
    msg.extend_from_slice(prev_chain.as_bytes());
    msg.push(b'|');
    msg.extend_from_slice(canon_json.as_bytes());
    let mac = hmac_sha256(secret, &msg);
    Ok(hex::encode(mac))
}

/// Walk every entry on disk for a given day to recover the previous chain
/// hash. Empty file ⇒ empty string. Used by `append` to extend the chain
/// across daemon restarts.
fn previous_chain_for_day(memory_root: &Path, day: NaiveDate) -> Result<String, AppError> {
    let entries = read_day(memory_root, day)?;
    Ok(entries.last().map(|e| e.chain.clone()).unwrap_or_default())
}

/// Verify an in-memory slice of entries by recomputing each chain hash from
/// the previous one. Returns the index of the first tampered entry (or
/// `None` when the slice is intact). The first entry is assumed to start
/// from `prev_chain = ""` — pass an explicit `prev_chain` to verify a
/// suffix of the day.
pub fn verify_chain(
    memory_root: &Path,
    entries: &[AuditEntry],
    prev_chain: &str,
) -> Result<Option<usize>, AppError> {
    let secret = read_or_create_secret(memory_root)?;
    let mut prev = prev_chain.to_string();
    for (i, entry) in entries.iter().enumerate() {
        // Pre-chain entries (chain = "") are accepted as-is so the upgrade
        // doesn't reject historical files written before this revision.
        if entry.chain.is_empty() {
            prev = String::new();
            continue;
        }
        let expected = compute_chain(&secret, &prev, entry)?;
        if expected != entry.chain {
            return Ok(Some(i));
        }
        prev = entry.chain.clone();
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// Append / read
// ---------------------------------------------------------------------------

/// Append one entry for today (UTC). Stamps region from `region.txt` (default
/// `us-east`) and a fresh HMAC chain hash extending the day's existing log.
pub fn append(memory_root: &Path, input: AuditEntryInput) -> Result<AuditEntry, AppError> {
    let now = Utc::now();
    let region = read_region(memory_root);
    let mut entry = AuditEntry {
        ts: now,
        user: input.user,
        action: input.action,
        resource: input.resource,
        ip: input.ip,
        user_agent: input.user_agent,
        region,
        chain: String::new(),
    };
    let secret = read_or_create_secret(memory_root)?;
    let prev_chain = previous_chain_for_day(memory_root, now.date_naive())?;
    entry.chain = compute_chain(&secret, &prev_chain, &entry)?;

    let path = day_file(memory_root, now.date_naive())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| AppError::internal("audit_open", e.to_string()))?;
    let mut line = serde_json::to_string(&entry)?;
    line.push('\n');
    file.write_all(line.as_bytes())
        .map_err(|e| AppError::internal("audit_write", e.to_string()))?;
    Ok(entry)
}

/// Read every entry for a given UTC day. Empty file ⇒ empty Vec; missing
/// file ⇒ empty Vec.
pub fn read_day(memory_root: &Path, day: NaiveDate) -> Result<Vec<AuditEntry>, AppError> {
    let path = day_file(memory_root, day)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| AppError::internal("audit_read_day", e.to_string()))?;
    let mut out = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<AuditEntry>(line) {
            Ok(e) => out.push(e),
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    line = %line,
                    "skipping malformed audit entry"
                );
            }
        }
    }
    Ok(out)
}

/// Read every entry from the last `days` UTC days. `days = 0` ⇒ today only.
pub fn read_window(memory_root: &Path, days: u32) -> Result<Vec<AuditEntry>, AppError> {
    let today = Utc::now().date_naive();
    let mut out = Vec::new();
    for n in 0..=days {
        if let Some(d) = today.checked_sub_signed(chrono::Duration::days(n as i64)) {
            out.extend(read_day(memory_root, d)?);
        }
    }
    out.sort_by(|a, b| a.ts.cmp(&b.ts));
    Ok(out)
}

/// Search across the audit log. Filters by free-text substring on
/// `action` + `resource` + `user` and an optional day window. Empty query
/// returns every entry in-window.
pub fn search(
    memory_root: &Path,
    query: &str,
    days: u32,
) -> Result<Vec<AuditEntry>, AppError> {
    let q = query.to_lowercase();
    let entries = read_window(memory_root, days)?;
    if q.is_empty() {
        return Ok(entries);
    }
    Ok(entries
        .into_iter()
        .filter(|e| {
            e.action.to_lowercase().contains(&q)
                || e.resource.to_lowercase().contains(&q)
                || e.user.to_lowercase().contains(&q)
        })
        .collect())
}

/// SOC 2 export — return every entry between `start` and `end` (UTC dates,
/// inclusive) sorted by timestamp. Designed for the SOC 2 audit-evidence
/// pull, where an auditor passes a date range and verifies the HMAC chain
/// offline. Both bounds inclusive; `start > end` returns an empty Vec.
pub fn export_window(
    memory_root: &Path,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<AuditEntry>, AppError> {
    if start > end {
        return Ok(Vec::new());
    }
    let mut day = start;
    let mut out = Vec::new();
    while day <= end {
        out.extend(read_day(memory_root, day)?);
        // Hard upper bound to avoid runaway loops on misconfigured chrono.
        match day.checked_add_signed(chrono::Duration::days(1)) {
            Some(next) => day = next,
            None => break,
        }
    }
    out.sort_by(|a, b| a.ts.cmp(&b.ts));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let id = uuid::Uuid::new_v4().simple().to_string();
            let p = std::env::temp_dir().join(format!("ti-audit-{}", id));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn input(action: &str) -> AuditEntryInput {
        AuditEntryInput {
            user: "daizhe".into(),
            action: action.into(),
            resource: "atom-1".into(),
            ip: Some("127.0.0.1".into()),
            user_agent: Some("test-agent/1.0".into()),
        }
    }

    #[test]
    fn append_writes_entry_and_stamps_default_region() {
        let root = TempDir::new();
        let entry = append(root.path(), input("template.install")).unwrap();
        assert_eq!(entry.region, "us-east");
        assert_eq!(entry.action, "template.install");
        assert_eq!(entry.user, "daizhe");
        assert!(!entry.chain.is_empty(), "chain hash must be populated");

        let today = Utc::now().date_naive();
        let day = read_day(root.path(), today).unwrap();
        assert_eq!(day.len(), 1);
        assert_eq!(day[0], entry);
    }

    #[test]
    fn append_is_append_only_across_calls() {
        let root = TempDir::new();
        let _ = append(root.path(), input("auth.login")).unwrap();
        let _ = append(root.path(), input("brain.write")).unwrap();
        let _ = append(root.path(), input("template.install")).unwrap();

        let today = Utc::now().date_naive();
        let entries = read_day(root.path(), today).unwrap();
        assert_eq!(entries.len(), 3);
        let actions: Vec<&str> = entries.iter().map(|e| e.action.as_str()).collect();
        assert_eq!(actions, vec!["auth.login", "brain.write", "template.install"]);
    }

    #[test]
    fn read_day_returns_empty_when_missing() {
        let root = TempDir::new();
        let day = NaiveDate::from_ymd_opt(2020, 1, 1).unwrap();
        let entries = read_day(root.path(), day).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn read_window_includes_today() {
        let root = TempDir::new();
        let _ = append(root.path(), input("auth.login")).unwrap();
        let entries = read_window(root.path(), 0).unwrap();
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn search_filters_by_action_substring() {
        let root = TempDir::new();
        let _ = append(root.path(), input("auth.login")).unwrap();
        let _ = append(root.path(), input("template.install")).unwrap();
        let _ = append(root.path(), input("brain.write")).unwrap();

        let hits = search(root.path(), "template", 0).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].action, "template.install");
    }

    #[test]
    fn search_with_empty_query_returns_all() {
        let root = TempDir::new();
        let _ = append(root.path(), input("a")).unwrap();
        let _ = append(root.path(), input("b")).unwrap();
        let hits = search(root.path(), "", 0).unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn search_is_case_insensitive() {
        let root = TempDir::new();
        let _ = append(root.path(), input("Auth.Login")).unwrap();
        let hits = search(root.path(), "AUTH", 0).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn malformed_lines_are_skipped() {
        let root = TempDir::new();
        let _ = append(root.path(), input("first")).unwrap();
        // Inject a malformed line directly.
        let today = Utc::now().date_naive();
        let path = day_file(root.path(), today).unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{{not valid json").unwrap();
        let _ = append(root.path(), input("second")).unwrap();

        let entries = read_day(root.path(), today).unwrap();
        assert_eq!(entries.len(), 2);
    }

    // -------------------------------------------------------------------
    // Region routing
    // -------------------------------------------------------------------

    #[test]
    fn read_region_default_when_file_missing() {
        let root = TempDir::new();
        assert_eq!(read_region(root.path()), "us-east");
    }

    #[test]
    fn read_region_returns_configured_value() {
        let root = TempDir::new();
        write_region(root.path(), "eu-west").unwrap();
        assert_eq!(read_region(root.path()), "eu-west");
    }

    #[test]
    fn read_region_falls_back_on_invalid_value() {
        let root = TempDir::new();
        // Bypass the validating writer to inject a junk value.
        let path = region_path(root.path()).unwrap();
        std::fs::write(&path, "mars").unwrap();
        assert_eq!(read_region(root.path()), "us-east");
    }

    #[test]
    fn write_region_rejects_unknown() {
        let root = TempDir::new();
        let err = write_region(root.path(), "nope").unwrap_err();
        match err {
            AppError::User { code, .. } => assert_eq!(code, "audit_bad_region"),
            other => panic!("expected User error, got {:?}", other),
        }
    }

    #[test]
    fn append_stamps_region_from_config() {
        let root = TempDir::new();
        write_region(root.path(), "china").unwrap();
        let entry = append(root.path(), input("auth.login")).unwrap();
        assert_eq!(entry.region, "china");
    }

    // -------------------------------------------------------------------
    // HMAC chain
    // -------------------------------------------------------------------

    #[test]
    fn chain_is_populated_and_distinct_per_entry() {
        let root = TempDir::new();
        let a = append(root.path(), input("a")).unwrap();
        let b = append(root.path(), input("b")).unwrap();
        assert!(!a.chain.is_empty());
        assert!(!b.chain.is_empty());
        assert_ne!(a.chain, b.chain);
        // Hex is 32 bytes -> 64 chars.
        assert_eq!(a.chain.len(), 64);
        assert_eq!(b.chain.len(), 64);
    }

    #[test]
    fn verify_chain_passes_for_unmodified_log() {
        let root = TempDir::new();
        let _ = append(root.path(), input("a")).unwrap();
        let _ = append(root.path(), input("b")).unwrap();
        let _ = append(root.path(), input("c")).unwrap();
        let today = Utc::now().date_naive();
        let entries = read_day(root.path(), today).unwrap();
        let bad = verify_chain(root.path(), &entries, "").unwrap();
        assert!(bad.is_none(), "intact chain should verify clean");
    }

    #[test]
    fn verify_chain_detects_tampered_action() {
        let root = TempDir::new();
        let _ = append(root.path(), input("a")).unwrap();
        let _ = append(root.path(), input("b")).unwrap();
        let today = Utc::now().date_naive();
        let mut entries = read_day(root.path(), today).unwrap();
        // Tamper with the second entry's action without touching its chain.
        entries[1].action = "tampered".into();
        let bad = verify_chain(root.path(), &entries, "").unwrap();
        assert_eq!(bad, Some(1));
    }

    #[test]
    fn verify_chain_detects_swapped_chain_value() {
        let root = TempDir::new();
        let _ = append(root.path(), input("a")).unwrap();
        let _ = append(root.path(), input("b")).unwrap();
        let today = Utc::now().date_naive();
        let mut entries = read_day(root.path(), today).unwrap();
        let real_chain = entries[1].chain.clone();
        // Replace the second entry's chain with a plausible-looking forgery.
        entries[1].chain = "0".repeat(real_chain.len());
        let bad = verify_chain(root.path(), &entries, "").unwrap();
        assert_eq!(bad, Some(1));
    }

    // -------------------------------------------------------------------
    // SOC 2 export
    // -------------------------------------------------------------------

    #[test]
    fn export_window_returns_today_entries() {
        let root = TempDir::new();
        let _ = append(root.path(), input("a")).unwrap();
        let _ = append(root.path(), input("b")).unwrap();
        let today = Utc::now().date_naive();
        let out = export_window(root.path(), today, today).unwrap();
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn export_window_with_inverted_range_returns_empty() {
        let root = TempDir::new();
        let _ = append(root.path(), input("a")).unwrap();
        let today = Utc::now().date_naive();
        let yesterday = today - chrono::Duration::days(1);
        let out = export_window(root.path(), today, yesterday).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn export_window_skips_missing_days() {
        let root = TempDir::new();
        let _ = append(root.path(), input("a")).unwrap();
        let today = Utc::now().date_naive();
        let week_ago = today - chrono::Duration::days(7);
        let out = export_window(root.path(), week_ago, today).unwrap();
        assert_eq!(out.len(), 1);
    }
}
