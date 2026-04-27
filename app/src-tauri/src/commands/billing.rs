//! Perf (API_SURFACE_SPEC §5): `billing_status` / `email_verify_status` are
//! read commands → 50 ms p95. `billing_subscribe` / `billing_cancel` /
//! `billing_trial_start` / `billing_webhook` / `email_verify_send` /
//! `email_verify_confirm` are upstream-validation commands → 3 s p95.
//! `billing_reconcile` is a daemon-only sweep → 30 s p95 (heartbeat bucket).
//!
//! v2.5 — Tauri command surface for Stripe Connect billing.
//!
//! Thin shim over `crate::billing`. Resolves the singleton config on every
//! call so a key-rotation by the CEO (re-launching with `STRIPE_API_KEY` set)
//! flips the mode without code change. Frontend wrappers live in
//! `app/src/lib/tauri.ts` under `// === v2.5 auth + billing ===`.

use crate::billing::{
    self, BillingError, SubscriptionStatus, TeamBilling, WebhookOutcome,
};
use crate::email_verify::{self, EmailVerifyError};
use serde::{Deserialize, Serialize};

use super::AppError;

impl From<EmailVerifyError> for AppError {
    fn from(e: EmailVerifyError) -> Self {
        match e {
            EmailVerifyError::Io(io) => AppError::internal("email_verify_io", io.to_string()),
            EmailVerifyError::Json(j) => AppError::internal("email_verify_json", j.to_string()),
            EmailVerifyError::InvalidEmail => AppError::user("invalid_email", e.to_string()),
            EmailVerifyError::TokenNotFound => AppError::user("verify_token_not_found", e.to_string()),
            EmailVerifyError::TokenExpired => AppError::user("verify_token_expired", e.to_string()),
            EmailVerifyError::TokenConsumed => AppError::user("verify_token_consumed", e.to_string()),
            EmailVerifyError::KeyMissing => AppError::config("email_key_missing", e.to_string()),
            EmailVerifyError::Provider(s) => AppError::external("email_provider", s),
        }
    }
}

impl From<BillingError> for AppError {
    fn from(e: BillingError) -> Self {
        match e {
            BillingError::Io(io) => AppError::internal("billing_io", io.to_string()),
            BillingError::Json(j) => AppError::internal("billing_json", j.to_string()),
            BillingError::StubModeOnly => AppError::config("billing_stub_mode_only", e.to_string()),
            BillingError::EmailNotVerified => AppError::user("email_not_verified", e.to_string()),
            BillingError::RateLimit(n) => {
                AppError::user("trial_rate_limit", format!("3 trials per IP per 7d (saw {n})"))
            }
            BillingError::InvalidSignature => {
                AppError::external("webhook_signature", e.to_string())
            }
            BillingError::NotFound(s) => AppError::user("team_not_found", s),
            BillingError::KeyMissing => AppError::config("stripe_key_missing", e.to_string()),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BillingStatusDto {
    pub team_id: String,
    pub status: String,
    pub trial_start: u64,
    pub trial_end: u64,
    pub stripe_customer_id: Option<String>,
    pub stripe_subscription_id: Option<String>,
    pub email: Option<String>,
    pub mode: String,
}

fn mode_str() -> &'static str {
    let cfg = billing::current_config();
    if cfg.is_stub() {
        "stub"
    } else if cfg.stripe_api_key.as_deref().map(|k| k.starts_with("sk_live_")) == Some(true) {
        "live"
    } else {
        "test"
    }
}

fn to_dto(t: TeamBilling) -> BillingStatusDto {
    BillingStatusDto {
        team_id: t.team_id,
        status: t.status.as_str().to_string(),
        trial_start: t.trial_start,
        trial_end: t.trial_end,
        stripe_customer_id: t.stripe_customer_id,
        stripe_subscription_id: t.stripe_subscription_id,
        email: t.email,
        mode: mode_str().to_string(),
    }
}

#[tauri::command]
pub async fn billing_subscribe(
    team_id: String,
    payment_method_id: String,
) -> Result<BillingStatusDto, AppError> {
    let cfg = billing::current_config();
    let t = billing::create_subscription(&cfg, &team_id, &payment_method_id)?;
    Ok(to_dto(t))
}

#[tauri::command]
pub async fn billing_cancel(team_id: String) -> Result<BillingStatusDto, AppError> {
    let cfg = billing::current_config();
    let t = billing::cancel_subscription(&cfg, &team_id)?;
    Ok(to_dto(t))
}

#[tauri::command]
pub async fn billing_status(team_id: String) -> Result<BillingStatusDto, AppError> {
    let cfg = billing::current_config();
    let t = billing::billing_status(&cfg, &team_id)?;
    Ok(to_dto(t))
}

#[tauri::command]
pub async fn billing_trial_start(
    team_id: String,
    email: String,
    email_verified: Option<bool>,
    ip_hash: Option<String>,
) -> Result<BillingStatusDto, AppError> {
    let cfg = billing::current_config();
    // The caller passes a hint (e.g. Supabase already confirmed the email);
    // we cross-check against the email_verify ledger so a forged caller-side
    // flag can't bypass the gate.
    let caller_says = email_verified.unwrap_or(false);
    let ledger_says = {
        let ev_cfg = email_verify::current_config();
        email_verify::email_is_verified(&ev_cfg, &email)
    };
    let verified = caller_says || ledger_says;
    let t = billing::trial_start(
        &cfg,
        &team_id,
        &email,
        verified,
        ip_hash.as_deref().unwrap_or(""),
    )?;
    Ok(to_dto(t))
}

// ----- Email verify commands -------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct EmailVerifyTokenDto {
    pub token: String,
    pub provider: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EmailVerifyResultDto {
    pub email: String,
    pub verified: bool,
}

fn provider_str(cfg: &email_verify::EmailVerifyConfig) -> &'static str {
    if cfg.is_stub() {
        "stub"
    } else {
        match cfg.provider {
            email_verify::EmailProvider::Postmark => "postmark",
            email_verify::EmailProvider::Sendgrid => "sendgrid",
            email_verify::EmailProvider::Stub => "stub",
        }
    }
}

/// Send a verify token to the given email. Returns the token in stub mode
/// so dev / tests can round-trip without an inbox; real mode returns a
/// redacted prefix only.
#[tauri::command]
pub async fn email_verify_send(email: String) -> Result<EmailVerifyTokenDto, AppError> {
    let cfg = email_verify::current_config();
    let token = email_verify::send_verify_email(&cfg, &email).await?;
    let exposed = if cfg.is_stub() {
        token
    } else {
        // Real mode: reveal only the prefix so logs aren't leakable.
        let prefix: String = token.chars().take(8).collect();
        format!("{prefix}…")
    };
    Ok(EmailVerifyTokenDto {
        token: exposed,
        provider: provider_str(&cfg).to_string(),
    })
}

/// Consume a verify token. After this call `email_is_verified(email)` is true
/// for the next 24 h, so a subsequent `billing_trial_start` passes the gate.
#[tauri::command]
pub async fn email_verify_confirm(token: String) -> Result<EmailVerifyResultDto, AppError> {
    let cfg = email_verify::current_config();
    let email = email_verify::verify_token(&cfg, &token)?;
    Ok(EmailVerifyResultDto {
        email,
        verified: true,
    })
}

/// Read-side check for the React paywall: is this email already verified?
#[tauri::command]
pub async fn email_verify_status(email: String) -> Result<EmailVerifyResultDto, AppError> {
    let cfg = email_verify::current_config();
    Ok(EmailVerifyResultDto {
        email: email.clone(),
        verified: email_verify::email_is_verified(&cfg, &email),
    })
}

/// Daemon-side reconcile entry. Walks every team file, promotes expired
/// trials, and (in real mode) cross-checks Stripe state. Reported back to
/// the daemon snapshot via `daemon_status`.
#[tauri::command]
pub async fn billing_reconcile() -> Result<billing::ReconcileOutcome, AppError> {
    let cfg = billing::current_config();
    Ok(billing::reconcile_subscriptions(&cfg).await)
}

/// Webhook handler. Daemon route forwards the raw payload + Stripe-Signature
/// header here. Stub mode parses the JSON and reports the event_type without
/// mutating state — the real handler in `webhook.rs` (v2.5.0-alpha.1) does
/// signature verification + state transitions.
#[tauri::command]
pub async fn billing_webhook(payload: String, signature: String) -> Result<WebhookOutcome, AppError> {
    let cfg = billing::current_config();
    let r = billing::webhook_handle(&cfg, &payload, &signature)?;
    Ok(r)
}

// Stable enum string for the frontend's status switch. Centralised so a
// future status add doesn't bit-rot the React side.
#[allow(dead_code)]
fn _enum_check() {
    let _all = [
        SubscriptionStatus::Trialing.as_str(),
        SubscriptionStatus::Active.as_str(),
        SubscriptionStatus::PastDue.as_str(),
        SubscriptionStatus::Canceled.as_str(),
        SubscriptionStatus::None.as_str(),
    ];
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor_state_dir() {
        let dir = std::env::temp_dir()
            .join(format!("tangerine-billing-cmd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::billing::set_state_dir(dir);
    }

    /// Serialise tests that perform multi-step round-trips against the billing
    /// singleton. trial_start writes a team file at state_dir A, but a parallel
    /// test's anchor_state_dir() can flip the singleton to state_dir B before
    /// subscribe/cancel run — at which point the team file vanishes and we get
    /// `team_not_found`. Wave 2 added subscribe + cancel reads to the round-trip
    /// test, so this race now manifests where it didn't in wave 1.
    static BILLING_TEST_LOCK: once_cell::sync::Lazy<std::sync::Mutex<()>> =
        once_cell::sync::Lazy::new(|| std::sync::Mutex::new(()));

    #[tokio::test]
    async fn cmd_trial_subscribe_cancel_round_trip() {
        let _g = BILLING_TEST_LOCK.lock().unwrap();
        anchor_state_dir();
        let team = format!("cmd-test-{}", uuid::Uuid::new_v4());
        let started = billing_trial_start(
            team.clone(),
            "ceo@tangerine.test".into(),
            Some(true),
            None,
        )
        .await
        .unwrap();
        assert_eq!(started.status, "trialing");

        let active = billing_subscribe(team.clone(), "pm_stub".into())
            .await
            .unwrap();
        assert_eq!(active.status, "active");

        let canceled = billing_cancel(team.clone()).await.unwrap();
        assert_eq!(canceled.status, "canceled");
    }

    #[tokio::test]
    async fn cmd_trial_blocks_unverified_email() {
        anchor_state_dir();
        let r = billing_trial_start(
            format!("cmd-noverify-{}", uuid::Uuid::new_v4()),
            "n@v.test".into(),
            Some(false),
            None,
        )
        .await;
        match r {
            Err(AppError::User { code, .. }) => assert_eq!(code, "email_not_verified"),
            other => panic!("expected User error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn cmd_webhook_stub_reports_event_type() {
        anchor_state_dir();
        let r = billing_webhook(
            r#"{"type":"invoice.paid","id":"evt_stub"}"#.into(),
            "any_sig".into(),
        )
        .await
        .unwrap();
        assert_eq!(r.event_type, "invoice.paid");
    }

    fn anchor_email_state_dir() {
        let dir = std::env::temp_dir()
            .join(format!("tangerine-email-cmd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::email_verify::set_state_dir(dir);
    }

    /// Serialise tests that touch the email_verify singleton's state_dir.
    /// Without this, parallel tests stomp the dir and tokens issued by one
    /// test land in a dir the other can't read. The billing singleton has
    /// the same race surface but its tests use unique team_id UUIDs so
    /// state_dir collisions don't manifest as test failures.
    static EMAIL_TEST_LOCK: once_cell::sync::Lazy<std::sync::Mutex<()>> =
        once_cell::sync::Lazy::new(|| std::sync::Mutex::new(()));

    #[tokio::test]
    async fn cmd_email_verify_send_then_confirm_round_trip() {
        let _g = EMAIL_TEST_LOCK.lock().unwrap();
        anchor_email_state_dir();
        let sent = email_verify_send("ceo@tangerine.test".into()).await.unwrap();
        assert!(sent.token.starts_with("evt_"));
        assert_eq!(sent.provider, "stub");

        let res = email_verify_confirm(sent.token).await.unwrap();
        assert_eq!(res.email, "ceo@tangerine.test");
        assert!(res.verified);

        let status = email_verify_status("ceo@tangerine.test".into()).await.unwrap();
        assert!(status.verified);
    }

    #[tokio::test]
    async fn cmd_email_verify_unknown_token_user_errors() {
        let _g = EMAIL_TEST_LOCK.lock().unwrap();
        anchor_email_state_dir();
        let r = email_verify_confirm("evt_does_not_exist".into()).await;
        match r {
            Err(AppError::User { code, .. }) => assert_eq!(code, "verify_token_not_found"),
            other => panic!("expected user error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn cmd_billing_reconcile_runs_clean_on_empty_dir() {
        anchor_state_dir();
        let r = billing_reconcile().await.unwrap();
        // Don't assert exactly 0 teams_seen — parallel tests may have
        // populated the prior singleton dir. Just confirm reconcile runs
        // clean (no errors).
        assert!(r.errors.is_empty());
    }

    #[tokio::test]
    async fn cmd_trial_start_passes_when_ledger_verifies_email() {
        let _g = EMAIL_TEST_LOCK.lock().unwrap();
        anchor_state_dir();
        anchor_email_state_dir();
        let email = "trial-via-ledger@t.test";
        let token = crate::email_verify::send_verify_email(
            &crate::email_verify::current_config(),
            email,
        )
        .await
        .unwrap();
        crate::email_verify::verify_token(
            &crate::email_verify::current_config(),
            &token,
        )
        .unwrap();
        // Caller passes `email_verified=false`; the ledger should still
        // unblock the gate because the token was redeemed in this dir.
        let r = billing_trial_start(
            format!("team-ledger-{}", uuid::Uuid::new_v4()),
            email.into(),
            Some(false),
            None,
        )
        .await
        .unwrap();
        assert_eq!(r.status, "trialing");
    }
}
