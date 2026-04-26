"""Tests for tmi.briefs."""

from __future__ import annotations

import json
from pathlib import Path

from tmi.briefs import (
    daily_brief_path,
    generate_today,
    pending_alerts_path,
    refresh_pending,
    write_status_snapshot,
)
from tmi.cursors import Cursor, save_cursor
from tmi.event_router import (
    Event,
    EventLifecycle,
    EventRefs,
    emit,
    make_event_id,
    sidecar_dir,
)


def _ev(idx: int, ts: str, **kwargs: object) -> Event:
    base = {
        "id": make_event_id("synth", "comment", f"i{idx}", ts),
        "ts": ts,
        "source": "system",
        "actor": "daizhe",
        "actors": ["daizhe"],
        "kind": "comment",
        "refs": EventRefs(),
        "body": f"event {idx}",
    }
    base.update(kwargs)  # type: ignore[arg-type]
    return Event(**base)  # type: ignore[arg-type]


def test_generate_today_writes_brief(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    e1 = _ev(1, ts="2026-04-25T09:00:00+08:00")
    e2 = _ev(2, ts="2026-04-25T10:00:00+08:00", kind="decision", actor="eric")
    emit(memory, [e1, e2])
    p = generate_today(memory, date_iso="2026-04-26")
    assert p == daily_brief_path(memory, "2026-04-26")
    text = p.read_text(encoding="utf-8")
    assert "2026-04-26" in text
    assert "comment" in text
    assert "decision" in text


def test_generate_today_handles_zero_events(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    p = generate_today(memory, date_iso="2026-04-26")
    text = p.read_text(encoding="utf-8")
    assert "No events recorded" in text


def test_refresh_pending_emits_review_soon(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    e = _ev(
        1,
        ts="2026-04-26T09:00:00+08:00",
        kind="decision",
        lifecycle=EventLifecycle(decided="2026-04-26", review_by="2026-04-26"),
    )
    emit(memory, [e])
    p = refresh_pending(memory)
    assert p == pending_alerts_path(memory)
    text = p.read_text(encoding="utf-8")
    assert "Decisions up for review" in text
    assert e.id in text


def test_refresh_pending_emits_overdue(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    e = _ev(
        1,
        ts="2026-04-26T09:00:00+08:00",
        kind="ticket_event",
        lifecycle=EventLifecycle(due="2020-01-01"),
    )
    emit(memory, [e])
    p = refresh_pending(memory)
    text = p.read_text(encoding="utf-8")
    assert "Overdue items" in text


def test_refresh_pending_emits_stale_threads(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    e = _ev(
        1,
        ts="2020-01-01T09:00:00+08:00",
        body="open question: should we ship?",
        refs=EventRefs(threads=["pricing-debate"]),
    )
    emit(memory, [e])
    p = refresh_pending(memory)
    text = p.read_text(encoding="utf-8")
    assert "Stale threads" in text
    assert "pricing-debate" in text


def test_refresh_pending_emits_stale_users(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    e = _ev(1, ts="2026-04-26T09:00:00+08:00")
    emit(memory, [e])
    save_cursor(
        memory,
        Cursor(user="eric", last_opened_at="2020-01-01T00:00:00+08:00"),
    )
    p = refresh_pending(memory)
    text = p.read_text(encoding="utf-8")
    assert "Members behind" in text
    assert "eric" in text


def test_refresh_pending_when_clean(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    p = refresh_pending(memory)
    assert "No pending alerts" in p.read_text(encoding="utf-8")


def test_status_snapshot_writes_json(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    p = write_status_snapshot(
        memory,
        last_heartbeat="2026-04-26T09:00:00+08:00",
        last_pull="2026-04-26T08:55:00+08:00",
        last_brief="2026-04-26T08:00:00+08:00",
        errors=[],
    )
    assert p == sidecar_dir(memory) / "daemon-status.json"
    raw = json.loads(p.read_text(encoding="utf-8"))
    assert raw["last_heartbeat"] == "2026-04-26T09:00:00+08:00"
    assert raw["errors"] == []


def test_status_snapshot_caps_errors(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    errs = [f"e{i}" for i in range(50)]
    p = write_status_snapshot(
        memory,
        last_heartbeat="2026-04-26T09:00:00+08:00",
        last_pull=None,
        last_brief=None,
        errors=errs,
    )
    raw = json.loads(p.read_text(encoding="utf-8"))
    assert len(raw["errors"]) == 20
    assert raw["errors"] == errs[-20:]
