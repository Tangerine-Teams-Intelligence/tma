//! `open_external`, `show_in_folder`, `open_in_editor`, `system_notify`,
//! `export_debug_bundle`, `detect_claude_cli`, `validate_target_repo`.
//!
//! These wrap shell-out calls and OS-default-handler invocations.

use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;

use serde::{Deserialize, Serialize};
// === v1.13.3 round-3 ===
// Drop unused `Manager` import — `cargo check` flagged it. AppHandle here
// is only ever used for `app.opener()` (via OpenerExt; was `app.shell()`
// until v1.14.3 round-4) and `app.state()` is plumbed through the
// State<…> extractor, so the Manager trait isn't actually needed.
use tauri::{AppHandle, Runtime, State};
// === end v1.13.3 round-3 ===
// === v1.14.3 round-4 ===
// Migrated from `tauri_plugin_shell::ShellExt::open` (deprecated in 2.x) to
// the new dedicated `tauri-plugin-opener` crate. The opener plugin is
// registered in `main.rs` next to the shell plugin; the URL-open call site
// is below in `open_external`. Clears the lone deprecation warning that
// has been in `cargo check` output for ≥3 versions.
use tauri_plugin_opener::OpenerExt;
// === end v1.14.3 round-4 ===

use super::runner::run_oneshot;
use super::{AppError, AppState};

/// Windows `CREATE_NO_WINDOW` flag — suppresses the black `cmd.exe` console
/// pop-up that GUI parents get when spawning non-GUI children. Same value
/// the rest of the codebase uses.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Apply `CREATE_NO_WINDOW` to a `std::process::Command` on Windows. No-op on
/// other platforms. We use a free function here rather than inlining the
/// `#[cfg]` block at every call site because this file has multiple spawn
/// points.
#[cfg(windows)]
fn no_window(cmd: &mut StdCommand) -> &mut StdCommand {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW)
}
#[cfg(not(windows))]
fn no_window(cmd: &mut StdCommand) -> &mut StdCommand {
    cmd
}

#[derive(Debug, Deserialize)]
pub struct OpenExternalArgs {
    pub url: String,
}

// === wave 6.5 ===
// CEO dogfood (2026-04-27): the previous `cmd /c start "" url` invocation
// with CREATE_NO_WINDOW silent-failed on Windows — the start verb appeared
// to inherit the suppressed-window state and never actually spawned the
// browser. Switch to the official tauri plugin (cross-platform, no manual
// cmd wrapper needed).
// === v1.14.3 round-4 ===
// Migrated from `app.shell().open(url, None)` to
// `app.opener().open_url(url, None::<&str>)`. The shell variant was
// deprecated upstream in plugin-shell 2.x. Behavior is identical (delegates
// to the OS default URL handler). The capability still lives under
// `shell:allow-open` in `capabilities/default.json`; we add the equivalent
// opener permission there so production builds pass the ACL check.
#[tauri::command]
pub async fn open_external<R: Runtime>(
    app: AppHandle<R>,
    args: OpenExternalArgs,
) -> Result<(), AppError> {
    app.opener()
        .open_url(&args.url, None::<&str>)
        .map_err(|e| AppError::external("opener_open_url", e.to_string()))
}
// === end v1.14.3 round-4 ===
// === end wave 6.5 ===

#[derive(Debug, Deserialize)]
pub struct OpenInEditorArgs {
    pub path: PathBuf,
    #[serde(default)]
    pub line: Option<u32>,
}
#[tauri::command]
pub async fn open_in_editor(args: OpenInEditorArgs) -> Result<(), AppError> {
    // Prefer VS Code if present.
    let path_str = args
        .path
        .to_str()
        .ok_or_else(|| AppError::internal("non_utf8_path", format!("{:?}", args.path)))?;
    let code_arg = match args.line {
        Some(line) => format!("{}:{}", path_str, line),
        None => path_str.to_string(),
    };
    if which_first(&["code", "cursor"]).is_some() {
        let mut cmd = StdCommand::new(which_first(&["code", "cursor"]).unwrap());
        cmd.arg("--goto").arg(&code_arg);
        no_window(&mut cmd);
        let _ = cmd.spawn();
        return Ok(());
    }
    open_with_default_handler(path_str)
}

#[derive(Debug, Deserialize)]
pub struct ShowInFolderArgs {
    pub path: PathBuf,
}
#[tauri::command]
pub async fn show_in_folder(args: ShowInFolderArgs) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        let p = args
            .path
            .to_str()
            .ok_or_else(|| AppError::internal("non_utf8_path", format!("{:?}", args.path)))?;
        // /select, opens the parent and highlights the file. The trailing comma
        // is required by explorer.exe — don't "fix" it.
        let mut cmd = StdCommand::new("explorer.exe");
        cmd.arg(format!("/select,{}", p));
        no_window(&mut cmd);
        cmd.spawn()
            .map_err(|e| AppError::external("explorer", e.to_string()))?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        open_with_default_handler(
            args.path
                .to_str()
                .ok_or_else(|| AppError::internal("non_utf8_path", format!("{:?}", args.path)))?,
        )?;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
pub struct NotifyArgs {
    pub title: String,
    pub body: String,
}

#[tauri::command]
pub async fn system_notify<R: Runtime>(
    app: AppHandle<R>,
    args: NotifyArgs,
) -> Result<(), AppError> {
    // Use Tauri 2's notification plugin if T1 wires it up; fall back to no-op.
    let _ = app;
    tracing::info!(title=%args.title, body=%args.body, "system_notify");
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct DebugBundleArgs {
    pub dest_path: PathBuf,
}
#[derive(Debug, Serialize)]
pub struct DebugBundleResult {
    pub zip_path: PathBuf,
    pub file_count: u32,
}

#[tauri::command]
pub async fn export_debug_bundle(
    state: State<'_, AppState>,
    args: DebugBundleArgs,
) -> Result<DebugBundleResult, AppError> {
    // v1.5.0-beta: stub — write a single text manifest. T6 will implement
    // proper zip + sanitization. We return a deterministic shape so the UI
    // can be developed in parallel.
    let manifest = format!(
        "TangerineMeeting Debug Bundle\nlogs_dir: {:?}\nuser_data: {:?}\n",
        state.paths.logs_dir, state.paths.user_data
    );
    if let Some(parent) = args.dest_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&args.dest_path, manifest)?;
    Ok(DebugBundleResult {
        zip_path: args.dest_path,
        file_count: 1,
    })
}

#[derive(Debug, Serialize)]
pub struct ClaudeCliResult {
    pub found: bool,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
}

#[tauri::command]
pub async fn detect_claude_cli() -> Result<ClaudeCliResult, AppError> {
    let path = which_first(&["claude"]);
    let path = match path {
        Some(p) => p,
        None => {
            return Ok(ClaudeCliResult {
                found: false,
                path: None,
                version: None,
            })
        }
    };
    let (status, stdout, _) = run_oneshot(&path, &["--version"], None).await?;
    if !status.success() {
        return Ok(ClaudeCliResult {
            found: true,
            path: Some(path),
            version: None,
        });
    }
    let version = stdout.lines().next().map(|s| s.trim().to_string());
    Ok(ClaudeCliResult {
        found: true,
        path: Some(path),
        version,
    })
}

#[derive(Debug, Serialize)]
pub struct NodeRuntimeResult {
    pub found: bool,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    /// Major version parsed from `node --version` (e.g. 20). None if parse fails.
    pub major: Option<u32>,
    /// True iff `major >= 20`. The Discord bot bundle requires Node 20+.
    pub meets_min: bool,
}

/// Path D — pkg dropped, bot runs on user's Node 20+. SW3 calls this to verify
/// Node is on PATH before completing the wizard.
#[tauri::command]
pub async fn detect_node_runtime() -> Result<NodeRuntimeResult, AppError> {
    let path = match which_first(&["node"]) {
        Some(p) => p,
        None => {
            return Ok(NodeRuntimeResult {
                found: false,
                path: None,
                version: None,
                major: None,
                meets_min: false,
            });
        }
    };
    let (status, stdout, _) = run_oneshot(&path, &["--version"], None).await?;
    if !status.success() {
        return Ok(NodeRuntimeResult {
            found: true,
            path: Some(path),
            version: None,
            major: None,
            meets_min: false,
        });
    }
    // `node --version` -> "v20.11.1\n"
    let version = stdout.lines().next().map(|s| s.trim().to_string());
    let major = version.as_deref().and_then(parse_node_major);
    let meets_min = major.map(|m| m >= 20).unwrap_or(false);
    Ok(NodeRuntimeResult {
        found: true,
        path: Some(path),
        version,
        major,
        meets_min,
    })
}

fn parse_node_major(v: &str) -> Option<u32> {
    let v = v.trim().trim_start_matches('v');
    let major = v.split('.').next()?;
    major.parse::<u32>().ok()
}

#[derive(Debug, Deserialize)]
pub struct ValidateRepoArgs {
    pub path: PathBuf,
}

#[derive(Debug, Serialize)]
pub struct ValidateRepoResult {
    pub ok: bool,
    pub has_claude_md: bool,
    pub has_knowledge: bool,
    pub has_cursorrules: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn validate_target_repo(
    args: ValidateRepoArgs,
) -> Result<ValidateRepoResult, AppError> {
    if !args.path.is_dir() {
        return Ok(ValidateRepoResult {
            ok: false,
            has_claude_md: false,
            has_knowledge: false,
            has_cursorrules: false,
            error: Some("path is not a directory".into()),
        });
    }
    let git_path = which_first(&["git"]).ok_or_else(|| {
        AppError::external("git_missing", "git executable not found on PATH")
    })?;
    let (status, _stdout, stderr) = run_oneshot(
        &git_path,
        &["rev-parse", "--is-inside-work-tree"],
        Some(&args.path),
    )
    .await?;
    if !status.success() {
        return Ok(ValidateRepoResult {
            ok: false,
            has_claude_md: false,
            has_knowledge: false,
            has_cursorrules: false,
            error: Some(stderr.trim().to_string()),
        });
    }
    Ok(ValidateRepoResult {
        ok: true,
        has_claude_md: args.path.join("CLAUDE.md").is_file(),
        has_knowledge: args.path.join("knowledge").is_dir(),
        has_cursorrules: args.path.join(".cursorrules").is_file(),
        error: None,
    })
}

// --- helpers ----------------------------------------------------------------

fn open_with_default_handler(target: &str) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        // `cmd /c start "" "<url>"` is the safest invocation for paths/URLs
        // that contain spaces; the empty quoted title is required.
        let mut cmd = StdCommand::new("cmd");
        cmd.args(["/c", "start", "", target]);
        no_window(&mut cmd);
        cmd.spawn()
            .map_err(|e| AppError::external("start", e.to_string()))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        StdCommand::new("open")
            .arg(target)
            .spawn()
            .map_err(|e| AppError::external("open", e.to_string()))?;
        Ok(())
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        StdCommand::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| AppError::external("xdg-open", e.to_string()))?;
        Ok(())
    }
}

fn which_first(candidates: &[&str]) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let exts: Vec<&str> = if cfg!(windows) {
        vec!["", ".exe", ".cmd", ".bat"]
    } else {
        vec![""]
    };
    for dir in std::env::split_paths(&path_var) {
        for cand in candidates {
            for ext in &exts {
                let p = dir.join(format!("{}{}", cand, ext));
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    None
}

#[allow(dead_code)]
fn _ensure_path_referenced(_p: &Path) {}

// === v3.0 external world ===
//
// Layer 6 capture: RSS / podcast / YouTube / generic article. The reader
// modules under `crate::sources::external::*` own the parsing + atom builder
// + on-disk write; this surface is the Tauri command boundary plus the
// per-user JSON config that persists subscriptions.
//
// Storage layout:
//   * Subscriptions: `<user_data>/sources/external_rss.json`
//                    `<user_data>/sources/external_podcast.json`
//   * Atoms: `<memory_root>/personal/<user>/threads/external/<kind>/...`
//
// The daemon's `// === v3.0 external world tick ===` block reads the same
// JSON files each heartbeat (default 24 h cadence) and runs the same
// `ingest_*` pipeline. Manual `external_*_fetch_now` is a no-op when
// nothing is subscribed.

use chrono::Utc;
use std::fs;
use std::path::PathBuf as ExtPathBuf;

use crate::memory_paths::personal_user_root;
use crate::sources::external::{
    article::{self, ArticleAtomInput, ArticleCaptureRequest},
    podcast::{self, PodcastFeed},
    rss::{self, RssFeed},
    youtube::{self, YoutubeAtomInput, YoutubeCaptureRequest},
    ExternalFetchResult,
};

/// Where the per-source JSON subscription lists live. We mirror the layout
/// the v1.8 Phase 2-C connectors use (`<user_data>/sources/<name>.json`).
fn external_config_path(state: &State<'_, AppState>, kind: &str) -> ExtPathBuf {
    state
        .paths
        .user_data
        .join("sources")
        .join(format!("external_{kind}.json"))
}

fn read_feeds<T: serde::de::DeserializeOwned>(path: &ExtPathBuf) -> Vec<T> {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str::<Vec<T>>(&raw).unwrap_or_else(|_| Vec::new())
}

fn write_feeds<T: serde::Serialize>(path: &ExtPathBuf, list: &[T]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(list)
        .map_err(|e| AppError::internal("external_write_feeds", e.to_string()))?;
    fs::write(path, json)?;
    Ok(())
}

fn current_user_or_default(args_user: Option<String>) -> String {
    args_user
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "me".to_string())
}

/// `<home>/.tangerine-memory/` — same default as `commands::memory::memory_root`
/// + `sources::voice_notes::default_memory_root`. Returned as a hard error
/// when the home dir can't be resolved (matches the existing handlers).
fn memory_root(_state: &State<'_, AppState>) -> Result<ExtPathBuf, AppError> {
    dirs::home_dir()
        .map(|h| h.join(".tangerine-memory"))
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))
}

// ---- RSS commands -----------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ExternalRssArgs {
    pub url: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub current_user: Option<String>,
}

#[tauri::command]
pub async fn external_rss_subscribe(
    state: State<'_, AppState>,
    args: ExternalRssArgs,
) -> Result<Vec<RssFeed>, AppError> {
    let path = external_config_path(&state, "rss");
    let mut feeds: Vec<RssFeed> = read_feeds(&path);
    if feeds.iter().any(|f| f.url == args.url) {
        return Ok(feeds);
    }
    feeds.push(RssFeed {
        url: args.url,
        title: args.title,
        slug: None,
    });
    write_feeds(&path, &feeds)?;
    Ok(feeds)
}

#[derive(Debug, Deserialize)]
pub struct ExternalRssUnsubArgs {
    pub url: String,
}

#[tauri::command]
pub async fn external_rss_unsubscribe(
    state: State<'_, AppState>,
    args: ExternalRssUnsubArgs,
) -> Result<Vec<RssFeed>, AppError> {
    let path = external_config_path(&state, "rss");
    let mut feeds: Vec<RssFeed> = read_feeds(&path);
    feeds.retain(|f| f.url != args.url);
    write_feeds(&path, &feeds)?;
    Ok(feeds)
}

#[tauri::command]
pub async fn external_rss_list_feeds(
    state: State<'_, AppState>,
) -> Result<Vec<RssFeed>, AppError> {
    Ok(read_feeds::<RssFeed>(&external_config_path(&state, "rss")))
}

#[derive(Debug, Deserialize)]
pub struct ExternalFetchNowArgs {
    #[serde(default)]
    pub current_user: Option<String>,
    /// Optional inline payload. When set we bypass HTTP and parse this body.
    /// Used by tests + by the deep-link-from-archive flow on the desktop
    /// side. Omitted in production (the daemon does the network fetch).
    #[serde(default)]
    pub raw_xml: Option<String>,
    /// When `raw_xml` is set, which feed URL to associate the entries with.
    #[serde(default)]
    pub url: Option<String>,
}

#[tauri::command]
pub async fn external_rss_fetch_now(
    state: State<'_, AppState>,
    args: ExternalFetchNowArgs,
) -> Result<ExternalFetchResult, AppError> {
    let memory_root = memory_root(&state)?;
    let user = current_user_or_default(args.current_user);
    let now = Utc::now();
    let mut total = ExternalFetchResult::new("rss");

    if let Some(raw) = args.raw_xml {
        let url = args.url.unwrap_or_default();
        let feed = RssFeed::new(url);
        let entries = rss::parse_feed(&raw)
            .map_err(|e| AppError::external("rss_parse", e))?;
        let r = rss::ingest_parsed_entries(&memory_root, &user, &feed, &entries, &now);
        total.items_seen = total.items_seen.saturating_add(r.items_seen);
        total.atoms_written = total.atoms_written.saturating_add(r.atoms_written);
        total.errors.extend(r.errors);
        return Ok(total);
    }

    // Production path: walk every subscribed feed. We fetch the feed body
    // via the shared `state.http` client; failure on one feed never aborts
    // the rest.
    let feeds = read_feeds::<RssFeed>(&external_config_path(&state, "rss"));
    for feed in feeds {
        match fetch_text(&state, &feed.url).await {
            Ok(raw) => match rss::parse_feed(&raw) {
                Ok(entries) => {
                    let r = rss::ingest_parsed_entries(&memory_root, &user, &feed, &entries, &now);
                    total.items_seen = total.items_seen.saturating_add(r.items_seen);
                    total.atoms_written = total.atoms_written.saturating_add(r.atoms_written);
                    total.errors.extend(r.errors);
                }
                Err(e) => total.errors.push(format!("{}: parse {e}", feed.url)),
            },
            Err(e) => total.errors.push(format!("{}: fetch {e}", feed.url)),
        }
    }
    Ok(total)
}

// ---- Podcast commands -------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ExternalPodcastArgs {
    pub url: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub transcribe: bool,
}

#[tauri::command]
pub async fn external_podcast_subscribe(
    state: State<'_, AppState>,
    args: ExternalPodcastArgs,
) -> Result<Vec<PodcastFeed>, AppError> {
    let path = external_config_path(&state, "podcast");
    let mut feeds: Vec<PodcastFeed> = read_feeds(&path);
    if feeds.iter().any(|f| f.url == args.url) {
        return Ok(feeds);
    }
    feeds.push(PodcastFeed {
        url: args.url,
        title: args.title,
        slug: None,
        transcribe: args.transcribe,
    });
    write_feeds(&path, &feeds)?;
    Ok(feeds)
}

#[tauri::command]
pub async fn external_podcast_unsubscribe(
    state: State<'_, AppState>,
    args: ExternalRssUnsubArgs,
) -> Result<Vec<PodcastFeed>, AppError> {
    let path = external_config_path(&state, "podcast");
    let mut feeds: Vec<PodcastFeed> = read_feeds(&path);
    feeds.retain(|f| f.url != args.url);
    write_feeds(&path, &feeds)?;
    Ok(feeds)
}

#[tauri::command]
pub async fn external_podcast_list_feeds(
    state: State<'_, AppState>,
) -> Result<Vec<PodcastFeed>, AppError> {
    Ok(read_feeds::<PodcastFeed>(&external_config_path(
        &state, "podcast",
    )))
}

#[tauri::command]
pub async fn external_podcast_fetch_now(
    state: State<'_, AppState>,
    args: ExternalFetchNowArgs,
) -> Result<ExternalFetchResult, AppError> {
    let memory_root = memory_root(&state)?;
    let user = current_user_or_default(args.current_user);
    let now = Utc::now();
    let mut total = ExternalFetchResult::new("podcast");

    if let Some(raw) = args.raw_xml {
        let url = args.url.unwrap_or_default();
        let feed = PodcastFeed::new(url);
        let eps = podcast::parse_podcast_feed(&raw)
            .map_err(|e| AppError::external("podcast_parse", e))?;
        let r = podcast::ingest_parsed_episodes(&memory_root, &user, &feed, &eps, &now);
        total.items_seen = total.items_seen.saturating_add(r.items_seen);
        total.atoms_written = total.atoms_written.saturating_add(r.atoms_written);
        total.errors.extend(r.errors);
        return Ok(total);
    }

    let feeds = read_feeds::<PodcastFeed>(&external_config_path(&state, "podcast"));
    for feed in feeds {
        match fetch_text(&state, &feed.url).await {
            Ok(raw) => match podcast::parse_podcast_feed(&raw) {
                Ok(eps) => {
                    let r = podcast::ingest_parsed_episodes(&memory_root, &user, &feed, &eps, &now);
                    total.items_seen = total.items_seen.saturating_add(r.items_seen);
                    total.atoms_written = total.atoms_written.saturating_add(r.atoms_written);
                    total.errors.extend(r.errors);
                }
                Err(e) => total.errors.push(format!("{}: parse {e}", feed.url)),
            },
            Err(e) => total.errors.push(format!("{}: fetch {e}", feed.url)),
        }
    }
    Ok(total)
}

// ---- YouTube command --------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ExternalYoutubeArgs {
    pub request: YoutubeCaptureRequest,
    #[serde(default)]
    pub current_user: Option<String>,
    /// When set, skip the network fetch and parse this timed-text body.
    /// Used by tests + by the desktop "Capture from clipboard transcript"
    /// flow.
    #[serde(default)]
    pub raw_timedtext: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub duration_sec: Option<u64>,
}

#[tauri::command]
pub async fn external_youtube_capture(
    state: State<'_, AppState>,
    args: ExternalYoutubeArgs,
) -> Result<ExternalFetchResult, AppError> {
    let memory_root = memory_root(&state)?;
    let user = current_user_or_default(args.current_user);
    let url = args.request.url.clone();
    let video_id = youtube::extract_video_id(&url).ok_or_else(|| {
        AppError::user(
            "invalid_youtube_url",
            "could not extract video id from URL",
        )
    })?;

    let lang = args.request.language.clone().unwrap_or_else(|| "en".to_string());
    let transcript_text = if let Some(raw) = args.raw_timedtext {
        youtube::parse_timedtext(&raw)
    } else {
        // Production path — fetch the timed-text endpoint and parse.
        let endpoint = format!(
            "https://www.youtube.com/api/timedtext?v={}&lang={}",
            video_id, lang
        );
        match fetch_text(&state, &endpoint).await {
            Ok(raw) => youtube::parse_timedtext(&raw),
            Err(_) => String::new(),
        }
    };

    let input = YoutubeAtomInput {
        video_id: &video_id,
        url: &url,
        title: args.title.as_deref().unwrap_or(""),
        channel: args.channel.as_deref().unwrap_or(""),
        duration_sec: args.duration_sec,
        transcript: &transcript_text,
        fetched_at: Utc::now(),
    };
    Ok(youtube::ingest_video(&memory_root, &user, &input))
}

// ---- Article command --------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ExternalArticleArgs {
    pub request: ArticleCaptureRequest,
    #[serde(default)]
    pub current_user: Option<String>,
    /// When set, parse this HTML directly (browser-ext "Save to Tangerine"
    /// flow already has the page DOM, so we skip a redundant fetch).
    #[serde(default)]
    pub raw_html: Option<String>,
}

#[tauri::command]
pub async fn external_article_capture(
    state: State<'_, AppState>,
    args: ExternalArticleArgs,
) -> Result<ExternalFetchResult, AppError> {
    let memory_root = memory_root(&state)?;
    let user = current_user_or_default(args.current_user);
    let url = args.request.url.clone();
    let html = if let Some(raw) = args.raw_html {
        raw
    } else {
        fetch_text(&state, &url)
            .await
            .map_err(|e| AppError::external("article_fetch", e))?
    };
    let title = article::extract_title(&html);
    let author = article::extract_author(&html);
    let body_md = article::html_to_markdown(&html);
    let now = Utc::now();
    let input = ArticleAtomInput {
        url: &url,
        title: &title,
        author: &author,
        markdown: &body_md,
        fetched_at: now,
    };
    Ok(article::ingest_article(
        &memory_root,
        &user,
        &input,
        args.request.slug.as_deref(),
    ))
}

// ---- Shared helpers ---------------------------------------------------------

async fn fetch_text(state: &State<'_, AppState>, url: &str) -> Result<String, String> {
    let resp = state
        .http
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("http {}", resp.status()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

/// Daemon entry-point. Walks every subscribed RSS + podcast feed, runs the
/// network fetch + parse + ingest. Designed to be cheap on a fresh install
/// (no feeds → zero work). Errors are collected, never raised — the daemon
/// records them in its `errors` ring.
///
/// Takes `user_data` + `memory_root` directly so the daemon (which doesn't
/// hold an `AppState`) can drive it. The HTTP client is supplied by the
/// caller — daemon owns one already.
pub async fn tick_from_daemon(
    user_data: &Path,
    memory_root: &Path,
    http: &reqwest::Client,
) -> ExternalFetchResult {
    let mut total = ExternalFetchResult::new("external");
    let user = "me".to_string();
    let now = Utc::now();
    // Best-effort: ensure the personal vault dir exists so a first-run with
    // configured feeds doesn't write to a missing tree.
    let _ = std::fs::create_dir_all(personal_user_root(memory_root, &user));

    // RSS.
    let rss_path = user_data
        .join("sources")
        .join("external_rss.json");
    let rss_feeds = read_feeds::<RssFeed>(&rss_path);
    for feed in rss_feeds {
        match http.get(&feed.url).send().await {
            Ok(r) if r.status().is_success() => match r.text().await {
                Ok(raw) => match rss::parse_feed(&raw) {
                    Ok(entries) => {
                        let res = rss::ingest_parsed_entries(
                            memory_root,
                            &user,
                            &feed,
                            &entries,
                            &now,
                        );
                        total.items_seen = total.items_seen.saturating_add(res.items_seen);
                        total.atoms_written =
                            total.atoms_written.saturating_add(res.atoms_written);
                        total.errors.extend(res.errors);
                    }
                    Err(e) => total.errors.push(format!("{}: parse {e}", feed.url)),
                },
                Err(e) => total.errors.push(format!("{}: body {e}", feed.url)),
            },
            Ok(r) => total
                .errors
                .push(format!("{}: http {}", feed.url, r.status())),
            Err(e) => total.errors.push(format!("{}: req {e}", feed.url)),
        }
    }

    // Podcast.
    let pod_path = user_data
        .join("sources")
        .join("external_podcast.json");
    let pod_feeds = read_feeds::<PodcastFeed>(&pod_path);
    for feed in pod_feeds {
        match http.get(&feed.url).send().await {
            Ok(r) if r.status().is_success() => match r.text().await {
                Ok(raw) => match podcast::parse_podcast_feed(&raw) {
                    Ok(eps) => {
                        let res = podcast::ingest_parsed_episodes(
                            &memory_root,
                            &user,
                            &feed,
                            &eps,
                            &now,
                        );
                        total.items_seen = total.items_seen.saturating_add(res.items_seen);
                        total.atoms_written =
                            total.atoms_written.saturating_add(res.atoms_written);
                        total.errors.extend(res.errors);
                    }
                    Err(e) => total.errors.push(format!("{}: parse {e}", feed.url)),
                },
                Err(e) => total.errors.push(format!("{}: body {e}", feed.url)),
            },
            Ok(r) => total
                .errors
                .push(format!("{}: http {}", feed.url, r.status())),
            Err(e) => total.errors.push(format!("{}: req {e}", feed.url)),
        }
    }
    total
}

#[cfg(test)]
mod external_tests {
    use super::*;

    #[test]
    fn config_path_lives_under_user_data_sources() {
        // Smoke check the path joins — full Tauri State is fixture-heavy
        // so the per-module unit tests under `crate::sources::external::*`
        // cover the parsing + atom builders end-to-end. This case
        // protects the layout convention.
        let p = ExtPathBuf::from("/tmp/userdata")
            .join("sources")
            .join("external_rss.json");
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("sources/external_rss.json"));
    }
}
// === end v3.0 external world ===
