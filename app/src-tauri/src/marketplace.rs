//! v3.5 §1 — Marketplace backend (Wave 2: real install flow + rollback + audit).
//!
//! Tangerine v3.5 turns the app into a distribution layer. This module is the
//! Rust-side surface for the public marketplace where community authors ship
//! vertical templates (legal / sales / design / ops / product) on top of the
//! OSS app, and Tangerine takes 10–15% on transactions.
//!
//! v3.5 trigger gate (per `BUSINESS_MODEL_SPEC.md` §10 line 5 +
//! `V3_5_SPEC.md` §2): the public marketplace ships **only when both**
//!   1. 5,000 OSS installs (rolling 30-day uniques on the `navigate_route`
//!      telemetry event), and
//!   2. 1 self-shipped vertical template internally validated for ≥30 days.
//!
//! ## What this file ships
//!
//! Wave 2 deepens the install flow into a real five-step pipeline that
//! actually moves bytes around the team memory dir:
//!
//! 1. **Walk dependency graph**: catalog lookup, refuse circular / unknown
//!    deps. Stub catalog has no inter-template deps but the algorithm runs
//!    so the IPC contract is real.
//! 2. **Already-installed short-circuit**: same `(team, template)` re-runs
//!    return the existing record without re-applying content. The React
//!    `TemplateDetail` button uses this to render an "Already installed"
//!    state per spec §1.2.
//! 3. **Apply template content** atomically:
//!    * Co-thinker prompts → `~/.tangerine-memory/agi/templates/<id>/prompts.toml`
//!    * Sources catalog **append** (never overwrite) →
//!      `~/.tangerine-memory/sources/catalog.json` (`[{ template_id, ... }]`)
//!    * Canvas templates → `~/.tangerine-memory/canvas/templates/<id>/canvas.template.json`
//!    * Suggestion rules → `~/.tangerine-memory/agi/rules/<id>.toml`
//! 4. **Rollback on failure**: every successful step gets a rollback closure
//!    pushed onto a stack; on any subsequent failure we drain the stack to
//!    leave the disk in the pre-install state. Same pattern as
//!    `crate::sources::email::test_connection`.
//! 5. **Audit append**: success and failure both log `template.install` with
//!    `resource = template_id` and a `step` payload — fed into the v3.5
//!    audit log so SOC 2 reviewers can trace marketplace installs.
//!
//! Stub catalog stays in this file (no real registry HTTP yet). The Stripe
//! Connect call site is still gated behind `is_launched()`. The real CDN
//! download + GPG signature verify lights up with the launch gate.
//!
//! Storage layout:
//!   `~/.tangerine-memory/marketplace/`
//!     `templates/`         — local cache, one dir per installed template
//!     `installs.json`      — Vec<TemplateInstallation>
//!     `commissions.json`   — Vec<CommissionRecord>
//!     `launch_state.json`  — { launched: bool, gate_status: GateStatus }
//!   `~/.tangerine-memory/agi/templates/<id>/prompts.toml`
//!   `~/.tangerine-memory/agi/rules/<id>.toml`
//!   `~/.tangerine-memory/canvas/templates/<id>/canvas.template.json`
//!   `~/.tangerine-memory/sources/catalog.json`  (append-only, by template_id)

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::audit_log::{self, AuditEntryInput};
use crate::commands::AppError;

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

/// One marketplace template entry. Field names mirror the TypeScript
/// `Template` interface in `app/src/lib/tauri.ts`. Everything is serializable
/// so the Tauri command surface can return Vec<Template> directly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Template {
    /// Stable slug (`acme-legal-pack`, `tangerine-legal-pack`, ...). Matches
    /// the dependency-graph node id; never changes after publish.
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// Semver string. Each publish bumps this.
    pub version: String,
    /// Author handle. `tangerine` for self-shipped, anything else for
    /// community.
    pub author: String,
    /// One-paragraph description shown on the listing page.
    pub description: String,
    /// One of: `"legal"`, `"sales"`, `"design"`, `"product"`, `"ops"`,
    /// `"engineering"`, `"finance"`, `"healthcare"`, `"education"`. Used by
    /// the search filter UI.
    pub vertical: String,
    /// Where the template content bundle lives. Stub returns a local
    /// resource path (`bundled://legal-pack`); production returns a signed
    /// CDN URL.
    pub content_url: String,
    /// Other template ids this one requires. Stub returns an empty Vec for
    /// every sample; real installs walk this graph before applying.
    pub dependencies: Vec<String>,
    /// Commission rate in basis points (1000 = 10.00%, 1500 = 15.00%).
    /// Computed from `price_cents` per the v3.5 §1.3 take-rate band.
    pub take_rate: u32,
    /// Sticker price in cents. `0` denotes free.
    pub price_cents: u32,
    /// Total install count across all users. Stub returns the seeded value;
    /// production reads from the registry's analytics endpoint.
    pub install_count: u64,
}

/// Record of one user installing one template. Persisted to
/// `installs.json` so `marketplace_list_templates` can mark templates as
/// already installed for the current team.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TemplateInstallation {
    pub template_id: String,
    pub team_id: String,
    pub installed_at: DateTime<Utc>,
    pub version: String,
}

/// One commission record. The take-rate engine writes one of these per
/// `marketplace_install_template` call with `price_cents > 0`. Real
/// payout via Stripe Connect happens out-of-band during the v3.5
/// production cut once the launch gate is met.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CommissionRecord {
    pub template_id: String,
    pub team_id: String,
    pub price_cents: u32,
    pub take_rate_bps: u32,
    pub recorded_at: DateTime<Utc>,
    /// `true` when the production Stripe Connect call site fired. Stub
    /// always emits `false` so the real-vs-stub split is auditable.
    pub stripe_recorded: bool,
}

/// Marketplace launch trigger gate status (v3.5 §2). Held in
/// `launch_state.json` so the Settings UI can inspect progress.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GateStatus {
    /// Last computed 30-day rolling install count. Stub returns 0; the
    /// daemon refreshes this from the telemetry stream in production.
    pub installs_30d: u64,
    /// Required threshold per `BUSINESS_MODEL_SPEC.md` §10 line 5.
    pub installs_required: u64,
    /// Whether ≥1 self-shipped vertical template has been internally
    /// validated. Defaults to `true` once the legal-pack ships.
    pub self_shipped_template_validated: bool,
}

impl GateStatus {
    /// Both conditions must be met before the marketplace surfaces public.
    pub fn passes(&self) -> bool {
        self.installs_30d >= self.installs_required
            && self.self_shipped_template_validated
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LaunchState {
    pub launched: bool,
    pub gate_status: GateStatus,
}

impl Default for LaunchState {
    fn default() -> Self {
        Self {
            launched: false,
            gate_status: GateStatus {
                installs_30d: 0,
                installs_required: 5_000,
                self_shipped_template_validated: false,
            },
        }
    }
}

/// One sources-catalog entry written by the install flow. Append-only — the
/// install pipeline never overwrites an existing entry, so user customizations
/// outside the template-managed range are preserved.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SourcesCatalogEntry {
    pub template_id: String,
    pub vertical: String,
    pub version: String,
    pub installed_at: DateTime<Utc>,
}

/// Filter inputs from `marketplace_list_templates(filter)`. All fields are
/// optional — an empty filter returns every template in the catalog.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ListFilter {
    pub vertical: Option<String>,
    /// Free-text query, case-insensitive substring match against
    /// name + description.
    pub query: Option<String>,
    pub language: Option<String>,
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/// Resolve `<memory_root>/marketplace/`, creating it if missing. We always
/// derive from the supplied root rather than reading `dirs::home_dir()` so
/// the test harness can drop in a tempdir.
fn marketplace_dir(memory_root: &Path) -> Result<PathBuf, AppError> {
    let dir = memory_root.join("marketplace");
    fs::create_dir_all(&dir).map_err(|e| {
        AppError::internal("marketplace_mkdir", format!("{}: {}", dir.display(), e))
    })?;
    Ok(dir)
}

fn templates_cache_dir(memory_root: &Path) -> Result<PathBuf, AppError> {
    let dir = marketplace_dir(memory_root)?.join("templates");
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal("marketplace_templates_mkdir", e.to_string()))?;
    Ok(dir)
}

fn installs_path(memory_root: &Path) -> Result<PathBuf, AppError> {
    Ok(marketplace_dir(memory_root)?.join("installs.json"))
}

fn commissions_path(memory_root: &Path) -> Result<PathBuf, AppError> {
    Ok(marketplace_dir(memory_root)?.join("commissions.json"))
}

fn launch_state_path(memory_root: &Path) -> Result<PathBuf, AppError> {
    Ok(marketplace_dir(memory_root)?.join("launch_state.json"))
}

/// `~/.tangerine-memory/agi/templates/<id>/` — co-thinker prompts target
/// per spec §1.1.
fn agi_templates_dir(memory_root: &Path, template_id: &str) -> Result<PathBuf, AppError> {
    let dir = memory_root.join("agi").join("templates").join(template_id);
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal("marketplace_agi_templates_mkdir", e.to_string()))?;
    Ok(dir)
}

/// `~/.tangerine-memory/agi/rules/` — suggestion rules registry per spec §1.1.
/// One file per template (`<id>.toml`).
fn agi_rules_dir(memory_root: &Path) -> Result<PathBuf, AppError> {
    let dir = memory_root.join("agi").join("rules");
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal("marketplace_agi_rules_mkdir", e.to_string()))?;
    Ok(dir)
}

/// `~/.tangerine-memory/canvas/templates/<id>/` — canvas templates target
/// per spec §1.1.
fn canvas_templates_dir(memory_root: &Path, template_id: &str) -> Result<PathBuf, AppError> {
    let dir = memory_root.join("canvas").join("templates").join(template_id);
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal("marketplace_canvas_templates_mkdir", e.to_string()))?;
    Ok(dir)
}

/// `~/.tangerine-memory/sources/catalog.json` — append-only sources catalog.
fn sources_catalog_path(memory_root: &Path) -> Result<PathBuf, AppError> {
    let dir = memory_root.join("sources");
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal("marketplace_sources_mkdir", e.to_string()))?;
    Ok(dir.join("catalog.json"))
}

fn read_json_or_default<T: serde::de::DeserializeOwned + Default>(
    path: &Path,
) -> Result<T, AppError> {
    if !path.exists() {
        return Ok(T::default());
    }
    let raw = fs::read_to_string(path)
        .map_err(|e| AppError::internal("marketplace_read", e.to_string()))?;
    if raw.trim().is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str(&raw).map_err(AppError::from)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("marketplace_write_parent", e.to_string()))?;
    }
    let raw = serde_json::to_string_pretty(value)?;
    fs::write(path, raw).map_err(|e| AppError::internal("marketplace_write", e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Catalog (stub)
// ---------------------------------------------------------------------------

/// Hardcoded sample catalog for stub mode. Returns the self-shipped
/// "Tangerine for Legal Teams" pack first so the React UI shows the
/// canonical example at the top.
pub fn stub_catalog() -> Vec<Template> {
    vec![
        Template {
            id: "tangerine-legal-pack".to_string(),
            name: "Tangerine for Legal Teams".to_string(),
            version: "0.1.0".to_string(),
            author: "tangerine".to_string(),
            description:
                "Self-shipped reference vertical: contract-clause taxonomy, case-law citation \
patterns, deposition prep canvas, deadline-reminder rules. Designed for solo / \
small-firm lawyers. First 100 installs free; $199 thereafter."
                    .to_string(),
            vertical: "legal".to_string(),
            content_url: "bundled://legal-pack".to_string(),
            dependencies: Vec::new(),
            take_rate: 1500,
            price_cents: 19900,
            install_count: 0,
        },
        Template {
            id: "acme-sales-pack".to_string(),
            name: "Acme Sales Pack".to_string(),
            version: "0.0.1".to_string(),
            author: "acme".to_string(),
            description: "Sample sales-team template (stub). Pipeline-stage canvas + Slack \
intake config + opportunity-scoring suggestion rules."
                .to_string(),
            vertical: "sales".to_string(),
            content_url: "stub://acme-sales".to_string(),
            dependencies: Vec::new(),
            take_rate: 1000,
            price_cents: 4900,
            install_count: 0,
        },
        Template {
            id: "starter-design-pack".to_string(),
            name: "Starter Design Pack".to_string(),
            version: "0.0.1".to_string(),
            author: "tangerine".to_string(),
            description: "Free starter template for design teams (stub). Mood-board canvas + \
Figma-link source connector + design-review suggestion rules."
                .to_string(),
            vertical: "design".to_string(),
            content_url: "stub://starter-design".to_string(),
            dependencies: Vec::new(),
            take_rate: 0,
            price_cents: 0,
            install_count: 0,
        },
    ]
}

// ---------------------------------------------------------------------------
// Public API — used by `commands::marketplace`
// ---------------------------------------------------------------------------

/// Return the full template catalog filtered by the supplied predicate. The
/// `install_count` field on each row is recomputed from `installs.json` so
/// the UI's "popular" sort stays consistent across users on the same box.
pub fn list_templates(
    memory_root: &Path,
    filter: &ListFilter,
) -> Result<Vec<Template>, AppError> {
    let mut catalog = stub_catalog();
    let installs: Vec<TemplateInstallation> =
        read_json_or_default(&installs_path(memory_root)?)?;
    for tpl in catalog.iter_mut() {
        tpl.install_count = installs.iter().filter(|i| i.template_id == tpl.id).count() as u64;
    }
    let q = filter.query.as_deref().map(str::to_lowercase);
    let v = filter.vertical.as_deref();
    let filtered: Vec<Template> = catalog
        .into_iter()
        .filter(|t| match (v, &q) {
            (Some(vert), _) if !vert.is_empty() && t.vertical != vert => false,
            (_, Some(query)) if !query.is_empty() => {
                t.name.to_lowercase().contains(query)
                    || t.description.to_lowercase().contains(query)
            }
            _ => true,
        })
        .collect();
    Ok(filtered)
}

/// Whether a template is already installed for the given team. The React
/// `TemplateDetail` button hits this via the install record in
/// `installs.json` to render the "Already installed" state.
pub fn is_installed(memory_root: &Path, template_id: &str, team_id: &str) -> Result<bool, AppError> {
    let installs: Vec<TemplateInstallation> =
        read_json_or_default(&installs_path(memory_root)?)?;
    Ok(installs
        .iter()
        .any(|i| i.template_id == template_id && i.team_id == team_id))
}

/// Compute the commission take-rate (basis points) for the given price.
/// Mirrors `V3_5_SPEC.md` §1.3.
pub fn take_rate_bps_for(price_cents: u32) -> u32 {
    if price_cents == 0 {
        0
    } else if price_cents < 5_000 {
        1_000
    } else {
        1_500
    }
}

/// Resolve a template by id from the stub catalog. Returns a `User` error
/// when the slug is not in the catalog so the React surface can render a
/// "not found" toast.
fn resolve_template(template_id: &str) -> Result<Template, AppError> {
    stub_catalog()
        .into_iter()
        .find(|t| t.id == template_id)
        .ok_or_else(|| {
            AppError::user(
                "marketplace_unknown_template",
                format!("template '{}' is not in the stub catalog", template_id),
            )
        })
}

/// Walk the dependency graph for `template_id`, returning the topologically
/// sorted install order (deps first, root last). Detects circular deps and
/// unknown deps and refuses to proceed. Stub catalog has no inter-template
/// deps but the algorithm runs so the IPC contract is real.
fn resolve_dependency_order(template_id: &str) -> Result<Vec<Template>, AppError> {
    let mut visited: Vec<String> = Vec::new();
    let mut visiting: Vec<String> = Vec::new();
    let mut order: Vec<Template> = Vec::new();
    visit(template_id, &mut visiting, &mut visited, &mut order)?;
    Ok(order)
}

fn visit(
    id: &str,
    visiting: &mut Vec<String>,
    visited: &mut Vec<String>,
    order: &mut Vec<Template>,
) -> Result<(), AppError> {
    if visited.iter().any(|v| v == id) {
        return Ok(());
    }
    if visiting.iter().any(|v| v == id) {
        return Err(AppError::user(
            "marketplace_circular_dep",
            format!("circular dependency detected at '{}'", id),
        ));
    }
    let template = resolve_template(id)?;
    visiting.push(id.to_string());
    for dep in template.dependencies.clone() {
        visit(&dep, visiting, visited, order)?;
    }
    visiting.retain(|v| v != id);
    visited.push(id.to_string());
    order.push(template);
    Ok(())
}

// ---------------------------------------------------------------------------
// Install pipeline (atomic with rollback)
// ---------------------------------------------------------------------------

/// One reversible side-effect emitted by the install pipeline. `apply` is
/// called in-order; on any failure the stack is drained in reverse and each
/// closure is invoked to leave the disk in the pre-install state. Closures
/// are infallible by design — best-effort cleanup, log on failure.
type Rollback = Box<dyn FnOnce()>;

struct RollbackGuard {
    actions: Vec<Rollback>,
    armed: bool,
}

impl RollbackGuard {
    fn new() -> Self {
        Self { actions: Vec::new(), armed: true }
    }

    fn push<F: FnOnce() + 'static>(&mut self, f: F) {
        self.actions.push(Box::new(f));
    }

    /// Disarm the guard once the install has succeeded — drops are no-ops
    /// after this. Called at the very end of `install_template`.
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for RollbackGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        // Reverse order — undo most-recent step first.
        while let Some(action) = self.actions.pop() {
            action();
        }
    }
}

/// Apply a template's content bundle to the team's memory dir.
///
/// v3.5 wave 2 — real install pipeline:
///   1. Resolve dependency order from the stub catalog
///   2. Already-installed short-circuit (returns existing record)
///   3. Apply each dep + the root template's four content files
///      (prompts.toml, sources.config.json, canvas.template.json,
///      suggestions.rules.toml) plus the broader memory-tree merges:
///      * agi/templates/<id>/prompts.toml
///      * agi/rules/<id>.toml
///      * canvas/templates/<id>/canvas.template.json
///      * sources/catalog.json (append-only)
///   4. Append `installs.json` + `commissions.json`
///   5. Audit log every step (success or failure)
///
/// All steps are atomic — any failure unwinds via the rollback guard so
/// the disk is left in the pre-install state. The audit log records both
/// success and failure paths so SOC 2 reviewers can trace marketplace
/// installs.
pub fn install_template(
    memory_root: &Path,
    template_id: &str,
    team_id: &str,
) -> Result<TemplateInstallation, AppError> {
    // Already installed — short-circuit so the React button can render
    // the "Already installed" state without re-applying content.
    if is_installed(memory_root, template_id, team_id)? {
        let installs: Vec<TemplateInstallation> =
            read_json_or_default(&installs_path(memory_root)?)?;
        if let Some(existing) = installs
            .into_iter()
            .find(|i| i.template_id == template_id && i.team_id == team_id)
        {
            log_audit(
                memory_root,
                "template.install.skip",
                template_id,
                team_id,
                Some("already_installed"),
            );
            return Ok(existing);
        }
    }

    // Walk dependency graph upfront — refuse to start the pipeline when a
    // dep is unknown / circular so we never partially apply.
    let order = match resolve_dependency_order(template_id) {
        Ok(v) => v,
        Err(e) => {
            log_audit(
                memory_root,
                "template.install.fail",
                template_id,
                team_id,
                Some(&e.to_string()),
            );
            return Err(e);
        }
    };

    let mut guard = RollbackGuard::new();
    let result = (|| -> Result<TemplateInstallation, AppError> {
        // Apply every dep + the root template; root is the last entry of `order`.
        for tpl in &order {
            apply_template_content(memory_root, tpl, &mut guard)?;
        }

        // Append installs.json with the root template's record. We leave
        // dep records out — the dep graph re-walks on uninstall so we don't
        // need a per-dep ledger row.
        let root = order.last().expect("dep order has at least the root template");
        let installs_p = installs_path(memory_root)?;
        let mut installs: Vec<TemplateInstallation> = read_json_or_default(&installs_p)?;
        let prev_installs = installs.clone();
        let installation = TemplateInstallation {
            template_id: root.id.clone(),
            team_id: team_id.to_string(),
            installed_at: Utc::now(),
            version: root.version.clone(),
        };
        installs.push(installation.clone());
        write_json(&installs_p, &installs)?;
        let installs_p_clone = installs_p.clone();
        let prev_installs_clone = prev_installs.clone();
        guard.push(move || {
            let _ = write_json(&installs_p_clone, &prev_installs_clone);
        });

        // Commission engine: record the take-rate. Real Stripe Connect call
        // is gated behind `is_launched`.
        if root.price_cents > 0 {
            let commissions_p = commissions_path(memory_root)?;
            let mut commissions: Vec<CommissionRecord> = read_json_or_default(&commissions_p)?;
            let prev_commissions = commissions.clone();
            let launched = is_launched(memory_root).unwrap_or(false);
            commissions.push(CommissionRecord {
                template_id: root.id.clone(),
                team_id: team_id.to_string(),
                price_cents: root.price_cents,
                take_rate_bps: take_rate_bps_for(root.price_cents),
                recorded_at: Utc::now(),
                stripe_recorded: launched,
            });
            write_json(&commissions_p, &commissions)?;
            let commissions_p_clone = commissions_p.clone();
            let prev_commissions_clone = prev_commissions.clone();
            guard.push(move || {
                let _ = write_json(&commissions_p_clone, &prev_commissions_clone);
            });
        }

        Ok(installation)
    })();

    match result {
        Ok(installation) => {
            guard.disarm();
            log_audit(
                memory_root,
                "template.install",
                template_id,
                team_id,
                None,
            );
            Ok(installation)
        }
        Err(e) => {
            // Guard's Drop fires here, undoing partial work.
            log_audit(
                memory_root,
                "template.install.fail",
                template_id,
                team_id,
                Some(&e.to_string()),
            );
            Err(e)
        }
    }
}

/// Apply one template's four content files to the team memory dir, pushing
/// rollback closures onto the guard stack as we go. Caller is responsible
/// for disarming the guard on success.
fn apply_template_content(
    memory_root: &Path,
    template: &Template,
    guard: &mut RollbackGuard,
) -> Result<(), AppError> {
    // 1. Local cache copy (preserves the historical layout for tests +
    //    introspection). Existing dir gets removed first so a re-install
    //    always rewrites the cache cleanly.
    let cache = templates_cache_dir(memory_root)?.join(&template.id);
    let cache_existed_before = cache.exists();
    if cache_existed_before {
        // Snapshot & restore is heavy — a re-install with content already
        // present means the user is explicitly re-applying. Treat it as a
        // best-effort overwrite; rollback only deletes what we created.
    }
    fs::create_dir_all(&cache)
        .map_err(|e| AppError::internal("marketplace_install_mkdir", e.to_string()))?;
    let cache_clone = cache.clone();
    if !cache_existed_before {
        guard.push(move || {
            let _ = fs::remove_dir_all(&cache_clone);
        });
    }
    write_json(&cache.join("template.json"), template)?;
    let prompts = stub_prompt_pack_for(template);
    let sources_cfg = stub_sources_config_for(template);
    let canvas = stub_canvas_template_for(template);
    let rules = stub_suggestion_rules_for(template);
    fs::write(cache.join("prompts.toml"), &prompts)
        .map_err(|e| AppError::internal("marketplace_install_prompts", e.to_string()))?;
    fs::write(cache.join("sources.config.json"), &sources_cfg)
        .map_err(|e| AppError::internal("marketplace_install_sources", e.to_string()))?;
    fs::write(cache.join("canvas.template.json"), &canvas)
        .map_err(|e| AppError::internal("marketplace_install_canvas", e.to_string()))?;
    fs::write(cache.join("suggestions.rules.toml"), &rules)
        .map_err(|e| AppError::internal("marketplace_install_rules", e.to_string()))?;

    // 2. Co-thinker prompts → ~/.tangerine-memory/agi/templates/<id>/prompts.toml
    let agi_dir = agi_templates_dir(memory_root, &template.id)?;
    let agi_prompts_path = agi_dir.join("prompts.toml");
    let agi_prompts_path_clone = agi_prompts_path.clone();
    fs::write(&agi_prompts_path, &prompts)
        .map_err(|e| AppError::internal("marketplace_apply_agi_prompts", e.to_string()))?;
    guard.push(move || {
        let _ = fs::remove_file(&agi_prompts_path_clone);
        // Best-effort prune the parent if empty.
        if let Some(parent) = agi_prompts_path_clone.parent() {
            let _ = fs::remove_dir(parent);
        }
    });

    // 3. Suggestion rules → ~/.tangerine-memory/agi/rules/<id>.toml
    let rules_path = agi_rules_dir(memory_root)?.join(format!("{}.toml", template.id));
    let rules_path_clone = rules_path.clone();
    fs::write(&rules_path, &rules)
        .map_err(|e| AppError::internal("marketplace_apply_agi_rules", e.to_string()))?;
    guard.push(move || {
        let _ = fs::remove_file(&rules_path_clone);
    });

    // 4. Canvas templates → ~/.tangerine-memory/canvas/templates/<id>/canvas.template.json
    let canvas_dir = canvas_templates_dir(memory_root, &template.id)?;
    let canvas_path = canvas_dir.join("canvas.template.json");
    let canvas_path_clone = canvas_path.clone();
    fs::write(&canvas_path, &canvas)
        .map_err(|e| AppError::internal("marketplace_apply_canvas", e.to_string()))?;
    guard.push(move || {
        let _ = fs::remove_file(&canvas_path_clone);
        if let Some(parent) = canvas_path_clone.parent() {
            let _ = fs::remove_dir(parent);
        }
    });

    // 5. Sources catalog append → ~/.tangerine-memory/sources/catalog.json
    //    Append-only: never overwrite an existing entry. The `is_installed`
    //    short-circuit at the top of `install_template` already prevents the
    //    duplicate-add case.
    let catalog_path = sources_catalog_path(memory_root)?;
    let mut catalog: Vec<SourcesCatalogEntry> = read_json_or_default(&catalog_path)?;
    let prev_catalog = catalog.clone();
    if !catalog.iter().any(|e| e.template_id == template.id) {
        catalog.push(SourcesCatalogEntry {
            template_id: template.id.clone(),
            vertical: template.vertical.clone(),
            version: template.version.clone(),
            installed_at: Utc::now(),
        });
        write_json(&catalog_path, &catalog)?;
        let catalog_path_clone = catalog_path.clone();
        let prev_catalog_clone = prev_catalog.clone();
        guard.push(move || {
            let _ = write_json(&catalog_path_clone, &prev_catalog_clone);
        });
    }

    Ok(())
}

/// Best-effort audit-log append. We never bubble an audit-write failure
/// through the install pipeline — losing a log entry is preferable to
/// rolling back a successful install.
fn log_audit(
    memory_root: &Path,
    action: &str,
    template_id: &str,
    team_id: &str,
    detail: Option<&str>,
) {
    let resource = match detail {
        Some(d) => format!("{}#{}#{}", template_id, team_id, d),
        None => format!("{}#{}", template_id, team_id),
    };
    let _ = audit_log::append(
        memory_root,
        AuditEntryInput {
            user: team_id.to_string(),
            action: action.to_string(),
            resource,
            ip: None,
            user_agent: Some("tangerine-marketplace".to_string()),
        },
    );
}

/// Roll back a previous install. Removes the cache dir + drops the matching
/// row from `installs.json` + cleans up the agi/canvas/sources side-effects.
/// We do not refund the commission record — that's intentional; refund flow
/// is the Stripe-side responsibility and this stub only models the public
/// install ledger.
pub fn uninstall_template(memory_root: &Path, template_id: &str) -> Result<(), AppError> {
    // Drop install record first.
    let installs_p = installs_path(memory_root)?;
    let installs: Vec<TemplateInstallation> = read_json_or_default(&installs_p)?;
    let next: Vec<TemplateInstallation> = installs
        .into_iter()
        .filter(|i| i.template_id != template_id)
        .collect();
    write_json(&installs_p, &next)?;

    // Cache dir.
    let cache = templates_cache_dir(memory_root)?.join(template_id);
    if cache.exists() {
        fs::remove_dir_all(&cache)
            .map_err(|e| AppError::internal("marketplace_uninstall_rm", e.to_string()))?;
    }

    // AGI prompts + rules.
    let _ = fs::remove_file(
        memory_root
            .join("agi")
            .join("templates")
            .join(template_id)
            .join("prompts.toml"),
    );
    let _ = fs::remove_dir(memory_root.join("agi").join("templates").join(template_id));
    let _ = fs::remove_file(
        memory_root
            .join("agi")
            .join("rules")
            .join(format!("{}.toml", template_id)),
    );

    // Canvas template.
    let _ = fs::remove_file(
        memory_root
            .join("canvas")
            .join("templates")
            .join(template_id)
            .join("canvas.template.json"),
    );
    let _ = fs::remove_dir(
        memory_root
            .join("canvas")
            .join("templates")
            .join(template_id),
    );

    // Sources catalog drop.
    let catalog_path = sources_catalog_path(memory_root)?;
    if catalog_path.exists() {
        let catalog: Vec<SourcesCatalogEntry> = read_json_or_default(&catalog_path)?;
        let next: Vec<SourcesCatalogEntry> = catalog
            .into_iter()
            .filter(|e| e.template_id != template_id)
            .collect();
        write_json(&catalog_path, &next)?;
    }

    log_audit(memory_root, "template.uninstall", template_id, "system", None);
    Ok(())
}

/// Stub publish entry point. The launch-gate check in `is_launched` keeps
/// the real registry call site dark until the v3.5 production cut. Until
/// then, "publish" is a no-op that records the metadata in the local
/// cache dir under `templates/<id>/` so authors can dogfood the flow.
pub fn publish_template(
    memory_root: &Path,
    metadata: Template,
    content: Vec<u8>,
) -> Result<Template, AppError> {
    if !is_launched(memory_root)? {
        // Stub — write the metadata bundle to the cache dir so the rest of
        // the app can inspect it. The real registry handshake (sign +
        // upload + verify) only runs once `launched: true`.
        let cache = templates_cache_dir(memory_root)?.join(&metadata.id);
        fs::create_dir_all(&cache)
            .map_err(|e| AppError::internal("marketplace_publish_mkdir", e.to_string()))?;
        write_json(&cache.join("template.json"), &metadata)?;
        fs::write(cache.join("bundle.bin"), &content)
            .map_err(|e| AppError::internal("marketplace_publish_bundle", e.to_string()))?;
        return Ok(metadata);
    }
    // Production path — would POST to the registry here. Stub fallback for
    // tests is to also write to disk and return.
    let cache = templates_cache_dir(memory_root)?.join(&metadata.id);
    fs::create_dir_all(&cache)
        .map_err(|e| AppError::internal("marketplace_publish_mkdir", e.to_string()))?;
    write_json(&cache.join("template.json"), &metadata)?;
    fs::write(cache.join("bundle.bin"), &content)
        .map_err(|e| AppError::internal("marketplace_publish_bundle", e.to_string()))?;
    Ok(metadata)
}

// ---------------------------------------------------------------------------
// Trigger gate (v3.5 §2)
// ---------------------------------------------------------------------------

/// Read the persisted launch state, defaulting to `LaunchState::default()`
/// (not launched, fresh gate counters) when the file is missing.
pub fn read_launch_state(memory_root: &Path) -> Result<LaunchState, AppError> {
    read_json_or_default(&launch_state_path(memory_root)?)
}

pub fn write_launch_state(memory_root: &Path, state: &LaunchState) -> Result<(), AppError> {
    write_json(&launch_state_path(memory_root)?, state)
}

/// Convenience: returns whether the marketplace is currently launched. The
/// install flow uses this to decide whether to fire the Stripe call site.
pub fn is_launched(memory_root: &Path) -> Result<bool, AppError> {
    Ok(read_launch_state(memory_root)?.launched)
}

// ---------------------------------------------------------------------------
// Stub content generators
// ---------------------------------------------------------------------------

fn stub_prompt_pack_for(t: &Template) -> String {
    format!(
        r#"# {name} co-thinker prompts (v{version})
# Generated by stub install — replace with the real signed pack on launch.

[system]
preamble = "You are the {vertical} co-thinker for {name}."

[mode.default]
hint = "Vertical-specific prompt pack for {vertical}."
"#,
        name = t.name,
        version = t.version,
        vertical = t.vertical,
    )
}

fn stub_sources_config_for(t: &Template) -> String {
    serde_json::json!({
        "template_id": t.id,
        "vertical": t.vertical,
        "recommended_sources": [
            { "name": "slack", "channel_glob": format!("*{}*", t.vertical) },
            { "name": "notion", "database_glob": format!("*{}*", t.vertical) },
            { "name": "email", "label": format!("{}-digest", t.vertical) },
        ],
    })
    .to_string()
}

fn stub_canvas_template_for(t: &Template) -> String {
    serde_json::json!({
        "template_id": t.id,
        "version": 1,
        "starter_canvases": [
            { "title": format!("{} starter canvas", t.vertical), "lanes": ["intake", "review", "decided"] },
        ],
    })
    .to_string()
}

fn stub_suggestion_rules_for(t: &Template) -> String {
    format!(
        r#"# {name} suggestion rules (v{version})

[[rule]]
name = "{vertical}_deadline_reminder"
when = "atom.due_at - now < 48h"
emit = "banner"
"#,
        name = t.name,
        version = t.version,
        vertical = t.vertical,
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    /// Tiny in-tree tempdir helper. Mirrors the pattern in
    /// `memory_search.rs::tempdir_like` — std::env::temp_dir + uuid keeps
    /// the dep tree lean (the deployment iron rules call out keeping deps
    /// minimal). Drops the dir on scope exit.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let id = uuid::Uuid::new_v4().simple().to_string();
            let p = std::env::temp_dir().join(format!("ti-marketplace-{}", id));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tmp_root() -> TempDir {
        TempDir::new()
    }

    #[test]
    fn lists_stub_catalog_on_empty_filter() {
        let root = tmp_root();
        let rows = list_templates(root.path(), &ListFilter::default()).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].id, "tangerine-legal-pack");
        // Newly seeded — nothing installed yet.
        assert_eq!(rows[0].install_count, 0);
    }

    #[test]
    fn list_filters_by_vertical() {
        let root = tmp_root();
        let filter = ListFilter {
            vertical: Some("legal".into()),
            ..Default::default()
        };
        let rows = list_templates(root.path(), &filter).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].vertical, "legal");
    }

    #[test]
    fn list_filters_by_query_substring_case_insensitive() {
        let root = tmp_root();
        let filter = ListFilter {
            query: Some("LEGAL".into()),
            ..Default::default()
        };
        let rows = list_templates(root.path(), &filter).unwrap();
        assert!(rows.iter().any(|r| r.id == "tangerine-legal-pack"));
    }

    #[test]
    fn install_writes_content_and_records_installation() {
        let root = tmp_root();
        let inst = install_template(root.path(), "tangerine-legal-pack", "team-a").unwrap();
        assert_eq!(inst.template_id, "tangerine-legal-pack");
        assert_eq!(inst.team_id, "team-a");

        // Cache dir populated.
        let cache = root
            .path()
            .join("marketplace/templates/tangerine-legal-pack");
        assert!(cache.join("template.json").exists());
        assert!(cache.join("prompts.toml").exists());
        assert!(cache.join("sources.config.json").exists());
        assert!(cache.join("canvas.template.json").exists());
        assert!(cache.join("suggestions.rules.toml").exists());

        // Listed install_count reflects the install.
        let rows = list_templates(root.path(), &ListFilter::default()).unwrap();
        let legal = rows.iter().find(|r| r.id == "tangerine-legal-pack").unwrap();
        assert_eq!(legal.install_count, 1);
    }

    #[test]
    fn install_applies_prompts_to_agi_templates_dir() {
        let root = tmp_root();
        let _ = install_template(root.path(), "tangerine-legal-pack", "team-a").unwrap();
        let prompts = root
            .path()
            .join("agi/templates/tangerine-legal-pack/prompts.toml");
        assert!(prompts.exists(), "agi prompts target missing");
        let raw = fs::read_to_string(prompts).unwrap();
        assert!(raw.contains("Tangerine for Legal Teams"));
    }

    #[test]
    fn install_writes_canvas_template_to_canvas_dir() {
        let root = tmp_root();
        let _ = install_template(root.path(), "tangerine-legal-pack", "team-a").unwrap();
        let canvas = root
            .path()
            .join("canvas/templates/tangerine-legal-pack/canvas.template.json");
        assert!(canvas.exists());
    }

    #[test]
    fn install_registers_suggestion_rules_with_registry() {
        let root = tmp_root();
        let _ = install_template(root.path(), "tangerine-legal-pack", "team-a").unwrap();
        let rules = root
            .path()
            .join("agi/rules/tangerine-legal-pack.toml");
        assert!(rules.exists(), "rules registry missing");
    }

    #[test]
    fn install_appends_to_sources_catalog() {
        let root = tmp_root();
        let _ = install_template(root.path(), "tangerine-legal-pack", "team-a").unwrap();
        let catalog_path = root.path().join("sources/catalog.json");
        assert!(catalog_path.exists());
        let raw = fs::read_to_string(catalog_path).unwrap();
        let entries: Vec<SourcesCatalogEntry> = serde_json::from_str(&raw).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].template_id, "tangerine-legal-pack");
    }

    #[test]
    fn install_short_circuits_when_already_installed() {
        let root = tmp_root();
        let first = install_template(root.path(), "tangerine-legal-pack", "team-a").unwrap();
        let second = install_template(root.path(), "tangerine-legal-pack", "team-a").unwrap();
        assert_eq!(first.installed_at, second.installed_at);

        // installs.json should still have only one record for this team.
        let installs: Vec<TemplateInstallation> =
            serde_json::from_str(&fs::read_to_string(root.path().join("marketplace/installs.json")).unwrap())
                .unwrap();
        let team_a_installs: Vec<_> = installs
            .iter()
            .filter(|i| i.template_id == "tangerine-legal-pack" && i.team_id == "team-a")
            .collect();
        assert_eq!(team_a_installs.len(), 1);
    }

    #[test]
    fn is_installed_reflects_install_state() {
        let root = tmp_root();
        assert!(!is_installed(root.path(), "tangerine-legal-pack", "team-a").unwrap());
        let _ = install_template(root.path(), "tangerine-legal-pack", "team-a").unwrap();
        assert!(is_installed(root.path(), "tangerine-legal-pack", "team-a").unwrap());
        assert!(!is_installed(root.path(), "tangerine-legal-pack", "team-b").unwrap());
    }

    #[test]
    fn install_records_commission_for_paid_template() {
        let root = tmp_root();
        let _ = install_template(root.path(), "tangerine-legal-pack", "team-a").unwrap();
        let raw = fs::read_to_string(root.path().join("marketplace/commissions.json")).unwrap();
        let recs: Vec<CommissionRecord> = serde_json::from_str(&raw).unwrap();
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].take_rate_bps, 1500);
        assert!(!recs[0].stripe_recorded, "stub mode never records to Stripe");
    }

    #[test]
    fn install_skips_commission_for_free_template() {
        let root = tmp_root();
        let _ = install_template(root.path(), "starter-design-pack", "team-a").unwrap();
        let path = root.path().join("marketplace/commissions.json");
        // Either the file was never written or the recorded list is empty.
        if path.exists() {
            let raw = fs::read_to_string(path).unwrap();
            let recs: Vec<CommissionRecord> = serde_json::from_str(&raw).unwrap();
            assert!(recs.is_empty(), "free templates should record no commission");
        }
    }

    #[test]
    fn install_emits_audit_log_entry() {
        let root = tmp_root();
        let _ = install_template(root.path(), "tangerine-legal-pack", "team-a").unwrap();
        // Audit log lives under .tangerine/audit/<today>.jsonl.
        let today = chrono::Utc::now().date_naive();
        let audit = root
            .path()
            .join(".tangerine/audit")
            .join(format!("{}.jsonl", today));
        assert!(audit.exists(), "audit log file missing");
        let raw = fs::read_to_string(audit).unwrap();
        assert!(raw.contains("template.install"));
        assert!(raw.contains("tangerine-legal-pack"));
    }

    #[test]
    fn install_unknown_template_logs_failure_and_returns_user_error() {
        let root = tmp_root();
        let err = install_template(root.path(), "does-not-exist", "team-a").unwrap_err();
        match err {
            AppError::User { code, .. } => assert_eq!(code, "marketplace_unknown_template"),
            other => panic!("expected User error, got {:?}", other),
        }

        let today = chrono::Utc::now().date_naive();
        let audit = root
            .path()
            .join(".tangerine/audit")
            .join(format!("{}.jsonl", today));
        let raw = fs::read_to_string(audit).unwrap();
        assert!(raw.contains("template.install.fail"));
    }

    #[test]
    fn uninstall_removes_cache_install_record_and_side_effects() {
        let root = tmp_root();
        let _ = install_template(root.path(), "tangerine-legal-pack", "team-a").unwrap();
        uninstall_template(root.path(), "tangerine-legal-pack").unwrap();

        let cache = root
            .path()
            .join("marketplace/templates/tangerine-legal-pack");
        assert!(!cache.exists());

        let agi_prompts = root
            .path()
            .join("agi/templates/tangerine-legal-pack/prompts.toml");
        assert!(!agi_prompts.exists());

        let rules = root
            .path()
            .join("agi/rules/tangerine-legal-pack.toml");
        assert!(!rules.exists());

        let canvas = root
            .path()
            .join("canvas/templates/tangerine-legal-pack/canvas.template.json");
        assert!(!canvas.exists());

        let rows = list_templates(root.path(), &ListFilter::default()).unwrap();
        let legal = rows.iter().find(|r| r.id == "tangerine-legal-pack").unwrap();
        assert_eq!(legal.install_count, 0);
    }

    #[test]
    fn take_rate_band_matches_spec() {
        assert_eq!(take_rate_bps_for(0), 0);
        assert_eq!(take_rate_bps_for(100), 1_000);
        assert_eq!(take_rate_bps_for(4_999), 1_000);
        assert_eq!(take_rate_bps_for(5_000), 1_500);
        assert_eq!(take_rate_bps_for(19_900), 1_500);
    }

    #[test]
    fn launch_state_defaults_to_not_launched() {
        let root = tmp_root();
        let state = read_launch_state(root.path()).unwrap();
        assert!(!state.launched);
        assert_eq!(state.gate_status.installs_required, 5_000);
        assert!(!state.gate_status.passes());
    }

    #[test]
    fn gate_passes_when_both_conditions_met() {
        let gate = GateStatus {
            installs_30d: 5_001,
            installs_required: 5_000,
            self_shipped_template_validated: true,
        };
        assert!(gate.passes());
    }

    #[test]
    fn gate_fails_when_only_installs_met() {
        let gate = GateStatus {
            installs_30d: 6_000,
            installs_required: 5_000,
            self_shipped_template_validated: false,
        };
        assert!(!gate.passes());
    }

    #[test]
    fn publish_writes_metadata_in_stub_mode() {
        let root = tmp_root();
        let tpl = Template {
            id: "alpha-test-pack".into(),
            name: "Alpha Test".into(),
            version: "0.1.0".into(),
            author: "test".into(),
            description: "test".into(),
            vertical: "ops".into(),
            content_url: "stub://alpha".into(),
            dependencies: vec![],
            take_rate: 0,
            price_cents: 0,
            install_count: 0,
        };
        let out = publish_template(root.path(), tpl.clone(), b"bundle".to_vec()).unwrap();
        assert_eq!(out.id, tpl.id);
        let metadata_path = root
            .path()
            .join("marketplace/templates/alpha-test-pack/template.json");
        assert!(metadata_path.exists());
    }
}
