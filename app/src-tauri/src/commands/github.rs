//! GitHub OAuth (device flow) + repo creation for v1.6.0 team memory sync.
//!
//! We use the device-flow grant rather than the redirect grant because we're
//! a desktop app: there's no embedded browser to host a callback URL, no
//! domain to register. The user opens a code on github.com/login/device, we
//! poll until the access_token comes back, then store it via
//! `commands::sync::TokenStore` (OS keychain when available).
//!
//! NB: this requires a public OAuth App client_id registered on GitHub. The
//! placeholder `tangerine_oauth_client_id()` reads from the
//! `TANGERINE_GH_CLIENT_ID` env var first; the CEO must set this before the
//! v1.6.0-alpha tag goes out (see report at end of agent run). For local dev
//! we fall back to the `IV1.0000000000000000` shape so the flow at least
//! returns a structured error instead of panicking.
//!
//! `octocrab` is not used directly here because it pulls in tokio-rustls
//! which conflicts with the existing reqwest+rustls feature set; the GitHub
//! REST surface we touch is small enough (3 endpoints) that hand-rolling on
//! `reqwest` keeps the dep tree lean.

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{AppError, AppState};

/// GitHub OAuth scopes we ask for. `repo` covers private + public; we don't
/// need `read:user` for our flow but include it so the user sees a clear
/// "Tangerine wants: read your profile" line in the consent dialog (less
/// scary than a bare `repo` request).
const SCOPES: &str = "repo read:user";

/// Resolve the OAuth client_id. We prefer an env-var override so the CEO
/// can rotate without recompiling. The hard-coded fallback is a placeholder
/// shape only — when set to the literal placeholder we return a structured
/// error so the UI can surface a clear "Set up GitHub auth" button.
pub fn tangerine_oauth_client_id() -> String {
    if let Ok(v) = std::env::var("TANGERINE_GH_CLIENT_ID") {
        if !v.trim().is_empty() {
            return v.trim().to_string();
        }
    }
    // CEO TODO: register a public GitHub OAuth App at
    //   https://github.com/settings/applications/new
    // and replace this string. Until then, the device-flow handler returns a
    // user-facing error pointing at Settings.
    "PLACEHOLDER_CLIENT_ID".to_string()
}

/// Returned by `github_device_flow_start`. The frontend renders the
/// `verification_uri` (typically https://github.com/login/device) plus the
/// `user_code` the user types into the GitHub page.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeviceFlowStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[tauri::command]
pub async fn github_device_flow_start(
    state: State<'_, AppState>,
) -> Result<DeviceFlowStart, AppError> {
    let client_id = tangerine_oauth_client_id();
    if client_id == "PLACEHOLDER_CLIENT_ID" {
        return Err(AppError::config(
            "github_oauth_unconfigured",
            "GitHub OAuth client_id is not configured. Set TANGERINE_GH_CLIENT_ID or follow the setup link in Settings.",
        ));
    }
    let body = [("client_id", client_id.as_str()), ("scope", SCOPES)];
    let res = state
        .http
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&body)
        .send()
        .await
        .map_err(|e| AppError::external("github_device_start", humanize_http(&e.to_string())))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| AppError::external("github_device_start_body", e.to_string()))?;
    if !status.is_success() {
        return Err(AppError::external(
            "github_device_start_status",
            format!("GitHub returned {}: {}", status.as_u16(), trim_token(&text)),
        ));
    }
    let parsed: DeviceFlowStart = serde_json::from_str(&text)
        .map_err(|e| AppError::external("github_device_start_parse", e.to_string()))?;
    Ok(parsed)
}

#[derive(Debug, Deserialize)]
pub struct DevicePollArgs {
    pub device_code: String,
}

#[derive(Debug, Serialize)]
pub struct DevicePollResult {
    /// "pending" | "ready" | "slow_down". On "ready" the access_token is
    /// stored via TokenStore — the frontend never sees the raw secret.
    pub state: String,
    /// Set when state == "ready". Identifies the token in the keychain so
    /// other commands can reference it without round-tripping the secret.
    pub login: Option<String>,
}

#[tauri::command]
pub async fn github_device_flow_poll(
    state: State<'_, AppState>,
    args: DevicePollArgs,
) -> Result<DevicePollResult, AppError> {
    let client_id = tangerine_oauth_client_id();
    if client_id == "PLACEHOLDER_CLIENT_ID" {
        return Err(AppError::config(
            "github_oauth_unconfigured",
            "GitHub OAuth client_id is not configured. Set TANGERINE_GH_CLIENT_ID or follow the setup link in Settings.",
        ));
    }
    let body = [
        ("client_id", client_id.as_str()),
        ("device_code", args.device_code.as_str()),
        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
    ];
    let res = state
        .http
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&body)
        .send()
        .await
        .map_err(|e| AppError::external("github_poll", humanize_http(&e.to_string())))?;
    let text = res
        .text()
        .await
        .map_err(|e| AppError::external("github_poll_body", e.to_string()))?;
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| AppError::external("github_poll_parse", e.to_string()))?;

    if let Some(err) = parsed.get("error").and_then(|e| e.as_str()) {
        match err {
            "authorization_pending" => {
                return Ok(DevicePollResult {
                    state: "pending".into(),
                    login: None,
                });
            }
            "slow_down" => {
                return Ok(DevicePollResult {
                    state: "slow_down".into(),
                    login: None,
                });
            }
            "expired_token" => {
                return Err(AppError::external(
                    "github_oauth_expired",
                    "GitHub login took too long. Try again?",
                ));
            }
            "access_denied" => {
                return Err(AppError::external(
                    "github_oauth_denied",
                    "Login cancelled on GitHub.",
                ));
            }
            other => {
                return Err(AppError::external(
                    "github_oauth_error",
                    format!("GitHub returned: {}", other),
                ));
            }
        }
    }

    let access_token = parsed
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            AppError::external("github_poll_missing_token", "GitHub returned no token")
        })?;
    let login = lookup_login(&state, access_token).await.unwrap_or_default();
    super::sync::TokenStore::set(&login, access_token)?;
    Ok(DevicePollResult {
        state: "ready".into(),
        login: Some(login),
    })
}

async fn lookup_login(state: &State<'_, AppState>, token: &str) -> Option<String> {
    let res = state
        .http
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "TangerineMeeting")
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let json: serde_json::Value = res.json().await.ok()?;
    json.get("login").and_then(|v| v.as_str()).map(|s| s.to_string())
}

#[derive(Debug, Deserialize)]
pub struct CreateRepoArgs {
    /// GitHub login the token belongs to (used to fetch token from keychain).
    pub login: String,
    /// Repo name. We auto-suffix with a 4-char random tag if not provided so
    /// the champion gets a guaranteed-unique name on first try.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default = "default_private")]
    pub private: bool,
}

fn default_private() -> bool {
    true
}

#[derive(Debug, Serialize)]
pub struct CreateRepoResult {
    pub name: String,
    pub full_name: String,
    pub clone_url: String,
    pub html_url: String,
    pub default_branch: String,
}

#[tauri::command]
pub async fn github_create_repo(
    state: State<'_, AppState>,
    args: CreateRepoArgs,
) -> Result<CreateRepoResult, AppError> {
    let token = super::sync::TokenStore::get(&args.login)?;
    let name = args.name.unwrap_or_else(|| {
        let suffix = random_suffix(4);
        format!("tangerine-memory-{}", suffix)
    });
    let body = serde_json::json!({
        "name": name,
        "private": args.private,
        "auto_init": false,
        "description": "Tangerine team memory — auto-managed. Don't edit by hand.",
    });
    let res = state
        .http
        .post("https://api.github.com/user/repos")
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "TangerineMeeting")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::external("github_create_repo", humanize_http(&e.to_string())))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| AppError::external("github_create_repo_body", e.to_string()))?;
    if !status.is_success() {
        return Err(AppError::external(
            "github_create_repo_status",
            format!("GitHub returned {}: {}", status.as_u16(), trim_token(&text)),
        ));
    }
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| AppError::external("github_create_repo_parse", e.to_string()))?;
    Ok(CreateRepoResult {
        name: parsed
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&name)
            .to_string(),
        full_name: parsed
            .get("full_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        clone_url: parsed
            .get("clone_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        html_url: parsed
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        default_branch: parsed
            .get("default_branch")
            .and_then(|v| v.as_str())
            .unwrap_or("main")
            .to_string(),
    })
}

/// 4-char base36 suffix (uppercase). Cheap collision avoidance for repo names.
fn random_suffix(len: usize) -> String {
    use rand::Rng;
    const ALPHA: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| ALPHA[rng.gen_range(0..ALPHA.len())] as char)
        .collect()
}

fn humanize_http(raw: &str) -> String {
    if raw.contains("error sending request") || raw.contains("dns error") {
        return "Couldn't reach GitHub. Check your internet.".into();
    }
    if raw.contains("connect timed out") {
        return "GitHub is slow to respond. Try again?".into();
    }
    raw.to_string()
}

/// Strip access tokens out of error bodies so we never log a leaked secret.
fn trim_token(s: &str) -> String {
    let mut out = s.to_string();
    for prefix in ["ghp_", "ghs_", "gho_", "github_pat_", "ghu_"] {
        let mut idx = 0;
        while let Some(pos) = out[idx..].find(prefix) {
            let abs = idx + pos;
            // Replace the token-shaped run with REDACTED.
            let end = out[abs..]
                .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .map(|n| abs + n)
                .unwrap_or(out.len());
            out.replace_range(abs..end, "REDACTED");
            idx = abs + "REDACTED".len();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn humanize_dns() {
        assert!(humanize_http("error sending request: dns error").contains("internet"));
        assert!(humanize_http("connect timed out").contains("slow"));
        assert_eq!(humanize_http("plain msg"), "plain msg".to_string());
    }

    #[test]
    fn trim_token_removes_secrets() {
        let body = r#"{"error":"bad","token":"ghp_AAAA1234bbbb5678"}"#;
        let out = trim_token(body);
        assert!(!out.contains("ghp_AAAA"));
        assert!(out.contains("REDACTED"));
    }

    #[test]
    fn trim_token_handles_classic_pat() {
        let body = "github_pat_11ABC_xyz fail";
        let out = trim_token(body);
        assert!(!out.contains("github_pat_11ABC_xyz"));
        assert!(out.contains("REDACTED"));
    }

    #[test]
    fn random_suffix_length() {
        let s = random_suffix(4);
        assert_eq!(s.len(), 4);
        assert!(s.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn placeholder_client_returns_error_when_unset() {
        std::env::remove_var("TANGERINE_GH_CLIENT_ID");
        let id = tangerine_oauth_client_id();
        assert_eq!(id, "PLACEHOLDER_CLIENT_ID");
    }

    #[test]
    fn env_override_wins() {
        std::env::set_var("TANGERINE_GH_CLIENT_ID", "Iv1.real_id");
        assert_eq!(tangerine_oauth_client_id(), "Iv1.real_id");
        std::env::remove_var("TANGERINE_GH_CLIENT_ID");
    }
}
