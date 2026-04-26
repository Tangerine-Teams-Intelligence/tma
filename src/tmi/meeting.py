"""Meeting directory CRUD + meeting.yaml schema.

Spec: INTERFACES.md §2.0, §2.1, §4.2.
"""

from __future__ import annotations

import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Iterable

import yaml
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

from .config import ALIAS_RE, Config
from .state import Status, save_status
from .utils import atomic_write_text, now_dt, now_iso, slugify

ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$")


class Participant(BaseModel):
    alias: str
    display_name: str
    discord_id: str | None = None

    @field_validator("alias")
    @classmethod
    def _alias_fmt(cls, v: str) -> str:
        if not ALIAS_RE.match(v):
            raise ValueError(f"alias {v!r} must match {ALIAS_RE.pattern}")
        return v


class Meeting(BaseModel):
    schema_version: int = 1
    id: str
    title: str
    created_at: datetime
    scheduled_at: datetime | None = None
    participants: list[Participant]
    target_adapter: str
    tags: list[str] = Field(default_factory=list)

    @field_validator("id")
    @classmethod
    def _id_fmt(cls, v: str) -> str:
        if not ID_RE.match(v):
            raise ValueError(f"id {v!r} must match {ID_RE.pattern}")
        return v

    @model_validator(mode="after")
    def _participants_unique(self) -> "Meeting":
        if not self.participants:
            raise ValueError("at least one participant required")
        aliases = [p.alias for p in self.participants]
        if len(set(aliases)) != len(aliases):
            raise ValueError("participant aliases must be unique")
        return self


# ----------------------------------------------------------------------
# Paths

def meetings_root(cfg: Config) -> Path:
    root = cfg.meetings_repo_path() / "meetings"
    root.mkdir(parents=True, exist_ok=True)
    return root


def meeting_dir(cfg: Config, meeting_id: str) -> Path:
    return meetings_root(cfg) / meeting_id


def meeting_yaml_path(meeting_dir_: Path) -> Path:
    return meeting_dir_ / "meeting.yaml"


# ----------------------------------------------------------------------
# CRUD

def make_id(title: str, today: datetime | None = None) -> str:
    d = (today or now_dt()).date().isoformat()
    return f"{d}-{slugify(title)}"


def load_meeting(meeting_dir_: Path) -> Meeting:
    p = meeting_yaml_path(meeting_dir_)
    if not p.exists():
        print(f"error: meeting.yaml not found at {p}", file=sys.stderr)
        sys.exit(1)
    with open(p, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    try:
        m = Meeting.model_validate(raw)
    except ValidationError as e:
        print(f"error: meeting.yaml invalid: {e}", file=sys.stderr)
        sys.exit(1)
    if m.id != meeting_dir_.name:
        print(
            f"error: meeting.yaml id={m.id!r} does not match dir {meeting_dir_.name!r}",
            file=sys.stderr,
        )
        sys.exit(1)
    return m


def save_meeting(meeting_dir_: Path, m: Meeting) -> None:
    payload = m.model_dump(mode="json")
    text = yaml.safe_dump(payload, sort_keys=False, default_flow_style=False, allow_unicode=True)
    atomic_write_text(meeting_yaml_path(meeting_dir_), text)


def create_meeting(
    cfg: Config,
    title: str,
    *,
    participants: Iterable[str] | None = None,
    scheduled_at: datetime | None = None,
    target: str | None = None,
    suffix: str | None = None,
) -> Path:
    """Create meeting directory + meeting.yaml + status.yaml.

    Returns absolute path to meeting dir. Exits 1 on id collision.
    """
    today = now_dt()
    base_id = make_id(title, today)
    mid = base_id if suffix is None else f"{base_id}-{slugify(suffix)}"
    mdir = meeting_dir(cfg, mid)
    if mdir.exists():
        print(
            f"error: meeting {mid} already exists; pass --suffix <slug> to disambiguate",
            file=sys.stderr,
        )
        sys.exit(1)

    # Resolve participants from config team if not given
    if participants is None:
        team = cfg.team
        if not team:
            print("error: no team[] in config and no --participants given", file=sys.stderr)
            sys.exit(1)
        plist = [
            Participant(alias=t.alias, display_name=t.display_name, discord_id=t.discord_id)
            for t in team
        ]
    else:
        team_lookup = {t.alias: t for t in cfg.team}
        plist = []
        for a in participants:
            a = a.strip()
            if not a:
                continue
            tm = team_lookup.get(a)
            if tm is None:
                # Allow ad-hoc participants who aren't in team yet
                plist.append(Participant(alias=a, display_name=a))
            else:
                plist.append(
                    Participant(alias=tm.alias, display_name=tm.display_name, discord_id=tm.discord_id)
                )

    # Resolve target adapter
    if target is None:
        if len(cfg.output_adapters) == 1:
            target = cfg.output_adapters[0].name
        else:
            print(
                "error: multiple adapters configured; pass --target <name>",
                file=sys.stderr,
            )
            sys.exit(1)

    # Validate adapter exists at create time too (helpful early error)
    try:
        cfg.adapter_by_name(target)
    except KeyError:
        print(f"error: target adapter {target!r} not in config.output_adapters", file=sys.stderr)
        sys.exit(1)

    m = Meeting(
        id=mid,
        title=title,
        created_at=today,
        scheduled_at=scheduled_at,
        participants=plist,
        target_adapter=target,
    )

    mdir.mkdir(parents=True)
    (mdir / "intents").mkdir()
    (mdir / ".tmi").mkdir()
    save_meeting(mdir, m)

    # Empty append-only files
    atomic_write_text(mdir / "transcript.md", "")
    atomic_write_text(mdir / "observations.md", "")

    # Initial status
    status = Status(state="created", state_updated_at=now_iso())
    for p in plist:
        from .state import IntentEntry

        status.intents[p.alias] = IntentEntry(ready=False, locked_at=None)
    save_status(mdir, status)

    return mdir


def list_meetings(cfg: Config) -> list[tuple[str, str, str]]:
    """Returns [(id, state, title), ...] sorted by id descending (newest first)."""
    from .state import load_status

    out: list[tuple[str, str, str]] = []
    root = meetings_root(cfg)
    for child in sorted(root.iterdir(), reverse=True):
        if not child.is_dir():
            continue
        if not ID_RE.match(child.name):
            continue
        try:
            m = load_meeting(child)
        except SystemExit:
            continue
        st = load_status(child)
        out.append((m.id, st.state, m.title))
    return out


def infer_meeting_id(cfg: Config) -> str:
    """If exactly one meeting is in a non-terminal state, return its id. Else exit 1."""
    from .state import load_status

    candidates: list[str] = []
    root = meetings_root(cfg)
    for child in sorted(root.iterdir()):
        if not child.is_dir() or not ID_RE.match(child.name):
            continue
        try:
            st = load_status(child)
        except SystemExit:
            continue
        if st.state not in {"merged", "failed_apply"}:
            candidates.append(child.name)
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        print("error: no active meetings; pass <meeting-id>", file=sys.stderr)
        sys.exit(1)
    print(
        "error: multiple active meetings; pass <meeting-id>:\n  "
        + "\n  ".join(candidates),
        file=sys.stderr,
    )
    sys.exit(1)


__all__ = [
    "Meeting",
    "Participant",
    "ID_RE",
    "create_meeting",
    "load_meeting",
    "save_meeting",
    "make_id",
    "meeting_dir",
    "meetings_root",
    "list_meetings",
    "infer_meeting_id",
]
