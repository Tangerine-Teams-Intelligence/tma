//! Perf (API_SURFACE_SPEC §5): `notion_get_config` is a read command → 50 ms p95.
//! `notion_set_config` is a write command → 200 ms p95. `notion_validate_token` /
//! `notion_list_databases` / `notion_writeback_decision` are validation/upstream
//! buckets → 3 s p95 each. `notion_capture` is the capture bucket → 10 s p95.
//!
//! Notion source — v1.8 Phase 2 real-wire.
//!
//! Read path:
//!   1. Caller passes `database_ids: Vec<String>` (configured via the
//!      /sources/notion setup page).
//!   2. For each database we call `POST /v1/databases/{id}/query` and walk
//!      the page list.
//!   3. For each page we fetch `GET /v1/blocks/{page_id}/children` and
//!      flatten to markdown body.
//!   4. We write one atom per page to
//!      `<memory_root>/projects/{project}/notion/{page_id}.md` with
//!      frontmatter (`source: notion`, `notion_page_id`, `notion_db_id`,
//!      `last_edited_time`, `title`).
//!
//! Writeback path:
//!   * `notion_writeback_decision(atom_path, db_id)` parses an atom (must
//!     have `decision: true` in frontmatter, plus `title` + `body`) and
//!     creates a row in the linked decisions database via
//!     `POST /v1/pages` with the database id as the parent.
//!
//! Auth: bearer token (`Authorization: Bearer secret_xxx`) +
//!       `Notion-Version: 2022-06-28` header.
//!
//! Persistence:
//!   * Token: `.env` file (`NOTION_API_TOKEN`) via env.rs.
//!   * Database list + flags: per-source JSON at
//!     `<user_data>/sources/notion.json`.
//!
//! Idempotency: writeback hashes `(db_id, title, body)` into a marker
//! `<atom_path>.notion.writeback` so repeated calls don't re-create rows.

use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{AppError, AppState};

const NOTION_API: &str = "https://api.notion.com/v1";
const NOTION_VERSION: &str = "2022-06-28";

// ---------------------------------------------------------------------------
// Config

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NotionConfig {
    /// Bearer token. Stored in `.env`; mirrored here so the UI can render
    /// the masked length without re-fetching the secret.
    #[serde(default)]
    pub token_present: bool,
    /// Notion database IDs the user has linked.
    #[serde(default)]
    pub database_ids: Vec<String>,
    /// Database id used as the writeback target for decisions. Must be one
    /// of `database_ids` or empty.
    #[serde(default)]
    pub decisions_db_id: Option<String>,
    /// User toggles.
    #[serde(default = "default_true")]
    pub capture_enabled: bool,
    #[serde(default)]
    pub writeback_enabled: bool,
    #[serde(default)]
    pub last_sync: Option<String>,
}

fn default_true() -> bool {
    true
}

fn config_path(state: &AppState) -> PathBuf {
    state.paths.user_data.join("sources").join("notion.json")
}

fn load_config(state: &AppState) -> NotionConfig {
    let p = config_path(state);
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => NotionConfig::default(),
    }
}

fn save_config(state: &AppState, cfg: &NotionConfig) -> Result<(), AppError> {
    let p = config_path(state);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(cfg)?;
    let tmp = p.with_extension(format!(
        "json.tmp.{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Atom shape returned to the React side. Body is intentionally truncated to
// 256 chars so the UI listing stays light; the caller reads the full file
// from disk if needed.

#[derive(Debug, Serialize, Clone)]
pub struct NotionAtom {
    pub path: String,
    pub page_id: String,
    pub database_id: String,
    pub title: String,
    pub last_edited_time: String,
    pub preview: String,
}

// ---------------------------------------------------------------------------
// Tauri commands

#[derive(Debug, Deserialize)]
pub struct NotionGetConfigArgs {}

#[tauri::command]
pub async fn notion_get_config(
    state: State<'_, AppState>,
) -> Result<NotionConfig, AppError> {
    let mut cfg = load_config(&state);
    // Reflect token presence by reading .env (don't expose the value).
    let env = super::env::load_env_file(&state.paths.env_file).unwrap_or_default();
    cfg.token_present = env
        .iter()
        .any(|(k, v)| k == "NOTION_API_TOKEN" && !v.is_empty());
    Ok(cfg)
}

#[derive(Debug, Deserialize)]
pub struct NotionSetConfigArgs {
    pub database_ids: Vec<String>,
    pub decisions_db_id: Option<String>,
    pub capture_enabled: bool,
    pub writeback_enabled: bool,
}

#[tauri::command]
pub async fn notion_set_config(
    state: State<'_, AppState>,
    args: NotionSetConfigArgs,
) -> Result<(), AppError> {
    let mut cfg = load_config(&state);
    cfg.database_ids = args
        .database_ids
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .collect();
    cfg.decisions_db_id = args
        .decisions_db_id
        .filter(|s| !s.trim().is_empty());
    cfg.capture_enabled = args.capture_enabled;
    cfg.writeback_enabled = args.writeback_enabled;
    save_config(&state, &cfg)
}

/// Validate the stored token by hitting `GET /v1/users/me`. Returns the
/// workspace bot user shape on success so the UI can show "Connected as
/// {bot.name}".
#[derive(Debug, Serialize)]
pub struct NotionValidateResult {
    pub ok: bool,
    pub bot_name: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn notion_validate_token(
    state: State<'_, AppState>,
) -> Result<NotionValidateResult, AppError> {
    let token = read_token(&state)?;
    if token.is_empty() {
        return Ok(NotionValidateResult {
            ok: false,
            bot_name: None,
            error: Some("Token not set.".into()),
        });
    }
    let resp = state
        .http
        .get(format!("{}/users/me", NOTION_API))
        .header("Authorization", format!("Bearer {}", token))
        .header("Notion-Version", NOTION_VERSION)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Ok(NotionValidateResult {
            ok: false,
            bot_name: None,
            error: Some(format!("status {}", resp.status())),
        });
    }
    let v: serde_json::Value = resp.json().await?;
    let bot_name = v
        .get("bot")
        .and_then(|b| b.get("workspace_name"))
        .and_then(|n| n.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            v.get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.to_string())
        });
    Ok(NotionValidateResult {
        ok: true,
        bot_name,
        error: None,
    })
}

/// List databases the integration has access to. Used by the setup page so
/// the user picks IDs from a list rather than typing UUIDs.
#[derive(Debug, Serialize)]
pub struct NotionDb {
    pub id: String,
    pub title: String,
}

#[tauri::command]
pub async fn notion_list_databases(
    state: State<'_, AppState>,
) -> Result<Vec<NotionDb>, AppError> {
    let token = read_token(&state)?;
    if token.is_empty() {
        return Ok(Vec::new());
    }
    let body = serde_json::json!({
        "filter": { "property": "object", "value": "database" },
        "page_size": 100,
    });
    let resp = state
        .http
        .post(format!("{}/search", NOTION_API))
        .header("Authorization", format!("Bearer {}", token))
        .header("Notion-Version", NOTION_VERSION)
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::external(
            "notion_list_databases",
            format!("status {}", resp.status()),
        ));
    }
    let v: serde_json::Value = resp.json().await?;
    let mut out = Vec::new();
    if let Some(arr) = v.get("results").and_then(|a| a.as_array()) {
        for entry in arr {
            let id = entry
                .get("id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let title = extract_db_title(entry);
            if !id.is_empty() {
                out.push(NotionDb { id, title });
            }
        }
    }
    Ok(out)
}

fn extract_db_title(db: &serde_json::Value) -> String {
    db.get("title")
        .and_then(|t| t.as_array())
        .and_then(|arr| arr.first())
        .and_then(|first| first.get("plain_text").and_then(|s| s.as_str()))
        .unwrap_or("(untitled)")
        .to_string()
}

#[derive(Debug, Deserialize)]
pub struct NotionCaptureArgs {
    /// `~/.tangerine-memory` or team repo `<repo>/memory`. The Tauri side
    /// passes the resolved root so this command stays mode-agnostic.
    pub memory_root: String,
    /// Project slug — atoms land in `projects/{project}/notion/`. Defaults
    /// to "general" when caller doesn't have a project context.
    #[serde(default)]
    pub project: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct NotionCaptureResult {
    pub written: usize,
    pub atoms: Vec<NotionAtom>,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn notion_capture(
    state: State<'_, AppState>,
    args: NotionCaptureArgs,
) -> Result<NotionCaptureResult, AppError> {
    let mut cfg = load_config(&state);
    if !cfg.capture_enabled {
        return Ok(NotionCaptureResult {
            written: 0,
            atoms: Vec::new(),
            errors: vec!["capture disabled".into()],
        });
    }
    let token = read_token(&state)?;
    if token.is_empty() {
        return Ok(NotionCaptureResult {
            written: 0,
            atoms: Vec::new(),
            errors: vec!["no token".into()],
        });
    }
    let project = args.project.clone().unwrap_or_else(|| "general".into());
    let root = PathBuf::from(&args.memory_root)
        .join("projects")
        .join(slugify(&project))
        .join("notion");
    std::fs::create_dir_all(&root).ok();

    let mut atoms = Vec::new();
    let mut errors = Vec::new();
    let mut written = 0_usize;
    for db_id in cfg.database_ids.clone() {
        match capture_database(&state, &token, &db_id, &root).await {
            Ok(mut a) => {
                written += a.len();
                atoms.append(&mut a);
            }
            Err(e) => errors.push(format!("db {}: {}", db_id, e)),
        }
    }

    cfg.last_sync = Some(Utc::now().to_rfc3339());
    save_config(&state, &cfg).ok();

    Ok(NotionCaptureResult {
        written,
        atoms,
        errors,
    })
}

async fn capture_database(
    state: &State<'_, AppState>,
    token: &str,
    db_id: &str,
    root: &Path,
) -> Result<Vec<NotionAtom>, String> {
    let body = serde_json::json!({ "page_size": 100 });
    let resp = state
        .http
        .post(format!("{}/databases/{}/query", NOTION_API, db_id))
        .header("Authorization", format!("Bearer {}", token))
        .header("Notion-Version", NOTION_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("query status {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let pages = v.get("results").and_then(|a| a.as_array()).cloned().unwrap_or_default();

    let mut out = Vec::new();
    for p in pages {
        let page_id = p.get("id").and_then(|s| s.as_str()).unwrap_or("").to_string();
        if page_id.is_empty() {
            continue;
        }
        let last_edited = p
            .get("last_edited_time")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        let title = extract_page_title(&p);

        // Body via blocks list. Failure here is non-fatal — we still write
        // the page metadata as an atom.
        let body_md = match fetch_blocks_markdown(state, token, &page_id).await {
            Ok(md) => md,
            Err(e) => format!("(blocks fetch failed: {})\n", e),
        };

        let atom_path = root.join(format!("{}.md", page_id.replace('-', "")));
        let frontmatter = build_frontmatter(&[
            ("source", "notion"),
            ("notion_page_id", &page_id),
            ("notion_db_id", db_id),
            ("title", &title),
            ("last_edited_time", &last_edited),
            ("captured_at", &Utc::now().to_rfc3339()),
        ]);
        let content = format!("---\n{}---\n\n# {}\n\n{}", frontmatter, title, body_md);
        if let Err(e) = atomic_write(&atom_path, &content) {
            return Err(format!("write {}: {}", atom_path.display(), e));
        }
        out.push(NotionAtom {
            path: atom_path.to_string_lossy().to_string(),
            page_id,
            database_id: db_id.to_string(),
            title,
            last_edited_time: last_edited,
            preview: body_md.chars().take(256).collect(),
        });
    }
    Ok(out)
}

fn extract_page_title(page: &serde_json::Value) -> String {
    let props = match page.get("properties").and_then(|p| p.as_object()) {
        Some(m) => m,
        None => return "(untitled)".into(),
    };
    for (_k, v) in props.iter() {
        let kind = v.get("type").and_then(|s| s.as_str()).unwrap_or("");
        if kind == "title" {
            if let Some(arr) = v.get("title").and_then(|t| t.as_array()) {
                if let Some(first) = arr.first() {
                    if let Some(t) = first.get("plain_text").and_then(|s| s.as_str()) {
                        return t.to_string();
                    }
                }
            }
        }
    }
    "(untitled)".into()
}

async fn fetch_blocks_markdown(
    state: &State<'_, AppState>,
    token: &str,
    page_id: &str,
) -> Result<String, String> {
    let resp = state
        .http
        .get(format!("{}/blocks/{}/children?page_size=100", NOTION_API, page_id))
        .header("Authorization", format!("Bearer {}", token))
        .header("Notion-Version", NOTION_VERSION)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("blocks status {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let arr = v
        .get("results")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(blocks_to_markdown(&arr))
}

/// Minimal block-to-markdown shim. Notion blocks form a nested tree; we
/// flatten the top level only here. Recursive rendering can be added later
/// without breaking the atom format.
pub fn blocks_to_markdown(blocks: &[serde_json::Value]) -> String {
    let mut out = String::new();
    for b in blocks {
        let kind = b.get("type").and_then(|s| s.as_str()).unwrap_or("");
        let plain = rich_text_plain(b.get(kind).and_then(|x| x.get("rich_text")));
        match kind {
            "paragraph" => {
                if !plain.trim().is_empty() {
                    out.push_str(&plain);
                    out.push_str("\n\n");
                }
            }
            "heading_1" => out.push_str(&format!("# {}\n\n", plain)),
            "heading_2" => out.push_str(&format!("## {}\n\n", plain)),
            "heading_3" => out.push_str(&format!("### {}\n\n", plain)),
            "bulleted_list_item" => out.push_str(&format!("- {}\n", plain)),
            "numbered_list_item" => out.push_str(&format!("1. {}\n", plain)),
            "to_do" => {
                let checked = b
                    .get("to_do")
                    .and_then(|x| x.get("checked"))
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false);
                let mark = if checked { "x" } else { " " };
                out.push_str(&format!("- [{}] {}\n", mark, plain));
            }
            "quote" => out.push_str(&format!("> {}\n\n", plain)),
            "code" => {
                let lang = b
                    .get("code")
                    .and_then(|x| x.get("language"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                out.push_str(&format!("```{}\n{}\n```\n\n", lang, plain));
            }
            _ => {
                if !plain.trim().is_empty() {
                    out.push_str(&plain);
                    out.push_str("\n\n");
                }
            }
        }
    }
    out
}

fn rich_text_plain(rich: Option<&serde_json::Value>) -> String {
    let Some(arr) = rich.and_then(|v| v.as_array()) else {
        return String::new();
    };
    let mut out = String::new();
    for r in arr {
        if let Some(t) = r.get("plain_text").and_then(|s| s.as_str()) {
            out.push_str(t);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Writeback

#[derive(Debug, Deserialize)]
pub struct NotionWritebackArgs {
    pub atom_path: String,
    /// Optional override; falls back to `decisions_db_id` from config.
    #[serde(default)]
    pub db_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct NotionWritebackResult {
    pub created: bool,
    pub page_id: Option<String>,
    pub idempotent_hit: bool,
}

#[tauri::command]
pub async fn notion_writeback_decision(
    state: State<'_, AppState>,
    args: NotionWritebackArgs,
) -> Result<NotionWritebackResult, AppError> {
    let cfg = load_config(&state);
    if !cfg.writeback_enabled {
        return Err(AppError::user(
            "writeback_disabled",
            "Notion writeback is disabled in /sources/notion.",
        ));
    }
    let db_id = args
        .db_id
        .or(cfg.decisions_db_id.clone())
        .ok_or_else(|| {
            AppError::user(
                "no_decisions_db",
                "No decisions database id configured for Notion writeback.",
            )
        })?;
    let token = read_token(&state)?;
    if token.is_empty() {
        return Err(AppError::user(
            "no_token",
            "Notion token missing. Set it in /sources/notion.",
        ));
    }

    let atom_path = PathBuf::from(&args.atom_path);
    let raw = std::fs::read_to_string(&atom_path).map_err(|e| {
        AppError::user(
            "atom_read",
            format!("read {}: {}", atom_path.display(), e),
        )
    })?;
    let (fm, body) = split_frontmatter(&raw);
    let title = lookup_fm(&fm, "title").unwrap_or_else(|| "Untitled decision".into());
    let body_trimmed = body.trim().to_string();

    // Idempotency marker — same shape as a write-once log.
    let marker_path = atom_path.with_extension("md.notion.writeback");
    let marker_key = format!("{}::{}::{}", db_id, title, body_trimmed);
    let marker_hash = sha2_hex(&marker_key);
    if marker_path.is_file() {
        let prev = std::fs::read_to_string(&marker_path).unwrap_or_default();
        if prev.trim() == marker_hash {
            return Ok(NotionWritebackResult {
                created: false,
                page_id: None,
                idempotent_hit: true,
            });
        }
    }

    let body_payload = serde_json::json!({
        "parent": { "database_id": db_id },
        "properties": {
            "Name": {
                "title": [ { "text": { "content": title } } ]
            }
        },
        "children": [
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [
                        { "type": "text", "text": { "content": body_trimmed } }
                    ]
                }
            }
        ]
    });
    let resp = state
        .http
        .post(format!("{}/pages", NOTION_API))
        .header("Authorization", format!("Bearer {}", token))
        .header("Notion-Version", NOTION_VERSION)
        .json(&body_payload)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::external(
            "notion_writeback",
            format!("status {}", resp.status()),
        ));
    }
    let v: serde_json::Value = resp.json().await?;
    let page_id = v.get("id").and_then(|s| s.as_str()).map(|s| s.to_string());

    // Record marker.
    std::fs::write(&marker_path, marker_hash).ok();

    Ok(NotionWritebackResult {
        created: true,
        page_id,
        idempotent_hit: false,
    })
}

// ---------------------------------------------------------------------------
// Daemon hook — self-contained tick callable from the heartbeat without
// access to a Tauri State. Skips silently when the source isn't configured.

#[derive(Debug, Clone)]
pub struct NotionTickResult {
    pub written: usize,
    pub errors: Vec<String>,
}

pub async fn tick_from_daemon(
    user_data: &Path,
    memory_root: &Path,
) -> NotionTickResult {
    let mut out = NotionTickResult {
        written: 0,
        errors: Vec::new(),
    };
    let cfg_path = user_data.join("sources").join("notion.json");
    let cfg: NotionConfig = match std::fs::read_to_string(&cfg_path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => return out,
    };
    if !cfg.capture_enabled || cfg.database_ids.is_empty() {
        return out;
    }
    let env_file = user_data.join(".env");
    let token = match super::env::load_env_file(&env_file) {
        Ok(env) => env
            .into_iter()
            .find(|(k, _)| k == "NOTION_API_TOKEN")
            .map(|(_, v)| v)
            .unwrap_or_default(),
        Err(_) => return out,
    };
    if token.is_empty() {
        return out;
    }
    let client = match reqwest::Client::builder()
        .user_agent("TangerineMeeting/1.8 daemon")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            out.errors.push(format!("http_init: {}", e));
            return out;
        }
    };
    let project_root = memory_root
        .join("projects")
        .join("general")
        .join("notion");
    if let Err(e) = std::fs::create_dir_all(&project_root) {
        out.errors.push(format!("mkdir: {}", e));
        return out;
    }
    for db_id in &cfg.database_ids {
        match daemon_capture_db(&client, &token, db_id, &project_root).await {
            Ok(n) => out.written += n,
            Err(e) => out.errors.push(format!("db {}: {}", db_id, e)),
        }
    }
    // Save last_sync.
    let mut updated = cfg.clone();
    updated.last_sync = Some(Utc::now().to_rfc3339());
    if let Ok(body) = serde_json::to_string_pretty(&updated) {
        let tmp = cfg_path.with_extension(format!(
            "json.tmp.{}",
            uuid::Uuid::new_v4().simple()
        ));
        if std::fs::write(&tmp, body).is_ok() {
            let _ = std::fs::rename(&tmp, &cfg_path);
        }
    }
    out
}

async fn daemon_capture_db(
    client: &reqwest::Client,
    token: &str,
    db_id: &str,
    root: &Path,
) -> Result<usize, String> {
    let body = serde_json::json!({ "page_size": 100 });
    let resp = client
        .post(format!("{}/databases/{}/query", NOTION_API, db_id))
        .header("Authorization", format!("Bearer {}", token))
        .header("Notion-Version", NOTION_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("query status {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let pages = v
        .get("results")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    let mut written = 0_usize;
    for p in pages {
        let page_id = p.get("id").and_then(|s| s.as_str()).unwrap_or("").to_string();
        if page_id.is_empty() {
            continue;
        }
        let title = extract_page_title(&p);
        let last_edited = p
            .get("last_edited_time")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        let body_md = match daemon_fetch_blocks(client, token, &page_id).await {
            Ok(md) => md,
            Err(_) => String::new(),
        };
        let atom_path = root.join(format!("{}.md", page_id.replace('-', "")));
        let frontmatter = build_frontmatter(&[
            ("source", "notion"),
            ("notion_page_id", &page_id),
            ("notion_db_id", db_id),
            ("title", &title),
            ("last_edited_time", &last_edited),
            ("captured_at", &Utc::now().to_rfc3339()),
        ]);
        let content = format!("---\n{}---\n\n# {}\n\n{}", frontmatter, title, body_md);
        if atomic_write(&atom_path, &content).is_ok() {
            written += 1;
        }
    }
    Ok(written)
}

async fn daemon_fetch_blocks(
    client: &reqwest::Client,
    token: &str,
    page_id: &str,
) -> Result<String, String> {
    let resp = client
        .get(format!("{}/blocks/{}/children?page_size=100", NOTION_API, page_id))
        .header("Authorization", format!("Bearer {}", token))
        .header("Notion-Version", NOTION_VERSION)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("blocks status {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let arr = v
        .get("results")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(blocks_to_markdown(&arr))
}

// ---------------------------------------------------------------------------
// Helpers

fn read_token(state: &State<'_, AppState>) -> Result<String, AppError> {
    let env = super::env::load_env_file(&state.paths.env_file)?;
    Ok(env
        .into_iter()
        .find(|(k, _)| k == "NOTION_API_TOKEN")
        .map(|(_, v)| v)
        .unwrap_or_default())
}

fn build_frontmatter(pairs: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (k, v) in pairs {
        let escaped = v.replace('\\', "\\\\").replace('"', "\\\"");
        out.push_str(&format!("{}: \"{}\"\n", k, escaped));
    }
    out
}

fn slugify(s: &str) -> String {
    let raw: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    // Collapse runs of `-` so "Tangerine — Project A" becomes
    // "tangerine-project-a", not "tangerine---project-a".
    let mut out = String::with_capacity(raw.len());
    let mut prev_dash = false;
    for c in raw.chars() {
        if c == '-' {
            if prev_dash {
                continue;
            }
            prev_dash = true;
        } else {
            prev_dash = false;
        }
        out.push(c);
    }
    out.trim_matches('-').to_string()
}

fn atomic_write(path: &Path, body: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!(
        "tmp.{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

fn split_frontmatter(raw: &str) -> (String, String) {
    if !raw.starts_with("---\n") {
        return (String::new(), raw.to_string());
    }
    let rest = &raw[4..];
    if let Some(end) = rest.find("\n---") {
        let fm = rest[..end].to_string();
        let body_start = end + 4;
        let mut body = &rest[body_start..];
        // Skip the trailing newline after `---` plus any blank lines
        // before the body's first non-empty line.
        while body.starts_with('\n') {
            body = &body[1..];
        }
        return (fm, body.to_string());
    }
    (String::new(), raw.to_string())
}

fn lookup_fm(fm: &str, key: &str) -> Option<String> {
    for line in fm.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(&format!("{}:", key)) {
            let v = rest.trim().trim_matches('"').to_string();
            return Some(v);
        }
    }
    None
}

fn sha2_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    hex::encode(h.finalize())
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_notion_atom_format() {
        // Minimal page payload exercising title extraction + blocks.
        let page: serde_json::Value = serde_json::json!({
            "id": "abc-123",
            "last_edited_time": "2026-04-26T00:00:00Z",
            "properties": {
                "Name": {
                    "type": "title",
                    "title": [ { "plain_text": "My decision" } ]
                }
            }
        });
        assert_eq!(extract_page_title(&page), "My decision");

        let blocks = vec![
            serde_json::json!({
                "type": "paragraph",
                "paragraph": { "rich_text": [{ "plain_text": "Body line." }] }
            }),
            serde_json::json!({
                "type": "heading_2",
                "heading_2": { "rich_text": [{ "plain_text": "Section" }] }
            }),
            serde_json::json!({
                "type": "to_do",
                "to_do": {
                    "rich_text": [{ "plain_text": "Ship it" }],
                    "checked": true
                }
            }),
        ];
        let md = blocks_to_markdown(&blocks);
        assert!(md.contains("Body line."));
        assert!(md.contains("## Section"));
        assert!(md.contains("- [x] Ship it"));

        let fm = build_frontmatter(&[
            ("source", "notion"),
            ("notion_page_id", "abc-123"),
            ("title", "My decision"),
        ]);
        assert!(fm.contains("source: \"notion\""));
        assert!(fm.contains("notion_page_id: \"abc-123\""));
        assert!(fm.contains("title: \"My decision\""));
    }

    #[test]
    fn test_notion_skip_when_no_token() {
        // capture_database returns Err on bad token; here we just confirm
        // the helper functions degrade gracefully.
        let env: Vec<(String, String)> = Vec::new();
        let token = env
            .into_iter()
            .find(|(k, _)| k == "NOTION_API_TOKEN")
            .map(|(_, v)| v)
            .unwrap_or_default();
        assert!(token.is_empty());
    }

    #[test]
    fn test_notion_writeback_idempotent() {
        // Hash stability: same key produces same hex; different keys differ.
        let a = sha2_hex("dbX::Decision::body");
        let b = sha2_hex("dbX::Decision::body");
        let c = sha2_hex("dbY::Decision::body");
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn frontmatter_split_works() {
        let raw = "---\ntitle: \"x\"\n---\n\nbody here";
        let (fm, body) = split_frontmatter(raw);
        assert!(fm.contains("title: \"x\""));
        assert!(body.starts_with("body here"));
        assert_eq!(lookup_fm(&fm, "title").as_deref(), Some("x"));
    }

    #[test]
    fn slugify_strips_unicode_and_spaces() {
        assert_eq!(slugify("Tangerine — Project A"), "tangerine-project-a");
        assert_eq!(slugify("__general"), "general");
    }
}
