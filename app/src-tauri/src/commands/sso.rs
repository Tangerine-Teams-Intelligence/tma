//! v3.5 §5.1 — Tauri command surface for SSO SAML.
//!
//! Stub mode by default — `validate_saml_response` returns a deterministic
//! mock assertion so the React JIT-provisioning UI can demo the flow
//! without a real IdP wired up. Production cut wires `keycloak-rs` or
//! WorkOS via a single-file swap inside this module.

use std::path::PathBuf;

use crate::sso::{self, SAMLAssertion, SSOConfig};

use super::AppError;

fn resolve_memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// Persist an SSO SAML config for a tenant.
#[tauri::command]
pub async fn sso_set_config(config: SSOConfig) -> Result<SSOConfig, AppError> {
    let root = resolve_memory_root()?;
    sso::write_config(&root, &config)?;
    Ok(config)
}

/// Read the SSO config for a given tenant. Returns `None` when the tenant
/// has no SAML configured yet.
#[tauri::command]
pub async fn sso_get_config(tenant: String) -> Result<Option<SSOConfig>, AppError> {
    let root = resolve_memory_root()?;
    sso::read_config(&root, &tenant)
}

/// List every persisted SSO config — used by the admin console to surface
/// every tenant with SSO enabled.
#[tauri::command]
pub async fn sso_list_configs() -> Result<Vec<SSOConfig>, AppError> {
    let root = resolve_memory_root()?;
    sso::list_configs(&root)
}

/// Stub validator. v3.5 returns a deterministic mock `SAMLAssertion` for
/// any non-empty `response` against a known tenant. Real SAML 2.0
/// signature + audience + NotOnOrAfter checks live behind the production
/// cutover.
#[tauri::command]
pub async fn sso_validate_saml_response(
    tenant: String,
    response: String,
) -> Result<SAMLAssertion, AppError> {
    let root = resolve_memory_root()?;
    sso::validate_saml_response(&root, &tenant, &response)
}
