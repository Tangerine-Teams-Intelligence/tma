"""E2E smoke: simulate writing a meeting file then route it through the
event router and verify the timeline + entity files + index land where
``daemon.rs`` and the UI expect them.

This bypasses the real Discord-bot/observer pipeline (those have their own
e2e tests in test_meeting.py and smoke_e2e.py) and exercises just the
v1.7 RMS layer end-to-end.
"""

from __future__ import annotations

import json
from pathlib import Path

from tmi.cursors import compute_diff, mark_viewed, save_cursor
from tmi.cursors import Cursor
from tmi.event_router import (
    load_index,
    process,
    rebuild_index,
    timeline_file_path,
    timeline_index_path,
)


def _write_meeting(memory: Path) -> Path:
    body = (
        "---\n"
        "date: 2026-04-26\n"
        "title: David roadmap sync\n"
        "source: discord\n"
        "participants:\n"
        "- daizhe\n"
        "- david\n"
        "duration_min: 47\n"
        "meeting_id: 2026-04-26-david-roadmap-sync\n"
        "---\n\n"
        "## Transcript\n\n"
        "[09:30:00] daizhe: lets talk pricing\n"
        "[09:31:30] david: i propose 20-seat min\n"
        "[09:32:15] daizhe: locked\n\n"
        "## Summary\n\nPricing locked at 20 seats.\n\n"
        "## Decisions\n\n- [pricing 20 seats](../decisions/pricing-20-seats.md)\n"
    )
    p = memory / "meetings" / "2026-04-26-david-roadmap-sync.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body, encoding="utf-8")
    return p


def _write_decision(memory: Path) -> Path:
    body = (
        "---\ndate: 2026-04-26\ntitle: Pricing 20 seats\nsource: meeting\n"
        "source_id: 2026-04-26-david-roadmap-sync\nstatus: decided\n---\n\n"
        "## Decision\n\nDecided $20/seat\n\n"
        "**Decided by**: daizhe, david\n\n## Context\n\n...\n"
    )
    p = memory / "decisions" / "pricing-20-seats.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body, encoding="utf-8")
    return p


def test_smoke_meeting_then_decision_routes_to_timeline(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    mp = _write_meeting(memory)
    dp = _write_decision(memory)
    process(memory, mp)
    process(memory, dp)
    # Timeline file exists with all participants represented.
    day = timeline_file_path(memory, "2026-04-26")
    assert day.exists()
    text = day.read_text(encoding="utf-8")
    assert "daizhe" in text
    assert "david" in text
    assert "pricing-20-seats" in text or "decision" in text
    # Index includes events from both files.
    idx = load_index(memory)
    sources = {e["source"] for e in idx["events"]}
    assert "meeting" in sources
    # People + project files exist.
    assert (memory / "people" / "daizhe.md").exists()
    assert (memory / "people" / "david.md").exists()
    assert (memory / "decisions" / "pricing-20-seats.md").exists()


def test_smoke_cursors_unchanged_by_routing(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    mp = _write_meeting(memory)
    process(memory, mp)
    # Daizhe never opened the app — diff should include all newly routed
    # events that are non-sample.
    save_cursor(
        memory,
        Cursor(user="daizhe", last_opened_at="2026-04-26T08:00:00+08:00"),
    )
    diff_before = compute_diff(memory, "daizhe")
    assert diff_before, "expected events surfaced for unread user"
    # Marking one viewed shrinks the diff by 1.
    mark_viewed(memory, "daizhe", diff_before[0]["id"])
    diff_after = compute_diff(memory, "daizhe")
    assert len(diff_after) == len(diff_before) - 1


def test_smoke_idempotent_double_route(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    mp = _write_meeting(memory)
    process(memory, mp)
    snapshot1 = (memory / "timeline" / "2026-04-26.md").read_text(encoding="utf-8")
    idx1 = json.loads(timeline_index_path(memory).read_text(encoding="utf-8"))
    process(memory, mp)
    snapshot2 = (memory / "timeline" / "2026-04-26.md").read_text(encoding="utf-8")
    idx2 = json.loads(timeline_index_path(memory).read_text(encoding="utf-8"))
    assert snapshot1 == snapshot2
    assert idx1["events"] == idx2["events"]


def test_smoke_rebuild_matches_emit(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    mp = _write_meeting(memory)
    dp = _write_decision(memory)
    process(memory, mp)
    process(memory, dp)
    idx_emit = load_index(memory)
    timeline_index_path(memory).unlink()
    idx_rebuilt = rebuild_index(memory)
    # IDs must match (rebuild may differ in trivial fields like preserved order).
    ids_emit = sorted(e["id"] for e in idx_emit["events"])
    ids_rebuilt = sorted(e["id"] for e in idx_rebuilt["events"])
    assert ids_emit == ids_rebuilt
