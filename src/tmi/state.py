"""status.yaml state machine + read/modify/write.

Spec: INTERFACES.md §2.7 + §9.
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field, ValidationError

from .utils import atomic_write_text, now_iso

State = Literal[
    "created",
    "prepped",
    "live",
    "ended",
    "wrapped",
    "reviewed",
    "merged",
    "failed_bot",
    "failed_observer",
    "failed_wrap",
    "failed_apply",
]

LEGAL_TRANSITIONS: dict[str, set[str]] = {
    "created": {"prepped", "live", "failed_bot"},
    "prepped": {"live"},
    "live": {"ended", "failed_bot", "failed_observer"},
    "ended": {"wrapped", "failed_wrap"},
    "wrapped": {"reviewed"},
    "reviewed": {"merged", "failed_apply"},
    "merged": set(),
    "failed_bot": {"live", "ended"},
    "failed_observer": {"live", "ended"},
    "failed_wrap": {"ended", "wrapped"},
    "failed_apply": {"reviewed", "merged"},
}


class IntentEntry(BaseModel):
    ready: bool = False
    locked_at: datetime | None = None


class BotState(BaseModel):
    pid: int | None = None
    started_at: datetime | None = None
    voice_channel_id: str | None = None
    reconnect_count: int = 0


class ObserverState(BaseModel):
    pid: int | None = None
    mode: Literal["prep", "observe", "wrap"] | None = None
    last_poll_at: datetime | None = None


class WrapState(BaseModel):
    completed_at: datetime | None = None
    diff_block_count: int | None = None


class ReviewState(BaseModel):
    approved_block_ids: list[int] = Field(default_factory=list)
    rejected_block_ids: list[int] = Field(default_factory=list)
    edited_block_ids: list[int] = Field(default_factory=list)


class ApplyState(BaseModel):
    target_repo: str | None = None
    commit_sha: str | None = None
    applied_at: datetime | None = None


class ErrorEntry(BaseModel):
    at: datetime
    component: str
    code: str
    detail: str


class Status(BaseModel):
    schema_version: int = 1
    state: State = "created"
    state_updated_at: str = Field(default_factory=now_iso)
    intents: dict[str, IntentEntry] = Field(default_factory=dict)
    bot: BotState = Field(default_factory=BotState)
    observer: ObserverState = Field(default_factory=ObserverState)
    wrap: WrapState = Field(default_factory=WrapState)
    review: ReviewState = Field(default_factory=ReviewState)
    apply: ApplyState = Field(default_factory=ApplyState)
    errors: list[ErrorEntry] = Field(default_factory=list)


# ----------------------------------------------------------------------
# I/O

def status_path(meeting_dir: Path) -> Path:
    return meeting_dir / "status.yaml"


def load_status(meeting_dir: Path) -> Status:
    p = status_path(meeting_dir)
    if not p.exists():
        # initial — caller should write fresh status via save_status
        return Status()
    with open(p, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    try:
        return Status.model_validate(raw)
    except ValidationError as e:
        print(f"error: status.yaml at {p} invalid: {e}", file=sys.stderr)
        sys.exit(2)


def save_status(meeting_dir: Path, status: Status) -> None:
    p = status_path(meeting_dir)
    payload = status.model_dump(mode="json")
    text = yaml.safe_dump(payload, sort_keys=False, default_flow_style=False, allow_unicode=True)
    atomic_write_text(p, text)


def transition(status: Status, target: State, *, force: bool = False) -> Status:
    """Mutate status.state if legal; raise ValueError if not (and not forced)."""
    if status.state == target:
        return status
    allowed = LEGAL_TRANSITIONS.get(status.state, set())
    if target not in allowed and not force:
        raise ValueError(
            f"cannot transition {status.state} -> {target}; use --retry or --force"
        )
    status.state = target
    status.state_updated_at = now_iso()
    return status


def update_intent(status: Status, alias: str, ready: bool, locked_at: datetime | None) -> Status:
    status.intents[alias] = IntentEntry(ready=ready, locked_at=locked_at)
    return status


def add_error(status: Status, component: str, code: str, detail: str) -> Status:
    from datetime import datetime as _dt

    status.errors.append(
        ErrorEntry(
            at=_dt.fromisoformat(now_iso()),
            component=component,
            code=code,
            detail=detail,
        )
    )
    return status


def merge_subtree(meeting_dir: Path, key: str, updates: dict[str, Any]) -> None:
    """Read-modify-write for a single top-level subtree (used by bot/CLI cooperation).

    Per INTERFACES.md §5.4 — bot writes only `bot.*`; observer never writes status
    directly. CLI can use this for any subtree.
    """
    status = load_status(meeting_dir)
    current = getattr(status, key, None)
    if current is None:
        raise KeyError(f"unknown status subtree {key!r}")
    if hasattr(current, "model_copy"):
        merged = current.model_copy(update=updates)
        setattr(status, key, merged)
    else:
        # dict-typed (intents)
        if isinstance(current, dict):
            current.update(updates)
            setattr(status, key, current)
        else:
            raise TypeError(f"cannot merge into subtree {key!r}")
    save_status(meeting_dir, status)


__all__ = [
    "State",
    "Status",
    "IntentEntry",
    "BotState",
    "ObserverState",
    "WrapState",
    "ReviewState",
    "ApplyState",
    "ErrorEntry",
    "LEGAL_TRANSITIONS",
    "load_status",
    "save_status",
    "transition",
    "update_intent",
    "add_error",
    "merge_subtree",
    "status_path",
]
