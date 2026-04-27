//! v2.5 — Stripe Connect billing module (scaffold, stub-mode default).
//!
//! Wire shape per `V2_5_SPEC.md` §2 + `BUSINESS_MODEL_SPEC.md` §10:
//! flat $5/team/month, 30-day no-CC trial, Stripe Connect (`on_behalf_of=null`
//! today, future enterprise-tier-ready).
//!
//! This module ships **stub mode by default** — it never makes a real Stripe
//! call. Stub mode simulates the subscription state machine end-to-end so the
//! React UI, trial banner, paywall gate, and Tauri command surface can all be
//! exercised without Stripe credentials. The CEO can flip to real mode once
//! `STRIPE_API_KEY` + `STRIPE_WEBHOOK_SECRET` are provisioned (see §2 of the
//! spec — webhook handler lands in v2.5.0-alpha.1).
//!
//! ## State machine
//!
//! ```text
//!     trialing  ──30d expiry──▶  past_due
//!         │                          │
//!         │ subscribe                │ subscribe (with card)
//!         ▼                          ▼
//!       active  ──cancel──▶       canceled
//! ```
//!
//! All transitions are persisted under
//! `~/.tangerine-memory/.tangerine/billing/{team_id}.json`. Real-mode webhooks
//! reconcile against the same file (§2 webhook handler — out of scope here).
//!
//! ## Why a stub-mode crate boundary
//!
//! Sibling agents own the React UI surfaces (`/billing` route, TrialBanner,
//! paywall gate). They need a deterministic IPC contract NOW so they can
//! integrate before live keys exist. Once the CEO unblocks Stripe, the only
//! file that flips is this one — the wire format stays stable.
//!
//! ## Abuse controls
//!
//! Per spec §2.4:
//!   * Email-verify gate: `trial_start` requires the caller to assert the
//!     email is verified (Supabase already gates sign-up; the assertion
//!     here is belt-and-braces in case sign-up flow changes).
//!   * IP rate limit: max 3 trial activations per IP per 7d. Tracked in
//!     `~/.tangerine-memory/.tangerine/billing/_rate.json` (a small map keyed
//!     by IP hash). Spec calls for a Cloudflare Worker fronting the daemon
//!     (§2.4) — this in-process counter is the v2.5.0-alpha.1 placeholder.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Stripe charge mode. `Stub` is the default until the CEO unblocks keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BillingMode {
    /// No real Stripe API call. Subscription transitions are simulated
    /// against the per-team JSON file. `cargo test` runs in this mode.
    Stub,
    /// Stripe **test** keys (`sk_test_...`). Real network calls; charges
    /// against the test ledger. v2.5.0-alpha.1 ships here.
    Test,
    /// Stripe **live** keys (`sk_live_...`). Real money. v2.5.0 final.
    Live,
}

impl Default for BillingMode {
    fn default() -> Self {
        // Default = stub. Real mode is opt-in via `BillingConfig::from_env`.
        BillingMode::Stub
    }
}

/// Runtime config. Built from env at boot; the CEO can rotate keys without
/// a code change.
#[derive(Debug, Clone, Default)]
pub struct BillingConfig {
    pub stripe_api_key: Option<String>,
    pub webhook_secret: Option<String>,
    pub mode: BillingMode,
    /// Resolved on init from `AppPaths::user_data` so tests can swap in a
    /// tmpdir without touching the real `~/.tangerine-memory/` tree.
    pub state_dir: Option<PathBuf>,
}

impl BillingConfig {
    /// Read config from env. Falls back to stub mode when keys are missing.
    /// `STRIPE_API_KEY` prefix decides test vs live (`sk_test_` → Test,
    /// `sk_live_` → Live, anything else stays Stub for safety).
    pub fn from_env() -> Self {
        let stripe_api_key = std::env::var("STRIPE_API_KEY").ok().filter(|s| !s.is_empty());
        let webhook_secret = std::env::var("STRIPE_WEBHOOK_SECRET")
            .ok()
            .filter(|s| !s.is_empty());

        let mode = match stripe_api_key.as_deref() {
            Some(k) if k.starts_with("sk_test_") => BillingMode::Test,
            Some(k) if k.starts_with("sk_live_") => BillingMode::Live,
            _ => BillingMode::Stub,
        };

        Self {
            stripe_api_key,
            webhook_secret,
            mode,
            state_dir: None,
        }
    }

    pub fn is_stub(&self) -> bool {
        self.mode == BillingMode::Stub
    }

    /// Resolve the per-team state file. Caller is responsible for ensuring
    /// the parent dir exists.
    pub fn team_file(&self, team_id: &str) -> PathBuf {
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
        base.join(format!("{team_id}.json"))
    }

    pub fn rate_file(&self) -> PathBuf {
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
        base.join("_rate.json")
    }
}

/// Subscription status. Mirrors Stripe's standard `Subscription.status` enum
/// so the field crosses the wire 1:1 once we flip from stub to real.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionStatus {
    /// 30-day no-CC trial active. `trial_end` field on the team record is
    /// the truth.
    Trialing,
    /// Subscription paid + active (or trial expired with card on file).
    Active,
    /// Trial expired without card OR payment failed. Cloud features are
    /// gated; OSS path stays usable.
    PastDue,
    /// User cancelled. Terminal — re-subscribe issues a fresh sub.
    Canceled,
    /// No record (clean slate / not yet subscribed).
    None,
}

impl SubscriptionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Trialing => "trialing",
            Self::Active => "active",
            Self::PastDue => "past_due",
            Self::Canceled => "canceled",
            Self::None => "none",
        }
    }
}

/// Per-team billing record. Persisted as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamBilling {
    pub team_id: String,
    pub status: SubscriptionStatus,
    /// UNIX timestamp seconds. `0` when unset.
    pub trial_start: u64,
    /// UNIX timestamp seconds. `0` when unset.
    pub trial_end: u64,
    pub stripe_customer_id: Option<String>,
    pub stripe_subscription_id: Option<String>,
    /// Caller-supplied at trial-start so the email-verify gate can be
    /// audited. Not used to send mail from this module.
    pub email: Option<String>,
}

impl TeamBilling {
    pub fn fresh(team_id: String) -> Self {
        Self {
            team_id,
            status: SubscriptionStatus::None,
            trial_start: 0,
            trial_end: 0,
            stripe_customer_id: None,
            stripe_subscription_id: None,
            email: None,
        }
    }

    /// Trial-active = `now < trial_end`. Cloud feature gates call this.
    pub fn trial_active(&self, now: u64) -> bool {
        self.trial_end > 0 && now < self.trial_end
    }
}

/// Outcome of a webhook. v2.5.0-alpha.1 wires the actual handler in
/// `webhook.rs` (out of scope for this scaffold); we expose the type here so
/// the daemon can route without pulling in stripe-rust until real mode lands.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookOutcome {
    pub event_type: String,
    pub team_id: Option<String>,
    pub new_status: Option<SubscriptionStatus>,
    pub message: String,
}

/// Errors. Maps onto `AppError::External` / `AppError::Config` at the Tauri
/// command layer.
#[derive(Debug, thiserror::Error)]
pub enum BillingError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("real-mode call attempted in stub mode")]
    StubModeOnly,
    #[error("email not verified")]
    EmailNotVerified,
    #[error("rate limit exceeded: {0} trials in last 7d from this IP")]
    RateLimit(usize),
    #[error("invalid signature on webhook payload")]
    InvalidSignature,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("stripe key not configured")]
    KeyMissing,
}

// ----- Persistence helpers ----------------------------------------------

fn load_team(cfg: &BillingConfig, team_id: &str) -> Result<TeamBilling, BillingError> {
    let path = cfg.team_file(team_id);
    if !path.is_file() {
        return Ok(TeamBilling::fresh(team_id.to_string()));
    }
    let raw = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&raw)?)
}

fn save_team(cfg: &BillingConfig, t: &TeamBilling) -> Result<(), BillingError> {
    let path = cfg.team_file(&t.team_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(t)?;
    std::fs::write(path, raw)?;
    Ok(())
}

// ----- Trial logic ------------------------------------------------------

const THIRTY_DAYS_SECS: u64 = 30 * 24 * 60 * 60;
const SEVEN_DAYS_SECS: u64 = 7 * 24 * 60 * 60;
const MAX_TRIALS_PER_IP_PER_7D: usize = 3;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Email-verify gate. Real mode delegates to Supabase
/// (`auth.users.email_confirmed_at IS NOT NULL`). Stub mode trusts the
/// caller — but the param is still required so the IPC shape doesn't change
/// when we flip.
pub fn email_verified_or_err(email_verified: bool) -> Result<(), BillingError> {
    if email_verified {
        Ok(())
    } else {
        Err(BillingError::EmailNotVerified)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RateLedger {
    /// Map IP-hash → list of trial-activation timestamps (seconds).
    pub events: HashMap<String, Vec<u64>>,
}

fn load_rate(cfg: &BillingConfig) -> Result<RateLedger, BillingError> {
    let path = cfg.rate_file();
    if !path.is_file() {
        return Ok(RateLedger::default());
    }
    let raw = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn save_rate(cfg: &BillingConfig, l: &RateLedger) -> Result<(), BillingError> {
    let path = cfg.rate_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(l)?;
    std::fs::write(path, raw)?;
    Ok(())
}

/// Enforce the 3-trials-per-IP-per-7d limit. Pass an empty string for
/// `ip_hash` to skip (unit tests do this).
pub fn check_rate(cfg: &BillingConfig, ip_hash: &str) -> Result<(), BillingError> {
    if ip_hash.is_empty() {
        return Ok(());
    }
    let mut l = load_rate(cfg)?;
    let now = now_secs();
    let cutoff = now.saturating_sub(SEVEN_DAYS_SECS);
    let entry = l.events.entry(ip_hash.to_string()).or_default();
    entry.retain(|t| *t >= cutoff);
    if entry.len() >= MAX_TRIALS_PER_IP_PER_7D {
        return Err(BillingError::RateLimit(entry.len()));
    }
    entry.push(now);
    save_rate(cfg, &l)?;
    Ok(())
}

/// Start a trial for `team_id`. Sets `status = trialing`, `trial_end = now + 30d`.
/// Idempotent — calling twice doesn't extend the trial; the second call is a
/// no-op that returns the existing record.
pub fn trial_start(
    cfg: &BillingConfig,
    team_id: &str,
    email: &str,
    email_verified: bool,
    ip_hash: &str,
) -> Result<TeamBilling, BillingError> {
    email_verified_or_err(email_verified)?;
    let mut t = load_team(cfg, team_id)?;
    if t.status == SubscriptionStatus::Trialing || t.status == SubscriptionStatus::Active {
        return Ok(t);
    }
    check_rate(cfg, ip_hash)?;
    let now = now_secs();
    t.status = SubscriptionStatus::Trialing;
    t.trial_start = now;
    t.trial_end = now + THIRTY_DAYS_SECS;
    t.email = Some(email.to_string());
    save_team(cfg, &t)?;
    Ok(t)
}

/// Read current status. Implicit transition: trial that has elapsed past
/// `trial_end` while still in `Trialing` state is reported as `PastDue`.
/// We DO NOT mutate the file on read — the daemon (or the next webhook)
/// is the canonical state mutator. The read-side promotion is purely
/// for the UI gate.
pub fn billing_status(cfg: &BillingConfig, team_id: &str) -> Result<TeamBilling, BillingError> {
    let mut t = load_team(cfg, team_id)?;
    let now = now_secs();
    if t.status == SubscriptionStatus::Trialing && t.trial_end > 0 && now >= t.trial_end {
        t.status = SubscriptionStatus::PastDue;
    }
    Ok(t)
}

// ----- Subscription transitions -----------------------------------------

/// Move team from `Trialing` (or `PastDue`) to `Active`. In stub mode this
/// fakes a `cus_stub_*` + `sub_stub_*` id. In real mode this would call
/// Stripe to create a Customer + Subscription with `trial_end` already
/// captured (handled by webhook in real mode).
pub fn create_subscription(
    cfg: &BillingConfig,
    team_id: &str,
    payment_method_id: &str,
) -> Result<TeamBilling, BillingError> {
    let mut t = load_team(cfg, team_id)?;
    if cfg.is_stub() {
        // Simulate Stripe `customer.subscription.created` webhook outcome.
        t.status = SubscriptionStatus::Active;
        t.stripe_customer_id = Some(format!("cus_stub_{team_id}"));
        t.stripe_subscription_id = Some(format!("sub_stub_{team_id}_{payment_method_id}"));
        save_team(cfg, &t)?;
        return Ok(t);
    }
    // Real-mode wiring lands in v2.5.0-alpha.1 — guard so a misconfigured
    // build can never silently miss-charge.
    if cfg.stripe_api_key.is_none() {
        return Err(BillingError::KeyMissing);
    }
    Err(BillingError::StubModeOnly)
}

/// Cancel the team's subscription. Terminal state — re-subscribing creates
/// a new sub (per Stripe semantics).
pub fn cancel_subscription(cfg: &BillingConfig, team_id: &str) -> Result<TeamBilling, BillingError> {
    let mut t = load_team(cfg, team_id)?;
    if t.status == SubscriptionStatus::None {
        return Err(BillingError::NotFound(team_id.to_string()));
    }
    if cfg.is_stub() {
        t.status = SubscriptionStatus::Canceled;
        save_team(cfg, &t)?;
        return Ok(t);
    }
    if cfg.stripe_api_key.is_none() {
        return Err(BillingError::KeyMissing);
    }
    Err(BillingError::StubModeOnly)
}

/// Webhook handler stub. v2.5.0-alpha.1 wires real signature verification
/// via `stripe::Webhook::construct_event`; for the scaffold we surface the
/// shape so the daemon can route the HTTP endpoint already.
pub fn webhook_handle(
    cfg: &BillingConfig,
    payload: &str,
    signature: &str,
) -> Result<WebhookOutcome, BillingError> {
    if cfg.is_stub() {
        // Stub mode parses payload as JSON and reports back without mutating
        // any team file. Tests use this to assert the response shape.
        let parsed: serde_json::Value = serde_json::from_str(payload).unwrap_or_default();
        let event_type = parsed
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown.event")
            .to_string();
        return Ok(WebhookOutcome {
            event_type,
            team_id: None,
            new_status: None,
            message: "stub mode — no state mutation".to_string(),
        });
    }
    if signature.is_empty() {
        return Err(BillingError::InvalidSignature);
    }
    if cfg.webhook_secret.is_none() {
        return Err(BillingError::KeyMissing);
    }
    Err(BillingError::StubModeOnly)
}

// ----- Process-wide singleton (loaded once at boot) --------------------

static BILLING: once_cell::sync::Lazy<Mutex<BillingConfig>> =
    once_cell::sync::Lazy::new(|| Mutex::new(BillingConfig::from_env()));

/// Get a snapshot of the current billing config.
pub fn current_config() -> BillingConfig {
    BILLING.lock().expect("billing mutex").clone()
}

/// Override the state dir (used by tests + by `setup_state` to anchor the
/// dir under `AppPaths::user_data` instead of `~/.tangerine-memory/`).
pub fn set_state_dir(dir: PathBuf) {
    let mut g = BILLING.lock().expect("billing mutex");
    g.state_dir = Some(dir);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Tests share process state via the static mutex. Serialise so they
    /// don't stomp each other.
    static TEST_LOCK: once_cell::sync::Lazy<StdMutex<()>> =
        once_cell::sync::Lazy::new(|| StdMutex::new(()));

    fn tmp_cfg() -> BillingConfig {
        let dir = std::env::temp_dir()
            .join(format!("tangerine-billing-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        BillingConfig {
            stripe_api_key: None,
            webhook_secret: None,
            mode: BillingMode::Stub,
            state_dir: Some(dir),
        }
    }

    #[test]
    fn from_env_defaults_to_stub() {
        let _g = TEST_LOCK.lock().unwrap();
        // Neutralise env so the default path runs.
        std::env::remove_var("STRIPE_API_KEY");
        std::env::remove_var("STRIPE_WEBHOOK_SECRET");
        let c = BillingConfig::from_env();
        assert_eq!(c.mode, BillingMode::Stub);
        assert!(c.is_stub());
    }

    #[test]
    fn from_env_picks_test_mode_on_test_key() {
        let _g = TEST_LOCK.lock().unwrap();
        std::env::set_var("STRIPE_API_KEY", "sk_test_FAKE");
        let c = BillingConfig::from_env();
        assert_eq!(c.mode, BillingMode::Test);
        std::env::remove_var("STRIPE_API_KEY");
    }

    #[test]
    fn stub_simulates_trial_to_active_to_canceled() {
        let cfg = tmp_cfg();
        let t = trial_start(&cfg, "team-A", "ceo@tangerine.test", true, "")
            .expect("trial_start");
        assert_eq!(t.status, SubscriptionStatus::Trialing);
        assert!(t.trial_end > t.trial_start);
        assert_eq!(t.trial_end - t.trial_start, THIRTY_DAYS_SECS);

        let s = create_subscription(&cfg, "team-A", "pm_stub_card").expect("subscribe");
        assert_eq!(s.status, SubscriptionStatus::Active);
        assert!(s.stripe_customer_id.as_ref().unwrap().starts_with("cus_stub_"));

        let c = cancel_subscription(&cfg, "team-A").expect("cancel");
        assert_eq!(c.status, SubscriptionStatus::Canceled);
    }

    #[test]
    fn email_verify_gate_blocks_unverified() {
        let cfg = tmp_cfg();
        let r = trial_start(&cfg, "team-B", "noverify@tangerine.test", false, "");
        assert!(matches!(r, Err(BillingError::EmailNotVerified)));
    }

    #[test]
    fn ip_rate_limit_blocks_fourth_trial() {
        let cfg = tmp_cfg();
        let ip = "ip_hash_fake";
        for i in 0..MAX_TRIALS_PER_IP_PER_7D {
            let team = format!("team-rate-{i}");
            trial_start(&cfg, &team, "x@y.z", true, ip).expect("first 3 ok");
        }
        let r = trial_start(&cfg, "team-rate-overflow", "x@y.z", true, ip);
        match r {
            Err(BillingError::RateLimit(n)) => assert_eq!(n, MAX_TRIALS_PER_IP_PER_7D),
            other => panic!("expected RateLimit, got {other:?}"),
        }
    }

    #[test]
    fn trial_30_day_countdown() {
        let cfg = tmp_cfg();
        let t = trial_start(&cfg, "team-D", "d@t.test", true, "").unwrap();
        let now = now_secs();
        assert!(t.trial_active(now));
        assert!(!t.trial_active(t.trial_end + 1));
        // Read-side auto-promotes expired trial to PastDue without mutating
        // the file.
        let mut t2 = t.clone();
        t2.trial_end = now.saturating_sub(1);
        save_team(&cfg, &t2).unwrap();
        let read = billing_status(&cfg, "team-D").unwrap();
        assert_eq!(read.status, SubscriptionStatus::PastDue);
    }

    #[test]
    fn idempotent_trial_start() {
        let cfg = tmp_cfg();
        let a = trial_start(&cfg, "team-E", "e@t.test", true, "").unwrap();
        let b = trial_start(&cfg, "team-E", "e@t.test", true, "").unwrap();
        // Second call must not extend trial_end.
        assert_eq!(a.trial_end, b.trial_end);
    }

    #[test]
    fn webhook_stub_returns_event_type() {
        let cfg = tmp_cfg();
        let payload = r#"{"type":"customer.subscription.updated","data":{}}"#;
        let r = webhook_handle(&cfg, payload, "sig_anything").unwrap();
        assert_eq!(r.event_type, "customer.subscription.updated");
        assert!(r.message.contains("stub"));
    }

    #[test]
    fn cancel_unknown_team_errors() {
        let cfg = tmp_cfg();
        let r = cancel_subscription(&cfg, "ghost-team");
        assert!(matches!(r, Err(BillingError::NotFound(_))));
    }
}
