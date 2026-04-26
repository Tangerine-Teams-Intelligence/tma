"""intents/<alias>.md frontmatter + body schema; read/write helpers.

Spec: INTERFACES.md §2.2.
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ValidationError, field_validator

from .config import ALIAS_RE
from .utils import atomic_write_text

TopicType = Literal["decision", "sync", "brainstorm", "review", "status_update", "other"]


class IntentFrontmatter(BaseModel):
    schema_version: int = 1
    author: str
    created_at: datetime
    locked: bool = False
    locked_at: datetime | None = None
    turn_count: int = 0

    @field_validator("author")
    @classmethod
    def _alias_fmt(cls, v: str) -> str:
        if not ALIAS_RE.match(v):
            raise ValueError(f"author alias {v!r} must match {ALIAS_RE.pattern}")
        return v


# ----------------------------------------------------------------------
# Parsing

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?\n)---\s*\n(.*)$", re.DOTALL)


def split_frontmatter(text: str) -> tuple[dict, str]:
    m = FRONTMATTER_RE.match(text)
    if not m:
        raise ValueError("intent missing YAML frontmatter (--- ... ---)")
    fm_raw = m.group(1)
    body = m.group(2)
    fm = yaml.safe_load(fm_raw) or {}
    if not isinstance(fm, dict):
        raise ValueError("intent frontmatter must be a YAML mapping")
    return fm, body


def join_frontmatter(fm: IntentFrontmatter, body: str) -> str:
    payload = fm.model_dump(mode="json")
    fm_text = yaml.safe_dump(payload, sort_keys=False, default_flow_style=False, allow_unicode=True)
    if not body.startswith("\n"):
        body = "\n" + body
    return f"---\n{fm_text}---{body}"


def validate_intent_text(text: str) -> tuple[IntentFrontmatter, str]:
    """Parse + validate frontmatter and required body sections.

    Returns (frontmatter, body). Raises ValueError on any violation.
    """
    fm_raw, body = split_frontmatter(text)
    try:
        fm = IntentFrontmatter.model_validate(fm_raw)
    except ValidationError as e:
        raise ValueError(f"frontmatter invalid: {e}") from e

    # Body must contain `## Topics` header and >=1 `### Topic` block
    if "## Topics" not in body:
        raise ValueError("body must contain `## Topics` heading")
    topic_blocks = re.findall(r"^###\s+Topic\b.*$", body, flags=re.MULTILINE)
    if len(topic_blocks) < 1:
        raise ValueError("body must contain >=1 `### Topic ...` block")

    # Each topic must have `Type` and `Goal`. Lines may be bulleted (`- **Type**: ...`)
    # or unbulleted (`**Type**: ...`).
    sections = re.split(r"^###\s+", body, flags=re.MULTILINE)
    type_re = re.compile(r"^\s*(?:[-*]\s+)?\*\*Type\*\*\s*:", re.MULTILINE)
    goal_re = re.compile(r"^\s*(?:[-*]\s+)?\*\*Goal\*\*\s*:", re.MULTILINE)
    type_val_re = re.compile(r"^\s*(?:[-*]\s+)?\*\*Type\*\*\s*:\s*(\S+)", re.MULTILINE)
    for sect in sections[1:]:
        if not type_re.search(sect):
            raise ValueError(f"topic missing **Type**: in section starting `### {sect[:40]}...`")
        if not goal_re.search(sect):
            raise ValueError(f"topic missing **Goal**: in section starting `### {sect[:40]}...`")
        m = type_val_re.search(sect)
        if m:
            t = m.group(1).strip().lower()
            if t not in {"decision", "sync", "brainstorm", "review", "status_update", "other"}:
                raise ValueError(
                    f"unknown Type {t!r}; must be one of decision|sync|brainstorm|review|status_update|other"
                )
    return fm, body


# ----------------------------------------------------------------------
# I/O

def intent_path(meeting_dir: Path, alias: str) -> Path:
    return meeting_dir / "intents" / f"{alias}.md"


def write_intent(meeting_dir: Path, alias: str, full_markdown: str) -> IntentFrontmatter:
    """Validate and write intents/<alias>.md atomically. Returns parsed frontmatter."""
    fm, _body = validate_intent_text(full_markdown)
    if fm.author != alias:
        raise ValueError(f"frontmatter.author={fm.author!r} != alias={alias!r}")
    atomic_write_text(intent_path(meeting_dir, alias), full_markdown)
    return fm


def read_intent(meeting_dir: Path, alias: str) -> tuple[IntentFrontmatter, str]:
    p = intent_path(meeting_dir, alias)
    if not p.exists():
        raise FileNotFoundError(f"intent for {alias!r} not found at {p}")
    return validate_intent_text(p.read_text(encoding="utf-8"))


def is_locked(meeting_dir: Path, alias: str) -> bool:
    try:
        fm, _ = read_intent(meeting_dir, alias)
    except (FileNotFoundError, ValueError):
        return False
    return fm.locked


__all__ = [
    "IntentFrontmatter",
    "TopicType",
    "split_frontmatter",
    "join_frontmatter",
    "validate_intent_text",
    "intent_path",
    "write_intent",
    "read_intent",
    "is_locked",
]
