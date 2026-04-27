//! v2.5 — Supabase real-auth module (scaffold, stub-mode default).
//!
//! Per `V2_5_SPEC.md` §3 the v1.x stub auth (any 6-char password) survives
//! behind `TANGERINE_DEV_STUB_AUTH=1` for E2E fixtures, and the real path
//! goes through Supabase. This module is the Rust-side surface; the React
//! side already has a `lib/supabase.ts` Supabase client wrapper that flips
//! between modes based on `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`
//! env vars.
//!
//! The Rust side exists because:
//!   1. Session storage uses the OS keychain via the `keyring` crate (already
//!      a dep). The frontend can't reach that directly.
//!   2. OAuth flows redirect to a deep link (`tangerine://auth/callback`)
//!      that the Tauri main process handles. The React window only sees
//!      the resulting session, not the device-flow internals.
//!   3. Webhooks (Supabase → us, e.g. `email_change_confirm`) need a Rust
//!      endpoint per the daemon's existing tide handler.
//!
//! ## Modes
//!
//! ```text
//!     stub  ── any 6-char password ──▶  fake StubSession
//!     real  ── Supabase REST + JWT ──▶  Session(JWT, refresh_token)
//! ```
//!
//! `BillingMode::Stub` is the default; `real` engages once
//! `SUPABASE_URL` + `SUPABASE_ANON_KEY` env vars are present.
//!
//! ## Backward compat
//!
//! Existing v1.x stub-mode users (synthetic localStorage sessions) keep
//! working until they explicitly link a real account via
//! `auth_link_real_account()` (lands in v2.5.0-alpha.2 — out of scope here).
//! The migration policy is in V2_5_SPEC.md §3.6.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    /// Default. No real Supabase call. Any email + 6-char password creates
    /// a `StubSession` keyed off the email.
    Stub,
    /// Supabase REST + JWT. Refresh token sits in the OS keychain; access
    /// token is held in memory only (per spec §3.5).
    Real,
}

impl Default for AuthMode {
    fn default() -> Self {
        AuthMode::Stub
    }
}

#[derive(Debug, Clone, Default)]
pub struct AuthConfig {
    pub supabase_url: Option<String>,
    pub supabase_anon_key: Option<String>,
    pub mode: AuthMode,
}

impl AuthConfig {
    pub fn from_env() -> Self {
        let url = std::env::var("SUPABASE_URL").ok().filter(|s| !s.is_empty());
        let key = std::env::var("SUPABASE_ANON_KEY")
            .ok()
            .filter(|s| !s.is_empty());

        let mode = match (&url, &key) {
            (Some(_), Some(_)) => AuthMode::Real,
            _ => AuthMode::Stub,
        };

        Self {
            supabase_url: url,
            supabase_anon_key: key,
            mode,
        }
    }

    pub fn is_stub(&self) -> bool {
        self.mode == AuthMode::Stub
    }
}

/// OAuth provider. Wire-shape stable so frontend strings line up with
/// Supabase's `signInWithOAuth({ provider })` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OAuthProvider {
    Github,
    Google,
}

/// One row in the keychain-backed session store.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub user_id: String,
    pub email: String,
    pub email_confirmed_at: Option<String>,
    /// JWT access token. In real mode held only in memory; in stub mode
    /// we still expose a fake string so the IPC contract stays uniform.
    pub access_token: String,
    /// Stable opaque token. Real mode persists this in the OS keychain.
    pub refresh_token: String,
    /// UNIX seconds — when the access token expires. `0` for stub.
    pub expires_at: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("invalid email")]
    InvalidEmail,
    #[error("password too short (≥6 chars required)")]
    PasswordTooShort,
    #[error("real-mode call attempted in stub mode")]
    StubModeOnly,
    #[error("supabase keys missing")]
    KeyMissing,
    #[error("network: {0}")]
    Network(String),
    #[error("not signed in")]
    NotSignedIn,
    #[error("email not verified")]
    EmailNotVerified,
}

// --- Stub-mode in-process session store --------------------------------

use std::sync::Mutex;

static STUB_SESSION: once_cell::sync::Lazy<Mutex<Option<Session>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

fn validate_email(email: &str) -> Result<(), AuthError> {
    if !email.contains('@') || email.len() < 3 {
        return Err(AuthError::InvalidEmail);
    }
    Ok(())
}

fn validate_password(password: &str) -> Result<(), AuthError> {
    if password.len() < 6 {
        return Err(AuthError::PasswordTooShort);
    }
    Ok(())
}

fn fake_session(email: &str) -> Session {
    Session {
        user_id: format!("stub-user-{}", uuid::Uuid::new_v4()),
        email: email.to_string(),
        email_confirmed_at: Some("1970-01-01T00:00:00Z".to_string()),
        access_token: "stub_access_token".to_string(),
        refresh_token: "stub_refresh_token".to_string(),
        expires_at: 0,
    }
}

/// Email + password sign in. Stub returns a synthetic session.
pub async fn sign_in_email_password(
    cfg: &AuthConfig,
    email: &str,
    password: &str,
) -> Result<Session, AuthError> {
    validate_email(email)?;
    validate_password(password)?;
    if cfg.is_stub() {
        let s = fake_session(email);
        *STUB_SESSION.lock().unwrap() = Some(s.clone());
        return Ok(s);
    }
    if cfg.supabase_url.is_none() || cfg.supabase_anon_key.is_none() {
        return Err(AuthError::KeyMissing);
    }
    // Real-mode HTTP call lands in v2.5.0-alpha.1 (uses `reqwest` against
    // `<url>/auth/v1/token?grant_type=password`).
    Err(AuthError::StubModeOnly)
}

/// Email + password sign-up. Real mode triggers a Supabase confirm email
/// (Postmark provider per §3.3); stub fakes immediate confirmation.
pub async fn sign_up(
    cfg: &AuthConfig,
    email: &str,
    password: &str,
) -> Result<Session, AuthError> {
    validate_email(email)?;
    validate_password(password)?;
    if cfg.is_stub() {
        let s = fake_session(email);
        *STUB_SESSION.lock().unwrap() = Some(s.clone());
        return Ok(s);
    }
    if cfg.supabase_url.is_none() || cfg.supabase_anon_key.is_none() {
        return Err(AuthError::KeyMissing);
    }
    Err(AuthError::StubModeOnly)
}

/// OAuth sign-in. Real mode opens the provider's authorise URL via the
/// shell plugin (deep-link handler picks up the redirect). Stub stamps
/// a synthetic session.
pub async fn sign_in_oauth(
    cfg: &AuthConfig,
    provider: OAuthProvider,
) -> Result<Session, AuthError> {
    if cfg.is_stub() {
        let mut s = fake_session(&format!("{provider:?}-stub@tangerine.local"));
        s.access_token = format!("stub_oauth_{provider:?}_token");
        *STUB_SESSION.lock().unwrap() = Some(s.clone());
        return Ok(s);
    }
    if cfg.supabase_url.is_none() {
        return Err(AuthError::KeyMissing);
    }
    Err(AuthError::StubModeOnly)
}

/// Verify an email-confirm token. Real mode hits Supabase
/// `/auth/v1/verify`; stub flips a flag in the in-process session.
pub async fn verify_email(cfg: &AuthConfig, token: &str) -> Result<Session, AuthError> {
    if token.is_empty() {
        return Err(AuthError::InvalidEmail);
    }
    if cfg.is_stub() {
        let mut g = STUB_SESSION.lock().unwrap();
        let s = g.as_mut().ok_or(AuthError::NotSignedIn)?;
        s.email_confirmed_at = Some("1970-01-01T00:00:00Z".to_string());
        return Ok(s.clone());
    }
    Err(AuthError::StubModeOnly)
}

/// Sign out. Drops the in-memory session and clears the keychain entry
/// (real mode).
pub async fn sign_out(_cfg: &AuthConfig) -> Result<(), AuthError> {
    *STUB_SESSION.lock().unwrap() = None;
    Ok(())
}

/// Get the current session (or `None` if signed out / expired).
pub async fn get_session(_cfg: &AuthConfig) -> Result<Option<Session>, AuthError> {
    Ok(STUB_SESSION.lock().unwrap().clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stub_cfg() -> AuthConfig {
        AuthConfig {
            supabase_url: None,
            supabase_anon_key: None,
            mode: AuthMode::Stub,
        }
    }

    #[tokio::test]
    async fn auth_stub_mode_accepts_any_6_char_password() {
        let cfg = stub_cfg();
        let r = sign_in_email_password(&cfg, "a@b.co", "abcdef").await.unwrap();
        assert_eq!(r.email, "a@b.co");
        assert!(r.access_token.starts_with("stub_"));
    }

    #[tokio::test]
    async fn auth_stub_mode_rejects_short_password() {
        let cfg = stub_cfg();
        let r = sign_in_email_password(&cfg, "a@b.co", "abc").await;
        assert!(matches!(r, Err(AuthError::PasswordTooShort)));
    }

    #[tokio::test]
    async fn auth_stub_mode_rejects_bad_email() {
        let cfg = stub_cfg();
        let r = sign_in_email_password(&cfg, "no-at-sign", "abcdef").await;
        assert!(matches!(r, Err(AuthError::InvalidEmail)));
    }

    #[tokio::test]
    async fn auth_real_mode_requires_actual_supabase() {
        let cfg = AuthConfig {
            supabase_url: None,
            supabase_anon_key: None,
            mode: AuthMode::Real,
        };
        let r = sign_in_email_password(&cfg, "a@b.co", "abcdef").await;
        assert!(matches!(r, Err(AuthError::KeyMissing)));
    }

    #[tokio::test]
    async fn auth_signout_clears_session() {
        let cfg = stub_cfg();
        sign_in_email_password(&cfg, "a@b.co", "abcdef").await.unwrap();
        sign_out(&cfg).await.unwrap();
        let s = get_session(&cfg).await.unwrap();
        assert!(s.is_none());
    }

    #[tokio::test]
    async fn auth_oauth_stub_creates_session() {
        let cfg = stub_cfg();
        let s = sign_in_oauth(&cfg, OAuthProvider::Github).await.unwrap();
        assert!(s.email.contains("Github") || s.access_token.contains("Github"));
    }

    #[test]
    fn from_env_picks_real_when_keys_set() {
        std::env::set_var("SUPABASE_URL", "https://stub.supabase.co");
        std::env::set_var("SUPABASE_ANON_KEY", "stub_key");
        let c = AuthConfig::from_env();
        assert_eq!(c.mode, AuthMode::Real);
        std::env::remove_var("SUPABASE_URL");
        std::env::remove_var("SUPABASE_ANON_KEY");
    }

    #[test]
    fn from_env_falls_back_to_stub_without_keys() {
        std::env::remove_var("SUPABASE_URL");
        std::env::remove_var("SUPABASE_ANON_KEY");
        let c = AuthConfig::from_env();
        assert_eq!(c.mode, AuthMode::Stub);
    }
}
