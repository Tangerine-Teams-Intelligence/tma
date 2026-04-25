"""Config schema + load/save/validate for ~/.tmi/config.yaml.

Spec: INTERFACES.md §3.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

DEFAULT_CONFIG_PATH = Path.home() / ".tmi" / "config.yaml"

ALIAS_RE = re.compile(r"^[a-z][a-z0-9_]*$")
DISCORD_ID_RE = re.compile(r"^\d{17,20}$")


class WhisperConfig(BaseModel):
    provider: Literal["openai", "local"] = "openai"
    api_key_env: str = "OPENAI_API_KEY"
    model: str = "whisper-1"
    chunk_seconds: int = Field(default=10, ge=5, le=30)
    language: str | None = None

    @field_validator("provider")
    @classmethod
    def _provider_v1(cls, v: str) -> str:
        if v != "openai":
            raise ValueError("v1 only supports whisper.provider=openai")
        return v


class DiscordConfig(BaseModel):
    bot_token_env: str = "DISCORD_BOT_TOKEN"
    guild_id: str | None = None
    command_prefix: str = "tmi"


class ClaudeConfig(BaseModel):
    cli_path: str | None = None
    subscription_check: bool = True
    default_timeout_seconds: int = 120


class AdapterFiles(BaseModel):
    claude_md: str = "CLAUDE.md"
    knowledge_dir: str = "knowledge/"
    session_state: str = "knowledge/session-state.md"

    @field_validator("knowledge_dir")
    @classmethod
    def _trailing_slash(cls, v: str) -> str:
        if not v.endswith("/"):
            raise ValueError("knowledge_dir must end with '/'")
        return v


class OutputAdapter(BaseModel):
    type: Literal["claude_code"] = "claude_code"
    name: str
    target_repo: str
    files: AdapterFiles = Field(default_factory=AdapterFiles)
    commit_author: str = "Tangerine Meeting Assistant <tma@tangerine.local>"
    auto_push: bool = False

    @field_validator("auto_push")
    @classmethod
    def _no_auto_push(cls, v: bool) -> bool:
        if v:
            raise ValueError("output_adapters[].auto_push must be false in v1")
        return v


class TeamMember(BaseModel):
    alias: str
    display_name: str
    discord_id: str | None = None

    @field_validator("alias")
    @classmethod
    def _alias_fmt(cls, v: str) -> str:
        if not ALIAS_RE.match(v):
            raise ValueError(f"alias {v!r} must match {ALIAS_RE.pattern}")
        return v

    @field_validator("discord_id")
    @classmethod
    def _discord_fmt(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not DISCORD_ID_RE.match(v):
            raise ValueError(f"discord_id {v!r} must match {DISCORD_ID_RE.pattern}")
        return v


class LoggingConfig(BaseModel):
    level: Literal["debug", "info", "warn", "error"] = "info"
    file: str = "~/.tmi/tmi.log"


class Config(BaseModel):
    schema_version: int = 1
    meetings_repo: str
    whisper: WhisperConfig = Field(default_factory=WhisperConfig)
    discord: DiscordConfig = Field(default_factory=DiscordConfig)
    claude: ClaudeConfig = Field(default_factory=ClaudeConfig)
    output_adapters: list[OutputAdapter] = Field(default_factory=list)
    team: list[TeamMember] = Field(default_factory=list)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)

    @field_validator("schema_version")
    @classmethod
    def _schema_v(cls, v: int) -> int:
        if v > 1:
            raise ValueError("newer TMA wrote this file; please upgrade")
        return v

    @model_validator(mode="after")
    def _team_aliases_unique(self) -> "Config":
        seen: set[str] = set()
        for m in self.team:
            if m.alias in seen:
                raise ValueError(f"team alias {m.alias!r} duplicated")
            seen.add(m.alias)
        names: set[str] = set()
        for a in self.output_adapters:
            if a.name in names:
                raise ValueError(f"output_adapters[].name {a.name!r} duplicated")
            names.add(a.name)
        return self

    # ------------------------------------------------------------------
    # Convenience

    def adapter_by_name(self, name: str) -> OutputAdapter:
        for a in self.output_adapters:
            if a.name == name:
                return a
        raise KeyError(f"adapter {name!r} not in config")

    def meetings_repo_path(self) -> Path:
        return Path(self.meetings_repo).expanduser()

    def logfile_path(self) -> Path:
        return Path(self.logging.file).expanduser()

    def memory_root_path(self, adapter_name: str | None = None) -> Path:
        """Resolve the memory layer root: ``<target_repo>/memory`` per the
        memory-layer spec.

        Resolution order:
          1. If ``adapter_name`` is given and resolves: use that adapter's
             ``target_repo``.
          2. Else if exactly one ``output_adapters`` entry exists: use its
             ``target_repo``.
          3. Else default to ``~/.tangerine-memory``.

        Returns the *root* directory (containing ``meetings/``, ``decisions/``,
        etc.). Caller is responsible for creating subdirectories.
        """
        target_repo: Path | None = None
        if adapter_name is not None:
            try:
                target_repo = Path(self.adapter_by_name(adapter_name).target_repo)
            except KeyError:
                target_repo = None
        if target_repo is None and len(self.output_adapters) == 1:
            target_repo = Path(self.output_adapters[0].target_repo)

        if target_repo is None:
            return (Path.home() / ".tangerine-memory").expanduser()
        return target_repo.expanduser() / "memory"


# ----------------------------------------------------------------------
# I/O

DEFAULT_TEMPLATE = """\
# Tangerine Meeting Assistant config — see INTERFACES.md §3.
# Edit values; never commit secrets. All API keys live in env vars.
schema_version: 1

# Required. Absolute path to git repo where meetings/ lives.
meetings_repo: "{meetings_repo}"

whisper:
  provider: openai            # v1: openai only
  api_key_env: OPENAI_API_KEY # env var holding key (never inline secrets)
  model: whisper-1
  chunk_seconds: 10           # 5..30
  language: null              # ISO 639-1 or null for auto-detect

discord:
  bot_token_env: DISCORD_BOT_TOKEN
  guild_id: null              # set to a guild ID to scope commands
  command_prefix: tmi

claude:
  cli_path: null              # null = auto-detect via PATH
  subscription_check: true
  default_timeout_seconds: 120

output_adapters:
  - type: claude_code
    name: tangerine-main
    target_repo: "{target_repo}"
    files:
      claude_md: "CLAUDE.md"
      knowledge_dir: "knowledge/"
      session_state: "knowledge/session-state.md"
    commit_author: "Tangerine Meeting Assistant <tma@tangerine.local>"
    auto_push: false          # MUST stay false in v1

team:
  - alias: daizhe
    display_name: "Daizhe Zou"
    discord_id: null

logging:
  level: info
  file: "~/.tmi/tmi.log"
"""


def render_default_template(meetings_repo: Path, target_repo: Path | None = None) -> str:
    return DEFAULT_TEMPLATE.format(
        meetings_repo=str(meetings_repo).replace("\\", "/"),
        target_repo=str(target_repo or meetings_repo).replace("\\", "/"),
    )


def load_config(path: Path | None = None) -> Config:
    """Load + validate. On error, prints to stderr and exits 2 (per spec §3)."""
    p = (path or DEFAULT_CONFIG_PATH).expanduser()
    if not p.exists():
        print(f"error: config not found at {p}; run `tmi init`", file=sys.stderr)
        sys.exit(2)
    try:
        with open(p, encoding="utf-8") as f:
            raw = yaml.safe_load(f) or {}
        cfg = Config.model_validate(raw)
    except (yaml.YAMLError, ValidationError, ValueError) as e:
        print(f"error: invalid config at {p}: {e}", file=sys.stderr)
        sys.exit(2)
    return cfg


def save_config(cfg: Config, path: Path | None = None) -> Path:
    p = (path or DEFAULT_CONFIG_PATH).expanduser()
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = cfg.model_dump(mode="json")
    text = yaml.safe_dump(payload, sort_keys=False, default_flow_style=False, allow_unicode=True)
    from .utils import atomic_write_text

    atomic_write_text(p, text)
    return p


def env_or_none(name: str) -> str | None:
    v = os.environ.get(name)
    if not v:
        return None
    return v


__all__ = [
    "Config",
    "WhisperConfig",
    "DiscordConfig",
    "ClaudeConfig",
    "OutputAdapter",
    "AdapterFiles",
    "TeamMember",
    "LoggingConfig",
    "DEFAULT_CONFIG_PATH",
    "load_config",
    "save_config",
    "render_default_template",
    "env_or_none",
]
