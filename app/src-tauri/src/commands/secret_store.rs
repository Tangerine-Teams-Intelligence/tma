// === wave 1.13-E ===
//! v1.13 Agent E — OS-keychain backed secret store for source OAuth tokens.
//!
//! Distinct from `commands::env` (Wave 4 `.env` file for app-level secrets
//! like `DISCORD_BOT_TOKEN`) and from `commands::sync::TokenStore` (the
//! GitHub-specific OAuth token store). v1.13 introduces a generic
//! source-token store keyed under
//! `tangerine.source.<source_id>.<account>` so each new connector
//! (Lark / Zoom / Teams / Slack-real / GitHub-real) can stash its access +
//! refresh + expiry triplet without growing the `.env` allow-list further.
//!
//! Crate
//! =====
//! `keyring` 2.x — already in the dep tree (the GitHub TokenStore uses it).
//! Cross-platform: Windows Credential Manager, macOS Keychain, Linux Secret
//! Service.
//!
//! Namespace
//! =========
//!   service: `tangerine.source.<source_id>`
//!   account: `<account_alias>`  (free-form, user-picked)
//!
//! On a fresh install with no keychain available (rare — typically WSL
//! without `gnome-keyring` running) we fall through to a per-user JSON file
//! at `<user_data>/sources/<source_id>.<account>.json` with mode 0600 (POSIX
//! only). Same fall-through model as `commands::sync::TokenStore`.
//!
//! The Tauri command surface here is intentionally narrow: a single
//! `secret_store_set_oauth` setter and a `secret_store_get_oauth` reader. The
//! frontend never echoes a token after the initial set; the Privacy panel
//! shows the per-source presence (a green dot when something is on disk for
//! `<source_id>.<account>`) without revealing the value.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::AppError;

/// One OAuth credential set scoped to a `<source, account>` pair. Refresh
/// token + expiry are optional so PAT-style tokens (GitHub) and OAuth-style
/// tokens (Zoom / Teams) reuse the same shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceOAuthSecret {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Unix epoch seconds. None for non-expiring PATs.
    #[serde(default)]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SecretStoreSetOauthArgs {
    /// `lark` | `zoom` | `teams` | `slack` | `github` (or any future source id).
    pub source: String,
    /// User-picked account alias. Empty falls back to `default`.
    #[serde(default)]
    pub account: String,
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SecretStoreGetOauthArgs {
    pub source: String,
    #[serde(default)]
    pub account: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SecretStorePresence {
    /// True when something is on disk / in the keychain for this source.
    /// Tokens are never returned to the frontend — the Privacy panel renders
    /// presence-only.
    pub present: bool,
    pub expires_at: Option<i64>,
}

const ALLOWED_SOURCES: &[&str] = &[
    "lark",
    "zoom",
    "teams",
    "slack",
    "github",
    "discord",
];

fn validate_source(source: &str) -> Result<(), AppError> {
    if !ALLOWED_SOURCES.contains(&source) {
        return Err(AppError::user(
            "source_not_allowed",
            format!("source '{}' not in keychain allow-list", source),
        ));
    }
    Ok(())
}

fn keyring_service(source: &str) -> String {
    format!("tangerine.source.{source}")
}

fn keyring_account(account: &str) -> String {
    if account.is_empty() {
        "default".to_string()
    } else {
        account.to_string()
    }
}

#[tauri::command]
pub async fn secret_store_set_oauth(args: SecretStoreSetOauthArgs) -> Result<(), AppError> {
    validate_source(&args.source)?;
    let secret = SourceOAuthSecret {
        access_token: args.access_token,
        refresh_token: args.refresh_token,
        expires_at: args.expires_at,
    };
    let payload = serde_json::to_string(&secret)
        .map_err(|e| AppError::internal("serialize_secret", e.to_string()))?;
    let svc = keyring_service(&args.source);
    let acct = keyring_account(&args.account);
    match keyring::Entry::new(&svc, &acct) {
        Ok(e) => match e.set_password(&payload) {
            Ok(()) => return Ok(()),
            Err(err) => {
                tracing::warn!(error = %err, source = %args.source, "keychain set failed; falling back to file");
            }
        },
        Err(err) => {
            tracing::warn!(error = %err, source = %args.source, "keychain entry init failed; falling back to file");
        }
    }
    file_set(&args.source, &acct, &payload)
}

#[tauri::command]
pub async fn secret_store_get_oauth(
    args: SecretStoreGetOauthArgs,
) -> Result<SecretStorePresence, AppError> {
    validate_source(&args.source)?;
    let svc = keyring_service(&args.source);
    let acct = keyring_account(&args.account);
    if let Ok(e) = keyring::Entry::new(&svc, &acct) {
        if let Ok(payload) = e.get_password() {
            if let Ok(s) = serde_json::from_str::<SourceOAuthSecret>(&payload) {
                return Ok(SecretStorePresence {
                    present: !s.access_token.is_empty(),
                    expires_at: s.expires_at,
                });
            }
        }
    }
    if let Ok(payload) = file_get(&args.source, &acct) {
        if let Ok(s) = serde_json::from_str::<SourceOAuthSecret>(&payload) {
            return Ok(SecretStorePresence {
                present: !s.access_token.is_empty(),
                expires_at: s.expires_at,
            });
        }
    }
    Ok(SecretStorePresence {
        present: false,
        expires_at: None,
    })
}

#[tauri::command]
pub async fn secret_store_delete_oauth(args: SecretStoreGetOauthArgs) -> Result<(), AppError> {
    validate_source(&args.source)?;
    let svc = keyring_service(&args.source);
    let acct = keyring_account(&args.account);
    if let Ok(e) = keyring::Entry::new(&svc, &acct) {
        let _ = e.delete_password();
    }
    let _ = file_delete(&args.source, &acct);
    Ok(())
}

// ---------------------------------------------------------------------------
// File fallback — used when the keychain isn't reachable. Mirrors the
// `commands::sync::TokenStore::file_*` helpers but namespaced under
// `<user_data>/sources-secrets/`.
// ---------------------------------------------------------------------------

fn file_root() -> Result<PathBuf, AppError> {
    #[cfg(windows)]
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")));
    #[cfg(not(windows))]
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("TangerineMeeting").join("sources-secrets");
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal("sources_secrets_mkdir", e.to_string()))?;
    Ok(dir)
}

fn sanitize_part(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn file_path(source: &str, account: &str) -> Result<PathBuf, AppError> {
    let dir = file_root()?;
    Ok(dir.join(format!(
        "{}.{}.json",
        sanitize_part(source),
        sanitize_part(account)
    )))
}

fn file_set(source: &str, account: &str, payload: &str) -> Result<(), AppError> {
    let path = file_path(source, account)?;
    std::fs::write(&path, payload)
        .map_err(|e| AppError::internal("source_secret_write", e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path)
            .map_err(|e| AppError::internal("source_secret_meta", e.to_string()))?
            .permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms)
            .map_err(|e| AppError::internal("source_secret_perm", e.to_string()))?;
    }
    Ok(())
}

fn file_get(source: &str, account: &str) -> Result<String, AppError> {
    let path = file_path(source, account)?;
    std::fs::read_to_string(&path)
        .map_err(|e| AppError::user("secret_missing", format!("no stored secret: {e}")))
}

fn file_delete(source: &str, account: &str) -> Result<(), AppError> {
    let path = file_path(source, account)?;
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| AppError::internal("source_secret_remove", e.to_string()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_source() {
        assert!(validate_source("notion-pro-max").is_err());
    }

    #[test]
    fn accepts_known_sources() {
        for s in ALLOWED_SOURCES {
            validate_source(s).unwrap();
        }
    }

    #[test]
    fn keyring_namespace_format_is_stable() {
        assert_eq!(keyring_service("lark"), "tangerine.source.lark");
        assert_eq!(keyring_account(""), "default");
        assert_eq!(keyring_account("daizhe"), "daizhe");
    }

    #[test]
    fn file_roundtrip_with_special_account_chars() {
        // Use a unique account to avoid clobbering other test runs.
        let acct = format!("test-{}", uuid::Uuid::new_v4().simple());
        let payload = serde_json::to_string(&SourceOAuthSecret {
            access_token: "secret_value".to_string(),
            refresh_token: Some("rt".to_string()),
            expires_at: Some(1714123456),
        })
        .unwrap();
        file_set("lark", &acct, &payload).expect("file_set");
        let got = file_get("lark", &acct).expect("file_get");
        assert!(got.contains("secret_value"));
        file_delete("lark", &acct).expect("delete");
        assert!(file_get("lark", &acct).is_err());
    }

    #[tokio::test]
    async fn secret_store_set_get_present_roundtrip() {
        // Use a per-run account so we don't pollute the developer's actual
        // keychain entries. Best-effort assertions — keychain may not be
        // available in CI; the file fallback covers us either way.
        let account = format!("test-{}", uuid::Uuid::new_v4().simple());
        let set_args = SecretStoreSetOauthArgs {
            source: "lark".to_string(),
            account: account.clone(),
            access_token: "tok-value".to_string(),
            refresh_token: None,
            expires_at: Some(1714999999),
        };
        secret_store_set_oauth(set_args).await.expect("set");
        let get_args = SecretStoreGetOauthArgs {
            source: "lark".to_string(),
            account: account.clone(),
        };
        let presence = secret_store_get_oauth(get_args.clone()).await.expect("get");
        assert!(presence.present, "expected present after set");
        // Cleanup.
        secret_store_delete_oauth(get_args).await.expect("delete");
    }

    #[tokio::test]
    async fn unknown_source_in_setter_errors() {
        let r = secret_store_set_oauth(SecretStoreSetOauthArgs {
            source: "unauthorized".to_string(),
            account: "x".to_string(),
            access_token: "x".to_string(),
            refresh_token: None,
            expires_at: None,
        })
        .await;
        assert!(r.is_err());
    }
}
// === end wave 1.13-E ===
