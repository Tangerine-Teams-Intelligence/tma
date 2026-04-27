//! v2.5 — Tauri command surface for Stripe Connect billing.
//!
//! Thin shim over `crate::billing`. Resolves the singleton config on every
//! call so a key-rotation by the CEO (re-launching with `STRIPE_API_KEY` set)
//! flips the mode without code change. Frontend wrappers live in
//! `app/src/lib/tauri.ts` under `// === v2.5 auth + billing ===`.

use crate::billing::{
    self, BillingError, SubscriptionStatus, TeamBilling, WebhookOutcome,
};
use serde::{Deserialize, Serialize};

use super::AppError;

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
    let t = billing::trial_start(
        &cfg,
        &team_id,
        &email,
        email_verified.unwrap_or(false),
        ip_hash.as_deref().unwrap_or(""),
    )?;
    Ok(to_dto(t))
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

    #[tokio::test]
    async fn cmd_trial_subscribe_cancel_round_trip() {
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
}
