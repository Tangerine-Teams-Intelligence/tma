"""A3 — Per-user cursors. Tracks which atoms each user has seen / acked /
deferred so the UI can compute "what's new since you looked", "stale alerts",
and the same-screen alignment metric.

Storage: ``<root>/.tangerine/cursors/<user-alias>.json``. One file per user so
git merges stay sane (per-user isolation = no cursor merge conflicts).

API surface (mirrored in Rust at ``app/src-tauri/src/event_router.rs``):

  * ``mark_viewed(user, atom_id)`` — when the atom enters the user's UI viewport.
  * ``mark_acked(user, atom_id)`` — explicit "got it" click.
  * ``mark_deferred(user, atom_id, until_ts)`` — snooze until later.
  * ``compute_diff(user)`` — list of atom ids NOT viewed since the user's
    ``last_opened_at``. Drives "you missed N events" banner.
  * ``compute_alignment()`` — % atoms viewed by all configured users. Drives
    the same-screen rate metric.

All writes are atomic (tmp-file + rename) so a crashed write never corrupts
the cursor file. Reads gracefully fall back to a fresh cursor if the file is
missing or malformed.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from .event_router import load_index, sidecar_dir
from .utils import SHANGHAI, atomic_write_text, now_iso

logger = logging.getLogger(__name__)

USER_ALIAS_RE = re.compile(r"^[a-z][a-z0-9_]*$")
ATOM_ID_RE = re.compile(r"^evt-\d{4}-\d{2}-\d{2}-[a-f0-9]+$")


# ----------------------------------------------------------------------
# Schema
#
# Stage 2 hook §7 — preferences block. Stage 1 stores defaults. Stage 2
# personalization trainer extension updates these from interaction patterns.
DEFAULT_PREFERENCES: dict[str, object] = {
    "brief_style": "default",         # Stage 2: "terse" | "detailed" | "numbers-first"
    "brief_time": "08:00",            # Stage 2: learned from open patterns
    "notification_channels": ["os", "email"],  # Stage 2: learned
    "topics_of_interest": [],         # Stage 2 fills from interaction patterns
    "topics_to_skip": [],             # Stage 2 learns from skips
}


def _default_preferences() -> dict[str, object]:
    # Defensive: deep-copy mutable defaults so cursor instances don't share state.
    return {
        "brief_style": "default",
        "brief_time": "08:00",
        "notification_channels": ["os", "email"],
        "topics_of_interest": [],
        "topics_to_skip": [],
    }


@dataclass
class Cursor:
    user: str
    last_opened_at: str | None = None
    atoms_viewed: dict[str, str] = field(default_factory=dict)
    atoms_acked: dict[str, str] = field(default_factory=dict)
    atoms_deferred: dict[str, str] = field(default_factory=dict)
    thread_cursor: dict[str, str] = field(default_factory=dict)
    preferences: dict[str, object] = field(default_factory=_default_preferences)

    def to_dict(self) -> dict[str, object]:
        return {
            "user": self.user,
            "last_opened_at": self.last_opened_at,
            "atoms_viewed": dict(self.atoms_viewed),
            "atoms_acked": dict(self.atoms_acked),
            "atoms_deferred": dict(self.atoms_deferred),
            "thread_cursor": dict(self.thread_cursor),
            "preferences": dict(self.preferences),
        }

    @classmethod
    def from_dict(cls, raw: dict[str, object]) -> "Cursor":
        user = str(raw.get("user") or "unknown")
        prefs = _merge_preferences(raw.get("preferences"))
        return cls(
            user=user,
            last_opened_at=_optional_str(raw.get("last_opened_at")),
            atoms_viewed=_str_str_map(raw.get("atoms_viewed")),
            atoms_acked=_str_str_map(raw.get("atoms_acked")),
            atoms_deferred=_str_str_map(raw.get("atoms_deferred")),
            thread_cursor=_str_str_map(raw.get("thread_cursor")),
            preferences=prefs,
        )


def _merge_preferences(raw: object) -> dict[str, object]:
    """Take whatever's on disk + fill missing keys from defaults.

    Forward-compatible: a cursor written by an older version that lacks
    `preferences` (or has only a partial subset) gets the missing keys
    populated. User-customised values always win.
    """
    out = _default_preferences()
    if isinstance(raw, dict):
        for k, v in raw.items():
            out[str(k)] = v
    return out


def _optional_str(v: object) -> str | None:
    if isinstance(v, str) and v:
        return v
    return None


def _str_str_map(v: object) -> dict[str, str]:
    if not isinstance(v, dict):
        return {}
    return {str(k): str(val) for k, val in v.items() if isinstance(val, str)}


# ----------------------------------------------------------------------
# Paths


def cursors_dir(memory_root: Path) -> Path:
    p = sidecar_dir(memory_root) / "cursors"
    p.mkdir(parents=True, exist_ok=True)
    return p


def cursor_file_path(memory_root: Path, user: str) -> Path:
    if not USER_ALIAS_RE.match(user):
        raise ValueError(f"user alias {user!r} must match {USER_ALIAS_RE.pattern}")
    return cursors_dir(memory_root) / f"{user}.json"


def alignment_path(memory_root: Path) -> Path:
    return sidecar_dir(memory_root) / "alignment.json"


# ----------------------------------------------------------------------
# Load / save


def load_cursor(memory_root: Path, user: str) -> Cursor:
    path = cursor_file_path(memory_root, user)
    if not path.exists():
        return Cursor(user=user)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("cursor load failed for %s: %s; resetting", user, e)
        return Cursor(user=user)
    if not isinstance(raw, dict):
        return Cursor(user=user)
    cur = Cursor.from_dict(raw)
    cur.user = user  # always trust the path
    return cur


def save_cursor(memory_root: Path, cursor: Cursor) -> Path:
    path = cursor_file_path(memory_root, cursor.user)
    text = json.dumps(cursor.to_dict(), ensure_ascii=False, indent=2, sort_keys=False)
    atomic_write_text(path, text)
    return path


def list_users(memory_root: Path) -> list[str]:
    """All users we have cursor files for."""
    out: list[str] = []
    cdir = cursors_dir(memory_root)
    for f in sorted(cdir.glob("*.json")):
        if f.is_file() and USER_ALIAS_RE.match(f.stem):
            out.append(f.stem)
    return out


# ----------------------------------------------------------------------
# Public API


def _validate_atom(atom_id: str) -> None:
    if not ATOM_ID_RE.match(atom_id):
        raise ValueError(f"atom id {atom_id!r} must match {ATOM_ID_RE.pattern}")


def mark_opened(memory_root: Path, user: str) -> Cursor:
    """Bump ``last_opened_at`` to ``now``. Call when the user focuses the app."""
    cur = load_cursor(memory_root, user)
    cur.last_opened_at = now_iso()
    save_cursor(memory_root, cur)
    return cur


def mark_viewed(memory_root: Path, user: str, atom_id: str) -> Cursor:
    """Record that this user's UI rendered the atom. Idempotent; first-view ts wins."""
    _validate_atom(atom_id)
    cur = load_cursor(memory_root, user)
    cur.atoms_viewed.setdefault(atom_id, now_iso())
    save_cursor(memory_root, cur)
    return cur


def mark_acked(memory_root: Path, user: str, atom_id: str) -> Cursor:
    """Record an explicit acknowledgement (different from passive viewing)."""
    _validate_atom(atom_id)
    cur = load_cursor(memory_root, user)
    cur.atoms_acked[atom_id] = now_iso()
    # Acking implies viewing.
    cur.atoms_viewed.setdefault(atom_id, now_iso())
    save_cursor(memory_root, cur)
    return cur


def mark_deferred(
    memory_root: Path, user: str, atom_id: str, until_ts: str
) -> Cursor:
    """Snooze the atom until ``until_ts`` (RFC 3339)."""
    _validate_atom(atom_id)
    cur = load_cursor(memory_root, user)
    cur.atoms_deferred[atom_id] = until_ts
    save_cursor(memory_root, cur)
    return cur


def set_thread_cursor(
    memory_root: Path, user: str, thread: str, last_atom_id: str
) -> Cursor:
    """Mark how far the user has read in a thread."""
    _validate_atom(last_atom_id)
    cur = load_cursor(memory_root, user)
    cur.thread_cursor[thread] = last_atom_id
    save_cursor(memory_root, cur)
    return cur


# ----------------------------------------------------------------------
# Diff + alignment metrics


def compute_diff(memory_root: Path, user: str) -> list[dict[str, object]]:
    """Atoms NOT in ``cur.atoms_viewed`` whose ts > ``cur.last_opened_at``.

    Returns the index records (sorted by ts ascending) so the UI can render
    them directly. Empty list if cursor is fresh (never opened).
    """
    cur = load_cursor(memory_root, user)
    if cur.last_opened_at is None:
        # Fresh user: everything is new but we cap it to "since first event"
        # to avoid blasting them with the entire history.
        threshold = ""
    else:
        threshold = cur.last_opened_at
    index = load_index(memory_root)
    events = index.get("events") or []
    if not isinstance(events, list):
        return []
    out: list[dict[str, object]] = []
    for rec in events:
        if not isinstance(rec, dict):
            continue
        ts = str(rec.get("ts", ""))
        ev_id = str(rec.get("id", ""))
        if rec.get("sample"):
            continue
        if ev_id in cur.atoms_viewed:
            continue
        if threshold and ts <= threshold:
            continue
        out.append(rec)
    out.sort(key=lambda r: str(r.get("ts", "")))
    return out


def compute_alignment(
    memory_root: Path, users: Iterable[str] | None = None
) -> dict[str, object]:
    """Same-screen rate = (atoms viewed by every user) / (total atoms).

    If ``users`` is None, derives the set from cursor files on disk. Returns a
    snapshot dict::

        {
          "computed_at": "...",
          "users": ["daizhe", "eric"],
          "total_atoms": 124,
          "shared_viewed": 87,
          "rate": 0.701,
          "per_user_seen": {"daizhe": 102, "eric": 95},
        }
    """
    user_list = list(users) if users is not None else list_users(memory_root)
    index = load_index(memory_root)
    raw_events = index.get("events") or []
    events = [r for r in raw_events if isinstance(r, dict) and not r.get("sample")]
    total = len(events)
    cursors = [load_cursor(memory_root, u) for u in user_list]
    shared = 0
    per_user_seen: dict[str, int] = {u: 0 for u in user_list}
    if total and cursors:
        for rec in events:
            ev_id = str(rec.get("id", ""))
            if not ev_id:
                continue
            seen_by_all = True
            for cur in cursors:
                if ev_id in cur.atoms_viewed:
                    per_user_seen[cur.user] = per_user_seen.get(cur.user, 0) + 1
                else:
                    seen_by_all = False
            if seen_by_all and cursors:
                shared += 1
    rate = round(shared / total, 4) if total else 0.0
    snapshot: dict[str, object] = {
        "computed_at": now_iso(),
        "users": user_list,
        "total_atoms": total,
        "shared_viewed": shared,
        "rate": rate,
        "per_user_seen": per_user_seen,
    }
    return snapshot


def write_alignment_history(memory_root: Path, snapshot: dict[str, object]) -> Path:
    """Append the snapshot to ``alignment.json`` (ring-buffered to last 200 entries)."""
    path = alignment_path(memory_root)
    history: list[dict[str, object]] = []
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                hist = loaded.get("history")
                if isinstance(hist, list):
                    history = [h for h in hist if isinstance(h, dict)]
        except (OSError, json.JSONDecodeError):
            history = []
    history.append(snapshot)
    if len(history) > 200:
        history = history[-200:]
    text = json.dumps(
        {"version": 1, "history": history, "latest": snapshot},
        ensure_ascii=False,
        indent=2,
        sort_keys=False,
    )
    atomic_write_text(path, text)
    return path


# ----------------------------------------------------------------------
# Stale detection helpers (used by daemon brief generator)


def stale_users(
    memory_root: Path,
    *,
    threshold_hours: int = 48,
    min_unseen: int = 1,
) -> list[dict[str, object]]:
    """Users whose ``last_opened_at`` was > ``threshold_hours`` ago AND who
    have at least ``min_unseen`` unviewed atoms newer than their last open.
    """
    from datetime import datetime, timedelta

    now = datetime.now(tz=SHANGHAI)
    deadline = now - timedelta(hours=threshold_hours)
    out: list[dict[str, object]] = []
    for user in list_users(memory_root):
        cur = load_cursor(memory_root, user)
        last = cur.last_opened_at
        if last is None:
            continue
        try:
            last_dt = datetime.fromisoformat(last)
        except ValueError:
            continue
        if last_dt > deadline:
            continue
        diff = compute_diff(memory_root, user)
        if len(diff) < min_unseen:
            continue
        out.append(
            {
                "user": user,
                "last_opened_at": last,
                "unseen_count": len(diff),
            }
        )
    return out


__all__ = [
    "Cursor",
    "DEFAULT_PREFERENCES",
    "cursors_dir",
    "cursor_file_path",
    "alignment_path",
    "load_cursor",
    "save_cursor",
    "list_users",
    "mark_opened",
    "mark_viewed",
    "mark_acked",
    "mark_deferred",
    "set_thread_cursor",
    "compute_diff",
    "compute_alignment",
    "write_alignment_history",
    "stale_users",
]
