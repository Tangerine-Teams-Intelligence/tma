//! Server-side Discord wizard helpers. T1's UI tries client-side fetch first
//! (CORS-permitted on the Discord API) and falls back to these commands when
//! a corporate proxy or browser quirk blocks the request.

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{AppError, AppState};

#[derive(Debug, Deserialize)]
pub struct PollGuildsArgs {
    pub token: String,
}

#[derive(Debug, Serialize)]
pub struct GuildEntry {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct PollGuildsResult {
    pub guilds: Vec<GuildEntry>,
}

#[tauri::command]
pub async fn poll_discord_bot_presence(
    state: State<'_, AppState>,
    args: PollGuildsArgs,
) -> Result<PollGuildsResult, AppError> {
    if args.token.trim().is_empty() {
        return Err(AppError::user("empty_token", "discord token must not be empty"));
    }
    let resp = state
        .http
        .get("https://discord.com/api/v10/users/@me/guilds")
        .header("Authorization", format!("Bot {}", args.token.trim()))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::external(
            "discord_api",
            format!("status {}", resp.status()),
        ));
    }
    #[derive(Deserialize)]
    struct G {
        id: String,
        name: String,
    }
    let guilds: Vec<G> = resp.json().await?;
    Ok(PollGuildsResult {
        guilds: guilds
            .into_iter()
            .map(|g| GuildEntry { id: g.id, name: g.name })
            .collect(),
    })
}

#[derive(Debug, Deserialize)]
pub struct ValidateDiscordArgs {
    pub token: String,
}
#[derive(Debug, Serialize)]
pub struct ValidateDiscordResult {
    pub ok: bool,
    pub bot_id: Option<String>,
    pub bot_username: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn validate_discord_bot_token(
    state: State<'_, AppState>,
    args: ValidateDiscordArgs,
) -> Result<ValidateDiscordResult, AppError> {
    let resp = state
        .http
        .get("https://discord.com/api/v10/users/@me")
        .header("Authorization", format!("Bot {}", args.token.trim()))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Ok(ValidateDiscordResult {
            ok: false,
            bot_id: None,
            bot_username: None,
            error: Some(format!("status {}", resp.status())),
        });
    }
    #[derive(Deserialize)]
    struct Me {
        id: String,
        username: String,
    }
    let me: Me = resp.json().await?;
    Ok(ValidateDiscordResult {
        ok: true,
        bot_id: Some(me.id),
        bot_username: Some(me.username),
        error: None,
    })
}

#[derive(Debug, Deserialize)]
pub struct ValidateWhisperArgs {
    pub key: String,
}
#[derive(Debug, Serialize)]
pub struct ValidateWhisperResult {
    pub ok: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn validate_whisper_key(
    state: State<'_, AppState>,
    args: ValidateWhisperArgs,
) -> Result<ValidateWhisperResult, AppError> {
    let key = args.key.trim();
    if !(key.starts_with("sk-") && key.len() >= 40) {
        return Ok(ValidateWhisperResult {
            ok: false,
            error: Some("key must start with 'sk-' and be at least 40 chars".into()),
        });
    }
    // Light-touch check: GET /v1/models with the key. Avoids spending audio
    // credits and works regardless of project-vs-user-key shape.
    let resp = state
        .http
        .get("https://api.openai.com/v1/models")
        .bearer_auth(key)
        .send()
        .await?;
    if resp.status().is_success() {
        Ok(ValidateWhisperResult { ok: true, error: None })
    } else if resp.status().as_u16() == 401 {
        Ok(ValidateWhisperResult {
            ok: false,
            error: Some("Invalid key — check OpenAI dashboard.".into()),
        })
    } else {
        Ok(ValidateWhisperResult {
            ok: false,
            error: Some(format!("status {}", resp.status())),
        })
    }
}
