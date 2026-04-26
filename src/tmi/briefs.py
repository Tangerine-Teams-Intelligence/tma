"""Brief + pending-alerts generator. Used by the daemon (A2) once per heartbeat
to materialise ``.tangerine/briefs/<YYYY-MM-DD>.md`` and
``.tangerine/briefs/pending.md`` so the UI / OS notification can read them
without re-walking the timeline.

This module is intentionally pure-Python and has zero IO side effects beyond
writing the two files. The daemon tests exercise it directly with synthetic
indexes; the daemon binary just calls ``generate_today`` + ``refresh_pending``.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

from .cursors import compute_diff, list_users, stale_users
from .event_router import load_index, sidecar_dir
from .utils import SHANGHAI, atomic_write_text, now_iso


def briefs_dir(memory_root: Path) -> Path:
    p = sidecar_dir(memory_root) / "briefs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def daily_brief_path(memory_root: Path, date_iso: str) -> Path:
    return briefs_dir(memory_root) / f"{date_iso}.md"


def pending_alerts_path(memory_root: Path) -> Path:
    return briefs_dir(memory_root) / "pending.md"


# ----------------------------------------------------------------------
# Daily brief


def generate_today(memory_root: Path, date_iso: str | None = None) -> Path:
    """Compose a per-team daily brief from yesterday's events.

    Daemon calls this on the first heartbeat after 8 AM local. Format is
    Markdown so it lands cleanly in the UI and in the OS notification.
    """
    today = datetime.now(tz=SHANGHAI).date()
    target = date_iso or today.isoformat()
    target_dt = datetime.fromisoformat(target)
    yesterday = (target_dt - timedelta(days=1)).date().isoformat()

    index = load_index(memory_root)
    raw_events = index.get("events") or []
    yesterday_events = [
        r
        for r in raw_events
        if isinstance(r, dict) and str(r.get("ts", ""))[:10] == yesterday and not r.get("sample")
    ]

    sections: list[str] = [
        f"---\nbrief_date: {target}\nperiod: {yesterday}\n---\n",
        f"# Daily Brief — {target}",
        "",
        f"_Covers events from {yesterday}._",
        "",
    ]

    if not yesterday_events:
        sections.append("No events recorded.")
        sections.append("")
    else:
        # Group by kind for skim-friendliness.
        by_kind: dict[str, list[dict[str, object]]] = {}
        for rec in yesterday_events:
            kind = str(rec.get("kind", "comment"))
            by_kind.setdefault(kind, []).append(rec)
        for kind in sorted(by_kind):
            sections.append(f"## {kind} ({len(by_kind[kind])})")
            sections.append("")
            for rec in by_kind[kind][:20]:
                ts = str(rec.get("ts", ""))[11:16]
                actor = rec.get("actor", "unknown")
                ev_id = rec.get("id", "")
                sections.append(f"- {ts} · **{actor}** · `{ev_id}`")
            if len(by_kind[kind]) > 20:
                sections.append(f"- _... {len(by_kind[kind]) - 20} more_")
            sections.append("")

    # Per-user "what you missed".
    users = list_users(memory_root)
    if users:
        sections.append("## What each member missed")
        sections.append("")
        for user in users:
            diff = compute_diff(memory_root, user)
            sections.append(f"- **{user}**: {len(diff)} unseen atom(s)")
        sections.append("")

    out = "\n".join(sections).rstrip() + "\n"
    path = daily_brief_path(memory_root, target)
    atomic_write_text(path, out)
    return path


# ----------------------------------------------------------------------
# Pending-alerts queue


def refresh_pending(
    memory_root: Path,
    *,
    review_window_days: int = 3,
    stale_thread_days: int = 14,
    stale_user_hours: int = 48,
) -> Path:
    """Recompute the alerts queue. Sources of alerts:

    * Decisions whose ``lifecycle.review_by`` is within ``review_window_days``.
    * Action items (events with ``lifecycle.due``) past due and not closed.
    * Threads whose newest event is > ``stale_thread_days`` ago AND mention
      "open question" in the body.
    * Users whose last open was > ``stale_user_hours`` ago and have unseen atoms.
    """
    today = datetime.now(tz=SHANGHAI).date()
    deadline = today + timedelta(days=review_window_days)

    index = load_index(memory_root)
    raw_events = index.get("events") or []
    events = [r for r in raw_events if isinstance(r, dict)]

    review_soon: list[dict[str, object]] = []
    overdue: list[dict[str, object]] = []
    for rec in events:
        if rec.get("status") == "closed":
            continue
        lc = rec.get("lifecycle") if isinstance(rec.get("lifecycle"), dict) else {}
        review_by = lc.get("review_by") if isinstance(lc, dict) else None
        if isinstance(review_by, str):
            try:
                rb_date = datetime.fromisoformat(review_by[:10]).date()
                if rb_date <= deadline:
                    review_soon.append(rec)
            except ValueError:
                pass
        due = lc.get("due") if isinstance(lc, dict) else None
        if isinstance(due, str):
            try:
                due_date = datetime.fromisoformat(due[:10]).date()
                if due_date < today:
                    overdue.append(rec)
            except ValueError:
                pass

    # Stale threads — bucket events by thread, look at newest per bucket.
    thread_latest: dict[str, dict[str, object]] = {}
    for rec in events:
        refs = rec.get("refs")
        if not isinstance(refs, dict):
            continue
        threads = refs.get("threads")
        if not isinstance(threads, list):
            continue
        for t in threads:
            cur = thread_latest.get(str(t))
            if cur is None or str(rec.get("ts", "")) > str(cur.get("ts", "")):
                thread_latest[str(t)] = rec
    stale_threads: list[dict[str, object]] = []
    threshold = today - timedelta(days=stale_thread_days)
    for thread, rec in thread_latest.items():
        ts = str(rec.get("ts", ""))[:10]
        try:
            ts_date = datetime.fromisoformat(ts).date()
        except ValueError:
            continue
        if ts_date >= threshold:
            continue
        body = str(rec.get("body", "")).lower()
        if "open question" in body or "?" in body:
            stale_threads.append({"thread": thread, "last_event": rec})

    stale_users_list = stale_users(
        memory_root,
        threshold_hours=stale_user_hours,
        min_unseen=1,
    )

    parts: list[str] = [
        f"---\nrefreshed_at: {now_iso()}\n---\n",
        "# Pending Alerts",
        "",
    ]
    if review_soon:
        parts.append(f"## Decisions up for review ({len(review_soon)})")
        parts.append("")
        for rec in review_soon[:25]:
            parts.append(_format_alert_line(rec, "review_by"))
        parts.append("")
    if overdue:
        parts.append(f"## Overdue items ({len(overdue)})")
        parts.append("")
        for rec in overdue[:25]:
            parts.append(_format_alert_line(rec, "due"))
        parts.append("")
    if stale_threads:
        parts.append(f"## Stale threads ({len(stale_threads)})")
        parts.append("")
        for entry in stale_threads[:25]:
            rec = entry["last_event"]
            assert isinstance(rec, dict)
            parts.append(
                f"- **{entry['thread']}** · last event `{rec.get('id')}` "
                f"({rec.get('ts')})"
            )
        parts.append("")
    if stale_users_list:
        parts.append(f"## Members behind ({len(stale_users_list)})")
        parts.append("")
        for u in stale_users_list:
            parts.append(
                f"- **{u['user']}** — last opened {u['last_opened_at']}, "
                f"{u['unseen_count']} unseen atom(s)"
            )
        parts.append("")
    if (
        not review_soon
        and not overdue
        and not stale_threads
        and not stale_users_list
    ):
        parts.append("_No pending alerts._")
        parts.append("")

    out = "\n".join(parts).rstrip() + "\n"
    path = pending_alerts_path(memory_root)
    atomic_write_text(path, out)
    return path


def _format_alert_line(rec: dict[str, object], field_name: str) -> str:
    lc = rec.get("lifecycle")
    deadline = ""
    if isinstance(lc, dict):
        v = lc.get(field_name)
        if isinstance(v, str):
            deadline = v
    return (
        f"- `{rec.get('id')}` · {rec.get('kind')} · {field_name}={deadline} · "
        f"actor={rec.get('actor')}"
    )


# ----------------------------------------------------------------------
# Convenience: daemon entry-point


def write_status_snapshot(
    memory_root: Path,
    *,
    last_heartbeat: str,
    last_pull: str | None,
    last_brief: str | None,
    errors: list[str],
) -> Path:
    """Surface daemon liveness for the UI. Mirrors the `daemon_status` Tauri
    command shape so the React side can render either side without conversion.
    """
    snapshot = {
        "last_heartbeat": last_heartbeat,
        "last_pull": last_pull,
        "last_brief": last_brief,
        "errors": errors[-20:],
    }
    path = sidecar_dir(memory_root) / "daemon-status.json"
    atomic_write_text(path, json.dumps(snapshot, ensure_ascii=False, indent=2))
    return path


__all__ = [
    "briefs_dir",
    "daily_brief_path",
    "pending_alerts_path",
    "generate_today",
    "refresh_pending",
    "write_status_snapshot",
]
