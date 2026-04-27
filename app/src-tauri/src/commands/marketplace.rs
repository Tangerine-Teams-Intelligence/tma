//! v3.5 §1 — Tauri command surface for the marketplace.
//!
//! Thin envelope around `crate::marketplace`. Frontend wrappers live in
//! `app/src/lib/tauri.ts` (`marketplaceListTemplates`, `marketplaceInstallTemplate`,
//! ...). Stub mode by default — the real catalog API + Stripe Connect
//! payout flow lights up in the v3.5 production cut once the launch gate
//! is met (`crate::marketplace::is_launched`).

use std::path::PathBuf;

use crate::marketplace::{
    self, ListFilter, Template, TemplateInstallation,
};

use super::AppError;

/// Resolve the user's memory root. Mirrors
/// `commands::telemetry::resolve_memory_root` — duplicated locally so this
/// module doesn't take a private dep on memory.rs internals.
fn resolve_memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// Return the marketplace catalog filtered by the supplied filter. Stub
/// mode returns the hardcoded sample list (3 entries) with `install_count`
/// hydrated from `installs.json`.
#[tauri::command]
pub async fn marketplace_list_templates(
    filter: Option<ListFilter>,
) -> Result<Vec<Template>, AppError> {
    let root = resolve_memory_root()?;
    let f = filter.unwrap_or_default();
    marketplace::list_templates(&root, &f)
}

/// Apply a template's content bundle to the team's memory dir.
///
/// Wave 2 — real install pipeline: walks the dependency graph, applies
/// content (co-thinker prompts → agi/templates/, sources catalog append,
/// canvas templates → canvas/templates/, suggestion rules → agi/rules/),
/// rolls back on failure, and audit-logs the result. Already-installed
/// `(template_id, team_id)` pairs short-circuit and return the existing
/// record — the React `TemplateDetail` button reads this state via
/// `marketplace_is_installed`.
#[tauri::command]
pub async fn marketplace_install_template(
    template_id: String,
    team_id: String,
) -> Result<TemplateInstallation, AppError> {
    let root = resolve_memory_root()?;
    marketplace::install_template(&root, &template_id, &team_id)
}

/// Whether `(template_id, team_id)` is already installed. The React detail
/// page calls this on mount to render the "Already installed" state without
/// having to re-run the install pipeline.
#[tauri::command]
pub async fn marketplace_is_installed(
    template_id: String,
    team_id: String,
) -> Result<bool, AppError> {
    let root = resolve_memory_root()?;
    marketplace::is_installed(&root, &template_id, &team_id)
}

/// Roll back a previous install. Removes the cache dir + drops the
/// matching row from `installs.json`.
#[tauri::command]
pub async fn marketplace_uninstall_template(template_id: String) -> Result<(), AppError> {
    let root = resolve_memory_root()?;
    marketplace::uninstall_template(&root, &template_id)
}

/// Stub publish. The launch-gate check inside the lib keeps the real
/// registry call site dark until the v3.5 production cut.
#[tauri::command]
pub async fn marketplace_publish_template(
    metadata: Template,
    content: Vec<u8>,
) -> Result<Template, AppError> {
    let root = resolve_memory_root()?;
    marketplace::publish_template(&root, metadata, content)
}

/// Read the trigger-gate launch state. Frontend reads this to decide
/// whether to render the "Coming live when CEO triggers launch gate"
/// banner on `/marketplace`.
#[tauri::command]
pub async fn marketplace_get_launch_state() -> Result<marketplace::LaunchState, AppError> {
    let root = resolve_memory_root()?;
    marketplace::read_launch_state(&root)
}
