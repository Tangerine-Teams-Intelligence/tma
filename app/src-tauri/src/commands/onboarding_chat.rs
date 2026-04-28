//! === wave 18 ===
//! v1.10.4 — conversational onboarding agent.
//!
//! CEO ratified paradigm shift: replace the form-based `SetupWizard` (Wave 11)
//! with a chat-driven setup. Users describe what they want in natural language
//! ("github=daizhe, repo=tangerine-team-private, primary=Claude Code") and
//! the app's LLM-driven intent parser extracts {github_account, github_repo,
//! primary_tool} and executes the corresponding setup actions.
//!
//! The single Tauri entry point (`onboarding_chat_turn`) does:
//!   1. Build an LLM prompt that asks the model to return structured JSON
//!      with {actions: [...], reply: "human-readable"}.
//!   2. Send via the existing `crate::agi::session_borrower::dispatch` so MCP
//!      sampling / Ollama / DeepSeek all work as the same fallback chain
//!      shared with the rest of the app.
//!   3. Parse the JSON action plan. For each action, dispatch to the
//!      corresponding existing Tauri command (configure_mcp →
//!      `setup_wizard_auto_configure_mcp`, git_remote_set →
//!      `git_sync_init`, etc.). Frontend-only actions (discord_bot_guide,
//!      github_oauth, restart_required) are no-ops on the backend; the React
//!      side renders the guide.
//!   4. Append the turn (user message + assistant reply + actions taken) to
//!      `<memory_dir>/.tangerine/onboarding_chat.jsonl` so the conversation
//!      survives cold launches and the user can review it via Cmd+K.
//!
//! Defensive: when the LLM returns malformed JSON we fall back to a generic
//! reply ("Sorry, I didn't catch that — could you rephrase?") so a flaky model
//! never strands the user. When the LLM channel itself is unreachable (no
//! editor open + no Ollama) we return a graceful reply that hints at the
//! Cmd+K palette's "Use form-based setup" fallback.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::AppError;
use crate::agi::session_borrower::{dispatch, BorrowError, LlmRequest};

// ---------------------------------------------------------------------------
// Types — every shape mirrored on the React side in `lib/tauri.ts` +
// `lib/onboarding-actions.ts`.
// ---------------------------------------------------------------------------

/// One conversational turn. Returned to the React side after every user
/// message. `role = "assistant"` for the model's reply (the user echoes their
/// own text on the React side before invoke; we don't need to round-trip it).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnboardingChatTurn {
    pub role: String,
    pub content: String,
    pub actions_taken: Vec<OnboardingAction>,
    pub actions_pending: Vec<OnboardingAction>,
}

/// One concrete action the assistant either performed or is about to guide
/// the user through. `kind` is a stable string the React side maps to a
/// renderer in `lib/onboarding-actions.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnboardingAction {
    pub kind: String,
    pub status: String,
    pub detail: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OnboardingChatTurnArgs {
    pub user_message: String,
    /// Stable id the frontend generates per fresh-install setup session. The
    /// Rust side uses it to scope the persisted JSONL — different sessions
    /// don't leak into each other (a re-trigger from Cmd+K would use a fresh
    /// id and start a clean transcript).
    pub session_id: String,
    /// Optional — overrides the user's `ui.primaryAITool` when dispatching the
    /// LLM call. Lets a fresh-install user pick a primary tool inline before
    /// it's been persisted to the store.
    #[serde(default)]
    pub primary_tool_id: Option<String>,
}

// ---------------------------------------------------------------------------
// LLM prompt strategy — zero-shot with a strict JSON schema. We intentionally
// list every supported action `kind` in the system prompt so the model picks
// from a closed set; freeform action names are dropped on parse.
// ---------------------------------------------------------------------------

// === wave 1.13-E ===
// Extended SYSTEM_PROMPT — recognises 6 new source-token setup kinds
// (Lark / Zoom / Teams / Slack / GitHub / Discord). The LLM is told to
// prefer the inline-token path when the user pastes credentials, and the
// OAuth-flow path when the user only says "set up X".
const SYSTEM_PROMPT: &str = r#"You are Tangerine's onboarding agent. The user is setting up the Tangerine Teams app and has just sent you a message describing what they want to do. Your job:

1. Extract the intent (configure their primary AI tool, link a GitHub repo, set up Discord bot, enable Whisper transcription, connect a human-comm source like Lark/Zoom/Teams/Slack/GitHub, etc.).
2. Decide which concrete actions to take.
3. Reply in plain English, brief.

You MUST respond with strict JSON, no prose, no markdown fences:
{
  "reply": "<human-readable string, 1-3 sentences max>",
  "actions": [
    {"kind": "<one of: configure_mcp | git_remote_set | whisper_download | discord_bot_guide | github_oauth | restart_required | setup_source_lark | setup_source_zoom | setup_source_teams | setup_source_slack | setup_source_github | setup_source_discord>", "params": {...}}
  ]
}

Action kinds and required params:
- configure_mcp: {"tool_id": "cursor"|"claude-code"|"codex"|"windsurf"} — writes the Tangerine MCP entry into the editor's mcp.json so it can serve LLM sampling requests.
- git_remote_set: {"remote_url": "https://github.com/owner/repo.git"} — initializes the user's ~/.tangerine-memory/ as a git repo and sets the origin remote.
- whisper_download: {"size": "small"|"base"|"medium"} — downloads the local Whisper model so meeting recordings can be transcribed offline.
- discord_bot_guide: {} — no params, opens the in-app Discord Developer Portal walkthrough.
- github_oauth: {} — no params, opens the GitHub device-flow OAuth so the user can authorize without typing a token.
- restart_required: {"tool": "<tool_id>"} — no backend action, just hints to the user that they must restart their editor before the MCP bridge comes up.
- setup_source_lark: {"app_id": "cli_xxx", "app_secret": "xxx", "account": "<alias>"} — stores the Lark app credentials in the OS keychain, tests the connection, enables the source.
- setup_source_zoom: {"oauth_token": "<bearer>", "refresh_token": "<rt>"?, "expires_at": <epoch>?, "account": "<alias>"} — stores the Zoom OAuth bundle. If oauth_token is missing, replies with the OAuth marketplace URL and waits for the user to complete the flow in their browser.
- setup_source_teams: {"oauth_token": "<bearer>", "refresh_token": "<rt>"?, "expires_at": <epoch>?, "account": "<alias>"} — same shape as Zoom, for Microsoft Graph.
- setup_source_slack: {"bot_token": "xoxb-...", "app_token": "xapp-..."?, "workspace": "<alias>"} — stores the Slack OAuth tokens.
- setup_source_github: {"personal_access_token": "ghp_xxx", "login": "<gh-username>"} — stores the GitHub PAT for inbound capture (PRs / issues / mentions). Distinct from the legacy github_oauth action which targets the v1.6 device flow.
- setup_source_discord: {"bot_token": "<discord token>", "account": "<alias>"} — Discord-bot-as-a-source variant; integrates the existing Discord bot wiring into the chat-driven setup.

Rules:
- If the user pastes credentials inline ("my app_id is cli_xxx, secret is yyy"), pick the matching setup_source_X action and pass the values through verbatim.
- If the user just says "connect Slack" / "set up Zoom" without credentials, still emit the matching setup_source_X action with empty fields — the backend will reply with the OAuth URL.
- If the user asks for the form wizard ("show me the form", "I want the wizard", etc.), reply that they should press Cmd+K and pick "Use form-based setup", and return an empty actions array.
- If you don't recognize the intent or the user is just chatting, reply with a friendly clarifying question and an empty actions array.
- NEVER invent action kinds outside the list above.
- Keep reply terse — under 50 words."#;
// === end wave 1.13-E ===

fn build_user_prompt(user_message: &str) -> String {
    format!(
        "User message: \"{}\"\n\nReturn your JSON response now.",
        user_message.replace('"', "\\\"")
    )
}

// ---------------------------------------------------------------------------
// LLM JSON parsing — defensive. We accept the strict shape above plus a few
// common malformations (markdown fences, leading/trailing whitespace).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct LlmActionPlan {
    reply: String,
    #[serde(default)]
    actions: Vec<LlmActionRequest>,
}

#[derive(Debug, Clone, Deserialize)]
struct LlmActionRequest {
    kind: String,
    #[serde(default)]
    params: serde_json::Value,
}

/// Best-effort JSON parser. Strips a leading ```json / ``` fence, trims
/// whitespace, parses. On any failure returns None so the caller can render a
/// graceful "didn't catch that" fallback.
fn parse_action_plan(raw: &str) -> Option<LlmActionPlan> {
    let mut s = raw.trim();
    // Strip markdown fences if present.
    if let Some(stripped) = s.strip_prefix("```json") {
        s = stripped.trim();
    } else if let Some(stripped) = s.strip_prefix("```") {
        s = stripped.trim();
    }
    let s = s.trim_end_matches("```").trim();
    serde_json::from_str::<LlmActionPlan>(s).ok()
}

// ---------------------------------------------------------------------------
// Action execution — each `kind` maps to a Tauri command we already ship.
// We deliberately re-call the existing commands (rather than copy-paste their
// bodies here) so this module stays small and any later patches to the
// underlying setup primitives flow through automatically.
// ---------------------------------------------------------------------------

/// Run one action. Returns the `OnboardingAction` shape with status filled in.
/// `status = "succeeded" | "failed" | "pending"`. Frontend-only actions
/// (discord_bot_guide / github_oauth / restart_required) return "pending"
/// because the React side completes them.
async fn execute_action(req: &LlmActionRequest) -> OnboardingAction {
    match req.kind.as_str() {
        "configure_mcp" => execute_configure_mcp(&req.params).await,
        "git_remote_set" => execute_git_remote_set(&req.params).await,
        "whisper_download" => execute_whisper_download(&req.params),
        "discord_bot_guide" => OnboardingAction {
            kind: "discord_bot_guide".to_string(),
            status: "pending".to_string(),
            detail: "Open the Discord Developer Portal in the side panel to create a bot token".to_string(),
            error: None,
        },
        "github_oauth" => OnboardingAction {
            kind: "github_oauth".to_string(),
            status: "pending".to_string(),
            detail: "Authorize Tangerine via GitHub device flow".to_string(),
            error: None,
        },
        "restart_required" => {
            let tool = req
                .params
                .get("tool")
                .and_then(|v| v.as_str())
                .unwrap_or("the editor");
            OnboardingAction {
                kind: "restart_required".to_string(),
                status: "pending".to_string(),
                detail: format!("Restart {tool} so the MCP bridge can come up"),
                error: None,
            }
        }
        // === wave 1.13-E ===
        "setup_source_lark" => execute_setup_source_lark(&req.params).await,
        "setup_source_zoom" => execute_setup_source_zoom(&req.params).await,
        "setup_source_teams" => execute_setup_source_teams(&req.params).await,
        "setup_source_slack" => execute_setup_source_slack(&req.params).await,
        "setup_source_github" => execute_setup_source_github(&req.params).await,
        "setup_source_discord" => execute_setup_source_discord(&req.params).await,
        // === end wave 1.13-E ===
        unknown => OnboardingAction {
            kind: unknown.to_string(),
            status: "failed".to_string(),
            detail: format!("Unknown action kind: {unknown}"),
            error: Some("unsupported_action_kind".to_string()),
        },
    }
}

// === wave 1.13-E ===
// Source-token setup actions. Each follows the same lifecycle:
//   1. Pull required params off the LLM-supplied JSON.
//   2. If the access token is present inline, store it via secret_store and
//      mark the action `succeeded`.
//   3. If only a "set up X" intent without token, mark the action `pending`
//      and surface the OAuth URL so the React side can open the browser.
//   4. Source token failures NEVER crash the chat — they propagate as
//      `failed` with `error` filled in so the UI can render an inline
//      diagnostic next to the chat bubble.

async fn execute_setup_source_lark(params: &serde_json::Value) -> OnboardingAction {
    let app_id = string_param(params, "app_id");
    let app_secret = string_param(params, "app_secret");
    let account = string_or_default(params, "account", "default");
    if app_id.is_empty() || app_secret.is_empty() {
        return OnboardingAction {
            kind: "setup_source_lark".to_string(),
            status: "pending".to_string(),
            detail: "Need app_id + app_secret. Get them from open.larksuite.com → Apps → Credentials.".to_string(),
            error: None,
        };
    }
    // Pack app_id + app_secret as a JSON-encoded access_token so a single
    // keychain entry holds both. The Lark ingest path unpacks at runtime.
    let combined = serde_json::json!({"app_id": app_id, "app_secret": app_secret}).to_string();
    let res = super::secret_store::secret_store_set_oauth(
        super::secret_store::SecretStoreSetOauthArgs {
            source: "lark".to_string(),
            account: account.clone(),
            access_token: combined,
            refresh_token: None,
            expires_at: None,
        },
    )
    .await;
    setup_source_outcome("setup_source_lark", "Lark", &account, res)
}

async fn execute_setup_source_zoom(params: &serde_json::Value) -> OnboardingAction {
    let token = string_param(params, "oauth_token");
    let account = string_or_default(params, "account", "default");
    if token.is_empty() {
        return OnboardingAction {
            kind: "setup_source_zoom".to_string(),
            status: "pending".to_string(),
            detail: "Open Zoom OAuth URL: https://zoom.us/oauth/authorize?response_type=code&client_id=<tangerine-app>&redirect_uri=http://127.0.0.1:7781/cb (Tangerine listens on the loopback for the callback).".to_string(),
            error: None,
        };
    }
    let refresh = optional_string_param(params, "refresh_token");
    let expires = params.get("expires_at").and_then(|v| v.as_i64());
    let res = super::secret_store::secret_store_set_oauth(
        super::secret_store::SecretStoreSetOauthArgs {
            source: "zoom".to_string(),
            account: account.clone(),
            access_token: token,
            refresh_token: refresh,
            expires_at: expires,
        },
    )
    .await;
    setup_source_outcome("setup_source_zoom", "Zoom", &account, res)
}

async fn execute_setup_source_teams(params: &serde_json::Value) -> OnboardingAction {
    let token = string_param(params, "oauth_token");
    let account = string_or_default(params, "account", "default");
    if token.is_empty() {
        return OnboardingAction {
            kind: "setup_source_teams".to_string(),
            status: "pending".to_string(),
            detail: "Open Microsoft consent URL: https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=<tangerine-app>&scope=Chat.Read+OnlineMeetings.Read.All&redirect_uri=http://127.0.0.1:7782/cb".to_string(),
            error: None,
        };
    }
    let refresh = optional_string_param(params, "refresh_token");
    let expires = params.get("expires_at").and_then(|v| v.as_i64());
    let res = super::secret_store::secret_store_set_oauth(
        super::secret_store::SecretStoreSetOauthArgs {
            source: "teams".to_string(),
            account: account.clone(),
            access_token: token,
            refresh_token: refresh,
            expires_at: expires,
        },
    )
    .await;
    setup_source_outcome("setup_source_teams", "Microsoft Teams", &account, res)
}

async fn execute_setup_source_slack(params: &serde_json::Value) -> OnboardingAction {
    let bot = string_param(params, "bot_token");
    let workspace = string_or_default(params, "workspace", "default");
    if bot.is_empty() {
        return OnboardingAction {
            kind: "setup_source_slack".to_string(),
            status: "pending".to_string(),
            detail: "Open Slack OAuth: api.slack.com/apps → Tangerine → OAuth & Permissions → Install to workspace. Paste the resulting xoxb-... token here.".to_string(),
            error: None,
        };
    }
    // Slack supports an optional "app token" (xapp-) for socket-mode events.
    // We store it in refresh_token so a single keychain entry holds both.
    let app_token = optional_string_param(params, "app_token");
    let res = super::secret_store::secret_store_set_oauth(
        super::secret_store::SecretStoreSetOauthArgs {
            source: "slack".to_string(),
            account: workspace.clone(),
            access_token: bot,
            refresh_token: app_token,
            expires_at: None,
        },
    )
    .await;
    setup_source_outcome("setup_source_slack", "Slack", &workspace, res)
}

async fn execute_setup_source_github(params: &serde_json::Value) -> OnboardingAction {
    let pat = string_param(params, "personal_access_token");
    let login = string_or_default(params, "login", "default");
    if pat.is_empty() {
        return OnboardingAction {
            kind: "setup_source_github".to_string(),
            status: "pending".to_string(),
            detail: "Generate a fine-grained PAT at github.com/settings/personal-access-tokens with read access to your repos, then paste it here.".to_string(),
            error: None,
        };
    }
    let res = super::secret_store::secret_store_set_oauth(
        super::secret_store::SecretStoreSetOauthArgs {
            source: "github".to_string(),
            account: login.clone(),
            access_token: pat,
            refresh_token: None,
            expires_at: None,
        },
    )
    .await;
    setup_source_outcome("setup_source_github", "GitHub", &login, res)
}

async fn execute_setup_source_discord(params: &serde_json::Value) -> OnboardingAction {
    let token = string_param(params, "bot_token");
    let account = string_or_default(params, "account", "default");
    if token.is_empty() {
        return OnboardingAction {
            kind: "setup_source_discord".to_string(),
            status: "pending".to_string(),
            detail: "Open the Discord Developer Portal to create a bot and paste its token. The discord_bot_guide action walks through this in detail.".to_string(),
            error: None,
        };
    }
    let res = super::secret_store::secret_store_set_oauth(
        super::secret_store::SecretStoreSetOauthArgs {
            source: "discord".to_string(),
            account: account.clone(),
            access_token: token,
            refresh_token: None,
            expires_at: None,
        },
    )
    .await;
    setup_source_outcome("setup_source_discord", "Discord", &account, res)
}

fn setup_source_outcome(
    kind: &str,
    label: &str,
    account: &str,
    res: Result<(), AppError>,
) -> OnboardingAction {
    match res {
        Ok(()) => OnboardingAction {
            kind: kind.to_string(),
            status: "succeeded".to_string(),
            detail: format!("Stored {label} credentials for {account} in OS keychain"),
            error: None,
        },
        Err(e) => OnboardingAction {
            kind: kind.to_string(),
            status: "failed".to_string(),
            detail: format!("Couldn't store {label} credentials"),
            error: Some(format!("{e:?}")),
        },
    }
}

fn string_param(params: &serde_json::Value, key: &str) -> String {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn string_or_default(params: &serde_json::Value, key: &str, default: &str) -> String {
    let s = string_param(params, key);
    if s.is_empty() {
        default.to_string()
    } else {
        s
    }
}

fn optional_string_param(params: &serde_json::Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}
// === end wave 1.13-E ===

async fn execute_configure_mcp(params: &serde_json::Value) -> OnboardingAction {
    let tool_id = params
        .get("tool_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if tool_id.is_empty() {
        return OnboardingAction {
            kind: "configure_mcp".to_string(),
            status: "failed".to_string(),
            detail: "configure_mcp requires tool_id".to_string(),
            error: Some("missing_tool_id".to_string()),
        };
    }
    match super::setup_wizard::setup_wizard_auto_configure_mcp(tool_id.clone()).await {
        Ok(r) if r.ok => OnboardingAction {
            kind: "configure_mcp".to_string(),
            status: "succeeded".to_string(),
            detail: format!(
                "Wrote Tangerine MCP entry to {} (restart {} to activate)",
                r.file_written.display(),
                tool_id
            ),
            error: None,
        },
        Ok(r) => OnboardingAction {
            kind: "configure_mcp".to_string(),
            status: "failed".to_string(),
            detail: format!("Couldn't write {}", r.file_written.display()),
            error: r.error,
        },
        Err(e) => OnboardingAction {
            kind: "configure_mcp".to_string(),
            status: "failed".to_string(),
            detail: "configure_mcp dispatch error".to_string(),
            error: Some(format!("{e:?}")),
        },
    }
}

async fn execute_git_remote_set(params: &serde_json::Value) -> OnboardingAction {
    let remote_url = params
        .get("remote_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if remote_url.is_empty() {
        return OnboardingAction {
            kind: "git_remote_set".to_string(),
            status: "failed".to_string(),
            detail: "git_remote_set requires remote_url".to_string(),
            error: Some("missing_remote_url".to_string()),
        };
    }
    let args = super::git_sync::GitSyncInitArgs {
        remote_url: Some(remote_url.clone()),
        default_user_alias: None,
    };
    match super::git_sync::git_sync_init(args).await {
        Ok(_status) => OnboardingAction {
            kind: "git_remote_set".to_string(),
            status: "succeeded".to_string(),
            detail: format!("Linked memory repo to {remote_url}"),
            error: None,
        },
        Err(e) => OnboardingAction {
            kind: "git_remote_set".to_string(),
            status: "failed".to_string(),
            detail: "Couldn't initialize git remote".to_string(),
            error: Some(format!("{e:?}")),
        },
    }
}

/// Whisper download is fire-and-forget on the backend (the real command
/// streams progress events on a per-id channel — wiring that into the chat UI
/// is a follow-up). We mark the action `pending` and let the React side spin
/// up the actual download via the existing `download_whisper_model` command.
fn execute_whisper_download(params: &serde_json::Value) -> OnboardingAction {
    let size = params
        .get("size")
        .and_then(|v| v.as_str())
        .unwrap_or("small");
    OnboardingAction {
        kind: "whisper_download".to_string(),
        status: "pending".to_string(),
        detail: format!("Download Whisper {size} model (~244MB)"),
        error: None,
    }
}

// ---------------------------------------------------------------------------
// Persistence — append-only JSONL per session under
// `<home>/.tangerine-memory/.tangerine/onboarding_chat.jsonl`.
// ---------------------------------------------------------------------------

fn onboarding_chat_log_path() -> PathBuf {
    let base = dirs::home_dir()
        .map(|h| h.join(".tangerine-memory"))
        .or_else(dirs::data_local_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(".tangerine").join("onboarding_chat.jsonl")
}

#[derive(Debug, Clone, Serialize)]
struct PersistedTurn<'a> {
    session_id: &'a str,
    ts: String,
    role: &'a str,
    content: &'a str,
    actions: &'a [OnboardingAction],
}

fn append_turn(
    session_id: &str,
    role: &str,
    content: &str,
    actions: &[OnboardingAction],
) -> Result<(), AppError> {
    let path = onboarding_chat_log_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir_onboarding_chat", e.to_string()))?;
    }
    let entry = PersistedTurn {
        session_id,
        ts: chrono::Utc::now().to_rfc3339(),
        role,
        content,
        actions,
    };
    let mut line = serde_json::to_string(&entry)
        .map_err(|e| AppError::internal("serialize_turn", e.to_string()))?;
    line.push('\n');
    use std::io::Write;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| AppError::internal("open_onboarding_chat_log", e.to_string()))?;
    f.write_all(line.as_bytes())
        .map_err(|e| AppError::internal("write_onboarding_chat_log", e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Public Tauri command
// ---------------------------------------------------------------------------

/// Process one user message in the conversational onboarding flow. See module
/// doc for the full lifecycle.
#[tauri::command]
pub async fn onboarding_chat_turn(
    args: OnboardingChatTurnArgs,
) -> Result<OnboardingChatTurn, AppError> {
    // Persist the user's message first so a backend crash mid-LLM still
    // leaves the question on disk for diagnostics.
    let user_actions: Vec<OnboardingAction> = Vec::new();
    let _ = append_turn(&args.session_id, "user", &args.user_message, &user_actions);

    // Build the LLM call.
    let request = LlmRequest {
        system_prompt: SYSTEM_PROMPT.to_string(),
        user_prompt: build_user_prompt(&args.user_message),
        max_tokens: Some(512),
        temperature: Some(0.2),
    };

    let raw = match dispatch(request, args.primary_tool_id.clone()).await {
        Ok(resp) => resp.text,
        Err(e) => {
            // No LLM channel reachable — respond gracefully so the user
            // knows they can fall back to the form wizard.
            let reply = friendly_unreachable_reply(&e);
            let turn = OnboardingChatTurn {
                role: "assistant".to_string(),
                content: reply.clone(),
                actions_taken: Vec::new(),
                actions_pending: Vec::new(),
            };
            let _ = append_turn(&args.session_id, "assistant", &reply, &[]);
            return Ok(turn);
        }
    };

    // Parse the JSON action plan.
    let plan = match parse_action_plan(&raw) {
        Some(p) => p,
        None => {
            let reply = "Sorry, I didn't catch that. Could you rephrase? You can also press Cmd+K and pick \"Use form-based setup\" if you'd rather fill out a form.".to_string();
            let turn = OnboardingChatTurn {
                role: "assistant".to_string(),
                content: reply.clone(),
                actions_taken: Vec::new(),
                actions_pending: Vec::new(),
            };
            let _ = append_turn(&args.session_id, "assistant", &reply, &[]);
            return Ok(turn);
        }
    };

    // Execute every action sequentially. We don't parallelize — the total
    // count is small (1-4) and serial is easier to debug.
    let mut actions_taken: Vec<OnboardingAction> = Vec::new();
    let mut actions_pending: Vec<OnboardingAction> = Vec::new();
    for req in &plan.actions {
        let executed = execute_action(req).await;
        if executed.status == "pending" {
            actions_pending.push(executed);
        } else {
            actions_taken.push(executed);
        }
    }

    // Persist + return the assistant turn.
    let mut all_actions = actions_taken.clone();
    all_actions.extend(actions_pending.clone());
    let _ = append_turn(&args.session_id, "assistant", &plan.reply, &all_actions);
    Ok(OnboardingChatTurn {
        role: "assistant".to_string(),
        content: plan.reply,
        actions_taken,
        actions_pending,
    })
}

fn friendly_unreachable_reply(err: &BorrowError) -> String {
    match err {
        BorrowError::AllExhausted => {
            "I can't reach an LLM yet. Open one of your AI editors (Cursor / Claude Code / Codex / Windsurf) so I can borrow its session — or run `ollama serve` to fall back to a local model. Press Cmd+K and pick \"Use form-based setup\" to skip the chat for now.".to_string()
        }
        BorrowError::PrimaryUnreachable { tool_id, .. } => format!(
            "{tool_id} isn't responding. Try restarting it, or pick a different tool — say something like \"primary=Cursor\" and I'll re-route."
        ),
        BorrowError::NotImplemented(_) => {
            "That channel isn't wired up yet. Pick another AI tool or open the form wizard via Cmd+K → \"Use form-based setup\".".to_string()
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_action_plan_handles_clean_json() {
        let raw = r#"{"reply": "ok", "actions": [{"kind": "configure_mcp", "params": {"tool_id": "claude-code"}}]}"#;
        let p = parse_action_plan(raw).expect("parse");
        assert_eq!(p.reply, "ok");
        assert_eq!(p.actions.len(), 1);
        assert_eq!(p.actions[0].kind, "configure_mcp");
        assert_eq!(
            p.actions[0].params["tool_id"].as_str().unwrap(),
            "claude-code"
        );
    }

    #[test]
    fn parse_action_plan_strips_markdown_fence() {
        let raw = "```json\n{\"reply\": \"hi\", \"actions\": []}\n```";
        let p = parse_action_plan(raw).expect("parse");
        assert_eq!(p.reply, "hi");
        assert!(p.actions.is_empty());
    }

    #[test]
    fn parse_action_plan_returns_none_on_garbage() {
        assert!(parse_action_plan("not json at all").is_none());
        assert!(parse_action_plan("{bad: json}").is_none());
    }

    #[test]
    fn parse_action_plan_returns_none_on_missing_reply() {
        let raw = r#"{"actions": []}"#;
        // serde-default kicks in for `actions` but `reply` is required so
        // this should be None.
        assert!(parse_action_plan(raw).is_none());
    }

    #[tokio::test]
    async fn execute_action_unknown_kind_returns_failed() {
        let req = LlmActionRequest {
            kind: "summon_dragon".to_string(),
            params: serde_json::json!({}),
        };
        let r = execute_action(&req).await;
        assert_eq!(r.status, "failed");
        assert_eq!(r.kind, "summon_dragon");
        assert!(r.error.is_some());
    }

    #[tokio::test]
    async fn execute_action_discord_guide_returns_pending_no_error() {
        let req = LlmActionRequest {
            kind: "discord_bot_guide".to_string(),
            params: serde_json::json!({}),
        };
        let r = execute_action(&req).await;
        assert_eq!(r.status, "pending");
        assert_eq!(r.kind, "discord_bot_guide");
        assert!(r.error.is_none());
    }

    #[tokio::test]
    async fn execute_action_restart_required_includes_tool_name() {
        let req = LlmActionRequest {
            kind: "restart_required".to_string(),
            params: serde_json::json!({"tool": "Cursor"}),
        };
        let r = execute_action(&req).await;
        assert_eq!(r.status, "pending");
        assert!(r.detail.contains("Cursor"), "got {}", r.detail);
    }

    #[tokio::test]
    async fn execute_action_configure_mcp_missing_tool_id_fails() {
        let req = LlmActionRequest {
            kind: "configure_mcp".to_string(),
            params: serde_json::json!({}),
        };
        let r = execute_action(&req).await;
        assert_eq!(r.status, "failed");
        assert_eq!(r.error.as_deref(), Some("missing_tool_id"));
    }

    #[tokio::test]
    async fn execute_action_git_remote_set_missing_url_fails() {
        let req = LlmActionRequest {
            kind: "git_remote_set".to_string(),
            params: serde_json::json!({}),
        };
        let r = execute_action(&req).await;
        assert_eq!(r.status, "failed");
        assert_eq!(r.error.as_deref(), Some("missing_remote_url"));
    }

    #[tokio::test]
    async fn execute_action_whisper_download_returns_pending_with_size() {
        let req = LlmActionRequest {
            kind: "whisper_download".to_string(),
            params: serde_json::json!({"size": "base"}),
        };
        let r = execute_action(&req).await;
        assert_eq!(r.status, "pending");
        assert!(r.detail.contains("base"), "got {}", r.detail);
    }

    #[test]
    fn friendly_unreachable_reply_all_exhausted_mentions_fallback() {
        let r = friendly_unreachable_reply(&BorrowError::AllExhausted);
        assert!(r.contains("Cmd+K"), "got {r}");
    }

    #[test]
    fn friendly_unreachable_reply_primary_mentions_tool_name() {
        let r = friendly_unreachable_reply(&BorrowError::PrimaryUnreachable {
            tool_id: "cursor".to_string(),
            reason: "timeout".to_string(),
            cause: crate::agi::session_borrower::PrimaryUnreachableCause::Unknown,
        });
        assert!(r.contains("cursor"), "got {r}");
    }

    // === wave 1.13-E ===
    #[tokio::test]
    async fn setup_source_lark_pending_when_credentials_missing() {
        let req = LlmActionRequest {
            kind: "setup_source_lark".to_string(),
            params: serde_json::json!({}),
        };
        let r = execute_action(&req).await;
        assert_eq!(r.status, "pending");
        assert!(r.detail.contains("app_id"), "got {}", r.detail);
        assert!(r.error.is_none());
    }

    #[tokio::test]
    async fn setup_source_zoom_pending_emits_oauth_url() {
        let req = LlmActionRequest {
            kind: "setup_source_zoom".to_string(),
            params: serde_json::json!({}),
        };
        let r = execute_action(&req).await;
        assert_eq!(r.status, "pending");
        assert!(r.detail.contains("zoom.us/oauth"), "got {}", r.detail);
    }

    #[tokio::test]
    async fn setup_source_github_succeeds_with_pat_inline() {
        // Use a per-run login so we don't pollute the developer's actual
        // keychain entries.
        let login = format!("test-{}", uuid::Uuid::new_v4().simple());
        let req = LlmActionRequest {
            kind: "setup_source_github".to_string(),
            params: serde_json::json!({"personal_access_token": "ghp_test", "login": login}),
        };
        let r = execute_action(&req).await;
        assert_eq!(r.status, "succeeded", "detail={}", r.detail);
        assert!(r.detail.contains("GitHub"));
        // Cleanup the keychain entry we just wrote.
        let _ = super::super::secret_store::secret_store_delete_oauth(
            super::super::secret_store::SecretStoreGetOauthArgs {
                source: "github".to_string(),
                account: login,
            },
        )
        .await;
    }

    #[test]
    fn system_prompt_lists_all_setup_source_kinds() {
        // Defensive: if anyone removes a kind from the prompt the LLM stops
        // emitting it. Lock the surface here.
        for kind in [
            "setup_source_lark",
            "setup_source_zoom",
            "setup_source_teams",
            "setup_source_slack",
            "setup_source_github",
            "setup_source_discord",
        ] {
            assert!(
                SYSTEM_PROMPT.contains(kind),
                "SYSTEM_PROMPT missing kind: {kind}"
            );
        }
    }
    // === end wave 1.13-E ===

    #[test]
    fn append_turn_creates_parent_dir_and_appends_jsonl() {
        // Use a unique session id so we don't clobber other test runs and
        // can read the line back deterministically. The on-disk path is
        // shared with prod, but the per-line `session_id` keeps this test's
        // entries identifiable.
        let session = format!("test-{}", uuid::Uuid::new_v4().simple());
        let actions: Vec<OnboardingAction> = Vec::new();
        append_turn(&session, "user", "hello world", &actions).expect("append");
        let path = onboarding_chat_log_path();
        let body = fs::read_to_string(&path).expect("read jsonl");
        let line = body
            .lines()
            .find(|l| l.contains(&session))
            .expect("our line is on disk");
        let v: serde_json::Value = serde_json::from_str(line).expect("parse line");
        assert_eq!(v["session_id"].as_str().unwrap(), session);
        assert_eq!(v["role"].as_str().unwrap(), "user");
        assert_eq!(v["content"].as_str().unwrap(), "hello world");
    }
}
