// Read-only config loader. Bot reads ~/.tmi/config.yaml; never writes.
// Spec: INTERFACES.md §3.

import { readFileSync } from "node:fs";
import yaml from "js-yaml";

export interface TeamMember {
  alias: string;
  display_name: string;
  discord_id: string | null;
}

export interface WhisperConfig {
  /** "local" = bundled faster-whisper (default). "openai" = OpenAI Whisper API. */
  provider: "openai" | "local";
  /** Env var name to read OpenAI key from. Only required when provider=openai. */
  api_key_env: string;
  /** OpenAI model name (e.g. "whisper-1"). Ignored in local mode. */
  model: string;
  chunk_seconds: number;
  language: string | null;
  /** Local mode: absolute path to bundled python.exe. Required when provider=local. */
  python_exe?: string | null;
  /** Local mode: absolute path to faster-whisper model dir. Required when provider=local. */
  local_model_dir?: string | null;
}

export interface DiscordConfig {
  bot_token_env: string;
  guild_id: string | null;
  command_prefix: string;
}

export interface TmiConfig {
  schema_version: number;
  meetings_repo: string;
  whisper: WhisperConfig;
  discord: DiscordConfig;
  team: TeamMember[];
}

export function loadConfig(path: string): TmiConfig {
  const raw = readFileSync(path, "utf8");
  const parsed = yaml.load(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`config.yaml at ${path} is not a YAML object`);
  }
  if (parsed.schema_version !== 1) {
    throw new Error(
      `config.yaml schema_version must be 1, got ${String(parsed.schema_version)}`,
    );
  }
  const cfg = parsed as unknown as TmiConfig;
  // Apply defaults the bot relies on.
  // Default to "local" — v1.5 ships bundled faster-whisper so users pay $0.
  // WHISPER_MODE env var overrides config (used by Tauri-spawned bot when the
  // user toggles mode in settings without a config rewrite).
  const envMode = process.env.WHISPER_MODE;
  const provider: "local" | "openai" =
    envMode === "openai" || envMode === "local"
      ? envMode
      : (cfg.whisper?.provider ?? "local");
  cfg.whisper = {
    provider,
    api_key_env: cfg.whisper?.api_key_env ?? "OPENAI_API_KEY",
    model: cfg.whisper?.model ?? "whisper-1",
    chunk_seconds: cfg.whisper?.chunk_seconds ?? 10,
    language: cfg.whisper?.language ?? null,
    python_exe: cfg.whisper?.python_exe ?? process.env.LOCAL_WHISPER_PYTHON ?? null,
    local_model_dir:
      cfg.whisper?.local_model_dir ?? process.env.LOCAL_WHISPER_MODEL_PATH ?? null,
  };
  cfg.discord = {
    bot_token_env: cfg.discord?.bot_token_env ?? "DISCORD_BOT_TOKEN",
    guild_id: cfg.discord?.guild_id ?? null,
    command_prefix: cfg.discord?.command_prefix ?? "tmi",
  };
  cfg.team = cfg.team ?? [];
  return cfg;
}

export function resolveEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`env var ${name} is not set`);
  }
  return v;
}
