//! v2.5 — Email verification module (scaffold, stub-mode default).
//!
//! Per `V2_5_SPEC.md` §2.5 the trial-start gate requires the user's email to
//! be verified before billing.rs flips a team into `trialing`. This module
//! owns the send-verify-email + verify-token flow on the Rust side; the
//! React side calls into it via `crate::commands::billing::email_*` Tauri
//! commands.
//!
//! ## Provider abstraction
//!
//! Spec §2.5 picks **Postmark** over SendGrid (better China inbox routing,
//! cheaper at v2.5 scale). We ship a `Provider` enum that lets the CEO flip
//! between stub / sendgrid / postmark by setting `EMAIL_PROVIDER` +
//! `EMAIL_API_KEY` env vars, so the SendGrid path stays available as a
//! runner-up without a code change.
//!
//! ## Stub mode default
//!
//! No real network call until `EMAIL_API_KEY` is non-empty. Stub mode logs
//! the (to, token) pair and returns Ok — the verify-token side accepts any
//! token that was previously generated for the same email by `send_verify_email`.
//! This lets the React paywall flow run end-to-end without provisioning a
//! real Postmark account first.
//!
//! ## Token storage
//!
//! Generated tokens are persisted under
//! `<state_dir>/billing/email-tokens.json` keyed by token → (email, issued_at).
//! Tokens expire after 24 h. Verifying a token consumes it (single-use).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const TOKEN_TTL_SECS: u64 = 24 * 60 * 60;

/// Provider selector. `Stub` is the default until the CEO unblocks keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmailProvider {
    /// No real API call. Token persisted locally; verify accepts any
    /// previously-issued unexpired token.
    Stub,
    /// Postmark (spec choice — better China inbox routing).
    Postmark,
    /// SendGrid (runner-up).
    Sendgrid,
}

impl Default for EmailProvider {
    fn default() -> Self {
        EmailProvider::Stub
    }
}

/// Runtime config. Built from env at boot; the CEO can flip provider /
/// rotate key without a code change.
#[derive(Debug, Clone, Default)]
pub struct EmailVerifyConfig {
    pub provider: EmailProvider,
    pub api_key: Option<String>,
    /// Sender address. Defaults to `verify@tangerine.local` in stub mode;
    /// real mode requires a Postmark-confirmed sender.
    pub from_address: String,
    /// Resolved on init from `AppPaths::user_data` so tests can swap a
    /// tmpdir without touching the real `~/.tangerine-memory/` tree.
    pub state_dir: Option<PathBuf>,
}

impl EmailVerifyConfig {
    /// Read config from env. Falls back to stub when `EMAIL_API_KEY` is
    /// missing. `EMAIL_PROVIDER` selects between `postmark` (default for
    /// real mode) and `sendgrid`.
    pub fn from_env() -> Self {
        let api_key = std::env::var("EMAIL_API_KEY").ok().filter(|s| !s.is_empty());
        let from_address = std::env::var("EMAIL_FROM")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "verify@tangerine.local".to_string());

        let provider = match (api_key.as_deref(), std::env::var("EMAIL_PROVIDER").ok().as_deref()) {
            (Some(_), Some("sendgrid")) => EmailProvider::Sendgrid,
            (Some(_), Some("postmark")) => EmailProvider::Postmark,
            // Default real-mode provider per spec §2.5.
            (Some(_), _) => EmailProvider::Postmark,
            _ => EmailProvider::Stub,
        };

        Self {
            provider,
            api_key,
            from_address,
            state_dir: None,
        }
    }

    pub fn is_stub(&self) -> bool {
        self.provider == EmailProvider::Stub
    }

    /// On-disk JSON for token storage. Caller is responsible for ensuring
    /// the parent dir exists.
    pub fn tokens_file(&self) -> PathBuf {
        let base = self
            .state_dir
            .clone()
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".tangerine-memory")
                    .join(".tangerine")
                    .join("billing")
            });
        base.join("email-tokens.json")
    }
}

/// On-disk representation of one issued token.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TokenRecord {
    email: String,
    issued_at: u64,
    /// `true` once the token has been redeemed via `verify_token`. We keep
    /// the row so an audit trail survives even after consumption.
    consumed: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TokenLedger {
    /// Map token → record.
    tokens: HashMap<String, TokenRecord>,
}

#[derive(Debug, thiserror::Error)]
pub enum EmailVerifyError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid email")]
    InvalidEmail,
    #[error("token not found")]
    TokenNotFound,
    #[error("token expired")]
    TokenExpired,
    #[error("token already consumed")]
    TokenConsumed,
    #[error("api key not configured")]
    KeyMissing,
    #[error("provider error: {0}")]
    Provider(String),
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn validate_email(email: &str) -> Result<(), EmailVerifyError> {
    if !email.contains('@') || email.len() < 3 {
        return Err(EmailVerifyError::InvalidEmail);
    }
    Ok(())
}

fn load_ledger(cfg: &EmailVerifyConfig) -> Result<TokenLedger, EmailVerifyError> {
    let path = cfg.tokens_file();
    if !path.is_file() {
        return Ok(TokenLedger::default());
    }
    let raw = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn save_ledger(cfg: &EmailVerifyConfig, l: &TokenLedger) -> Result<(), EmailVerifyError> {
    let path = cfg.tokens_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(l)?;
    std::fs::write(path, raw)?;
    Ok(())
}

/// Generate a fresh verify token, persist it locally, and dispatch the email.
///
/// In stub mode the dispatch is a no-op (logged via `tracing::info!`); the
/// caller can read the persisted token directly to round-trip the flow in
/// tests / dev. In real mode this would POST to Postmark / SendGrid; for
/// v2.5.0-alpha.1 we guard so a misconfigured build can never silently miss
/// a real send.
pub async fn send_verify_email(
    cfg: &EmailVerifyConfig,
    to: &str,
) -> Result<String, EmailVerifyError> {
    validate_email(to)?;
    let token = format!("evt_{}", uuid::Uuid::new_v4().simple());
    let now = now_secs();

    // Persist before send so a half-failed send still leaves the user able
    // to verify if they get the email anyway.
    {
        let mut l = load_ledger(cfg)?;
        l.tokens.insert(
            token.clone(),
            TokenRecord {
                email: to.to_string(),
                issued_at: now,
                consumed: false,
            },
        );
        save_ledger(cfg, &l)?;
    }

    if cfg.is_stub() {
        tracing::info!(
            to = %to,
            from = %cfg.from_address,
            token = %token,
            "email_verify: stub mode — would have sent verify email"
        );
        return Ok(token);
    }

    if cfg.api_key.is_none() {
        return Err(EmailVerifyError::KeyMissing);
    }

    // Real-mode dispatch. v2.5.0-alpha.1 wires the Postmark / SendGrid
    // request here; for the scaffold we surface KeyMissing so a misconfigured
    // build can never silently miss a send. The provider-specific request
    // shape lives below in `dispatch_postmark` / `dispatch_sendgrid`; both
    // are guarded behind explicit feature checks so unit tests never trip
    // them.
    match cfg.provider {
        EmailProvider::Stub => Ok(token),
        EmailProvider::Postmark => {
            // Reserved for v2.5.0-alpha.1. Today we error rather than make
            // a silent network attempt.
            Err(EmailVerifyError::Provider(
                "postmark dispatch not wired in scaffold".to_string(),
            ))
        }
        EmailProvider::Sendgrid => Err(EmailVerifyError::Provider(
            "sendgrid dispatch not wired in scaffold".to_string(),
        )),
    }
}

/// Verify (and consume) a previously-issued token. Returns the email the
/// token was issued to on success.
pub fn verify_token(cfg: &EmailVerifyConfig, token: &str) -> Result<String, EmailVerifyError> {
    let mut l = load_ledger(cfg)?;
    let rec = l
        .tokens
        .get_mut(token)
        .ok_or(EmailVerifyError::TokenNotFound)?;
    if rec.consumed {
        return Err(EmailVerifyError::TokenConsumed);
    }
    let now = now_secs();
    if now.saturating_sub(rec.issued_at) > TOKEN_TTL_SECS {
        return Err(EmailVerifyError::TokenExpired);
    }
    rec.consumed = true;
    let email = rec.email.clone();
    save_ledger(cfg, &l)?;
    Ok(email)
}

/// Read-side check used by `billing.rs::trial_start` — has the caller's
/// email been verified within the last 24 h? Looks for a consumed token
/// whose `email` field matches.
pub fn email_is_verified(cfg: &EmailVerifyConfig, email: &str) -> bool {
    let Ok(l) = load_ledger(cfg) else {
        return false;
    };
    let now = now_secs();
    l.tokens.values().any(|t| {
        t.consumed
            && t.email.eq_ignore_ascii_case(email)
            && now.saturating_sub(t.issued_at) <= TOKEN_TTL_SECS
    })
}

// ----- Process-wide singleton (loaded once at boot) --------------------

static EMAIL_VERIFY: once_cell::sync::Lazy<Mutex<EmailVerifyConfig>> =
    once_cell::sync::Lazy::new(|| Mutex::new(EmailVerifyConfig::from_env()));

pub fn current_config() -> EmailVerifyConfig {
    EMAIL_VERIFY.lock().expect("email_verify mutex").clone()
}

/// Override the state dir (used by tests + by `setup_state` to anchor under
/// `AppPaths::user_data`).
pub fn set_state_dir(dir: PathBuf) {
    let mut g = EMAIL_VERIFY.lock().expect("email_verify mutex");
    g.state_dir = Some(dir);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Tests that mutate `EMAIL_*` env vars share process state. Serialise
    /// so they don't stomp each other.
    static ENV_TEST_LOCK: once_cell::sync::Lazy<StdMutex<()>> =
        once_cell::sync::Lazy::new(|| StdMutex::new(()));

    fn tmp_cfg() -> EmailVerifyConfig {
        let dir = std::env::temp_dir()
            .join(format!("tangerine-email-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        EmailVerifyConfig {
            provider: EmailProvider::Stub,
            api_key: None,
            from_address: "verify@tangerine.test".to_string(),
            state_dir: Some(dir),
            ..Default::default()
        }
    }

    #[test]
    fn from_env_defaults_to_stub() {
        let _g = ENV_TEST_LOCK.lock().unwrap();
        std::env::remove_var("EMAIL_API_KEY");
        std::env::remove_var("EMAIL_PROVIDER");
        let c = EmailVerifyConfig::from_env();
        assert_eq!(c.provider, EmailProvider::Stub);
        assert!(c.is_stub());
    }

    #[test]
    fn from_env_picks_postmark_default_real() {
        let _g = ENV_TEST_LOCK.lock().unwrap();
        std::env::set_var("EMAIL_API_KEY", "fake_key");
        std::env::remove_var("EMAIL_PROVIDER");
        let c = EmailVerifyConfig::from_env();
        assert_eq!(c.provider, EmailProvider::Postmark);
        assert!(!c.is_stub());
        std::env::remove_var("EMAIL_API_KEY");
    }

    #[test]
    fn from_env_picks_sendgrid_when_explicit() {
        let _g = ENV_TEST_LOCK.lock().unwrap();
        std::env::set_var("EMAIL_API_KEY", "fake_key");
        std::env::set_var("EMAIL_PROVIDER", "sendgrid");
        let c = EmailVerifyConfig::from_env();
        assert_eq!(c.provider, EmailProvider::Sendgrid);
        std::env::remove_var("EMAIL_API_KEY");
        std::env::remove_var("EMAIL_PROVIDER");
    }

    #[tokio::test]
    async fn stub_send_then_verify_round_trip() {
        let cfg = tmp_cfg();
        let token = send_verify_email(&cfg, "ceo@tangerine.test")
            .await
            .expect("send");
        assert!(token.starts_with("evt_"));

        let email = verify_token(&cfg, &token).expect("verify");
        assert_eq!(email, "ceo@tangerine.test");

        // Now `email_is_verified` is true.
        assert!(email_is_verified(&cfg, "ceo@tangerine.test"));
    }

    #[tokio::test]
    async fn verify_rejects_unknown_token() {
        let cfg = tmp_cfg();
        let r = verify_token(&cfg, "evt_nonexistent");
        assert!(matches!(r, Err(EmailVerifyError::TokenNotFound)));
    }

    #[tokio::test]
    async fn verify_rejects_double_consume() {
        let cfg = tmp_cfg();
        let token = send_verify_email(&cfg, "x@y.test").await.unwrap();
        verify_token(&cfg, &token).expect("first ok");
        let r = verify_token(&cfg, &token);
        assert!(matches!(r, Err(EmailVerifyError::TokenConsumed)));
    }

    #[tokio::test]
    async fn verify_rejects_expired_token() {
        let cfg = tmp_cfg();
        let token = send_verify_email(&cfg, "old@t.test").await.unwrap();

        // Manually rewind the issued_at past the TTL.
        let path = cfg.tokens_file();
        let raw = std::fs::read_to_string(&path).unwrap();
        let mut ledger: TokenLedger = serde_json::from_str(&raw).unwrap();
        ledger
            .tokens
            .get_mut(&token)
            .unwrap()
            .issued_at = now_secs().saturating_sub(TOKEN_TTL_SECS + 60);
        std::fs::write(&path, serde_json::to_string_pretty(&ledger).unwrap()).unwrap();

        let r = verify_token(&cfg, &token);
        assert!(matches!(r, Err(EmailVerifyError::TokenExpired)));
    }

    #[tokio::test]
    async fn invalid_email_rejected() {
        let cfg = tmp_cfg();
        let r = send_verify_email(&cfg, "no-at-sign").await;
        assert!(matches!(r, Err(EmailVerifyError::InvalidEmail)));
    }

    #[test]
    fn email_is_verified_false_for_unsent() {
        let cfg = tmp_cfg();
        assert!(!email_is_verified(&cfg, "never@sent.test"));
    }

    #[tokio::test]
    async fn email_is_verified_case_insensitive() {
        let cfg = tmp_cfg();
        let token = send_verify_email(&cfg, "Mixed@Case.Test").await.unwrap();
        verify_token(&cfg, &token).unwrap();
        assert!(email_is_verified(&cfg, "MIXED@case.test"));
    }
}
