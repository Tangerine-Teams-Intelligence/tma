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
  provider: "openai" | "local";
  api_key_env: string;
  model: string;
  chunk_seconds: number;
  language: string | null;
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
  cfg.whisper = {
    provider: cfg.whisper?.provider ?? "openai",
    api_key_env: cfg.whisper?.api_key_env ?? "OPENAI_API_KEY",
    model: cfg.whisper?.model ?? "whisper-1",
    chunk_seconds: cfg.whisper?.chunk_seconds ?? 10,
    language: cfg.whisper?.language ?? null,
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
