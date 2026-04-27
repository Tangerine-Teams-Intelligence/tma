//! v2.5 — Tauri command surface for Supabase auth.
//!
//! Thin shim over `crate::auth`. Each command resolves the current
//! `AuthConfig` from env on every invocation so a key-rotation by the CEO
//! takes effect on the next call (no Tauri restart). Frontend wrappers
//! live in `app/src/lib/tauri.ts` under the `// === v2.5 auth + billing ===`
//! marker block.

use crate::auth::{
    self, AuthError, OAuthProvider, Session,
};
use serde::{Deserialize, Serialize};

use super::AppError;

impl From<AuthError> for AppError {
    fn from(e: AuthError) -> Self {
        match e {
            AuthError::InvalidEmail => AppError::user("invalid_email", e.to_string()),
            AuthError::PasswordTooShort => AppError::user("password_too_short", e.to_string()),
            AuthError::StubModeOnly => AppError::config("stub_mode_only", e.to_string()),
            AuthError::KeyMissing => AppError::config("supabase_key_missing", e.to_string()),
            AuthError::Network(s) => AppError::external("supabase_network", s),
            AuthError::NotSignedIn => AppError::user("not_signed_in", e.to_string()),
            AuthError::EmailNotVerified => AppError::user("email_not_verified", e.to_string()),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthSessionDto {
    pub user_id: String,
    pub email: String,
    pub email_confirmed: bool,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub mode: String,
}

fn to_dto(s: Session, mode: &str) -> AuthSessionDto {
    AuthSessionDto {
        user_id: s.user_id,
        email: s.email,
        email_confirmed: s.email_confirmed_at.is_some(),
        access_token: s.access_token,
        refresh_token: s.refresh_token,
        expires_at: s.expires_at,
        mode: mode.to_string(),
    }
}

fn mode_str(cfg: &auth::AuthConfig) -> &'static str {
    if cfg.is_stub() { "stub" } else { "real" }
}

#[tauri::command]
pub async fn auth_sign_in_email_password(
    email: String,
    password: String,
) -> Result<AuthSessionDto, AppError> {
    let cfg = auth::AuthConfig::from_env();
    let s = auth::sign_in_email_password(&cfg, &email, &password).await?;
    Ok(to_dto(s, mode_str(&cfg)))
}

#[tauri::command]
pub async fn auth_sign_up(
    email: String,
    password: String,
) -> Result<AuthSessionDto, AppError> {
    let cfg = auth::AuthConfig::from_env();
    let s = auth::sign_up(&cfg, &email, &password).await?;
    Ok(to_dto(s, mode_str(&cfg)))
}

#[tauri::command]
pub async fn auth_sign_in_oauth(provider: String) -> Result<AuthSessionDto, AppError> {
    let cfg = auth::AuthConfig::from_env();
    let prov = match provider.to_lowercase().as_str() {
        "github" => OAuthProvider::Github,
        "google" => OAuthProvider::Google,
        other => {
            return Err(AppError::user(
                "unknown_oauth_provider",
                format!("'{other}' (allowed: github, google)"),
            ))
        }
    };
    let s = auth::sign_in_oauth(&cfg, prov).await?;
    Ok(to_dto(s, mode_str(&cfg)))
}

#[tauri::command]
pub async fn auth_verify_email(token: String) -> Result<AuthSessionDto, AppError> {
    let cfg = auth::AuthConfig::from_env();
    let s = auth::verify_email(&cfg, &token).await?;
    Ok(to_dto(s, mode_str(&cfg)))
}

#[tauri::command]
pub async fn auth_sign_out() -> Result<(), AppError> {
    let cfg = auth::AuthConfig::from_env();
    auth::sign_out(&cfg).await?;
    Ok(())
}

#[tauri::command]
pub async fn auth_session() -> Result<Option<AuthSessionDto>, AppError> {
    let cfg = auth::AuthConfig::from_env();
    let s = auth::get_session(&cfg).await?;
    Ok(s.map(|sess| to_dto(sess, mode_str(&cfg))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cmd_signin_then_session_round_trip() {
        // Use stub mode (default; no env vars).
        std::env::remove_var("SUPABASE_URL");
        std::env::remove_var("SUPABASE_ANON_KEY");
        let dto = auth_sign_in_email_password("user@example.com".into(), "abcdef".into())
            .await
            .unwrap();
        assert_eq!(dto.email, "user@example.com");
        assert_eq!(dto.mode, "stub");

        let s = auth_session().await.unwrap();
        assert!(s.is_some());
        auth_sign_out().await.unwrap();
        let s2 = auth_session().await.unwrap();
        assert!(s2.is_none());
    }

    #[tokio::test]
    async fn cmd_unknown_provider_user_errors() {
        let r = auth_sign_in_oauth("apple".into()).await;
        match r {
            Err(AppError::User { code, .. }) => assert_eq!(code, "unknown_oauth_provider"),
            other => panic!("expected user error, got {other:?}"),
        }
    }
}
