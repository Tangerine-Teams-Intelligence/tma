//! v3.5 §4 — Tauri command surface for enterprise white-label branding.
//!
//! Thin envelope around `crate::branding`. Frontend wrappers live in
//! `app/src/lib/branding.ts` + `app/src/lib/tauri.ts`. Default config is
//! the Tangerine baseline — only enterprise tenants overlay their own
//! palette / logo / domain / app name.

use std::path::PathBuf;

use crate::branding::{self, BrandingConfig, LicenseValidation};

use super::AppError;

fn resolve_memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// Read the current branding override. Returns the Tangerine default when
/// no override exists.
#[tauri::command]
pub async fn branding_get_config() -> Result<BrandingConfig, AppError> {
    let root = resolve_memory_root()?;
    branding::read_branding(&root)
}

/// Apply a branding override. Validates hex colors before writing so a
/// malformed config can never poison the React-side CSS injection.
#[tauri::command]
pub async fn branding_apply(cfg: BrandingConfig) -> Result<BrandingConfig, AppError> {
    let root = resolve_memory_root()?;
    branding::apply_branding(&root, cfg)
}

/// Drop the override and return to the Tangerine baseline.
#[tauri::command]
pub async fn branding_reset_to_default() -> Result<BrandingConfig, AppError> {
    let root = resolve_memory_root()?;
    branding::reset_to_default(&root)
}

/// Stub license validator. Production v3.5 calls the licensing service
/// (Stripe + signed JWT); until then, accept `tangerine-trial-*` and
/// `tangerine-license-*` prefixes.
#[tauri::command]
pub async fn branding_validate_license(key: String) -> Result<LicenseValidation, AppError> {
    branding::validate_license(&key)
}
