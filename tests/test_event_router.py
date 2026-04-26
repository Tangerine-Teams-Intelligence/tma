"""Tests for tmi.event_router (A1)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from tmi.event_router import (
    Event,
    EventLifecycle,
    EventRefs,
    emit,
    load_index,
    make_event_id,
    process,
    rebuild_index,
    sidecar_dir,
    timeline_dir,
    timeline_file_path,
    timeline_index_path,
)


def _write(p: Path, body: str) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body, encoding="utf-8")
    return p


def _make_event(**overrides: object) -> Event:
    base = {
        "id": "evt-2026-04-26-abcd012345",
        "ts": "2026-04-26T09:30:00+08:00",
        "source": "github",
        "actor": "eric",
        "actors": ["eric", "daizhe"],
        "kind": "pr_event",
        "refs": EventRefs(people=["eric", "daizhe"], projects=["v1-launch"]),
        "body": "merged PR #47",
    }
    base.update(overrides)  # type: ignore[arg-type]
    return Event(**base)  # type: ignore[arg-type]


# ----------------------------------------------------------------------
# id


def test_make_event_id_is_stable_for_same_inputs() -> None:
    a = make_event_id("github", "pr_event", "PR-47", "2026-04-26T09:30:00+08:00")
    b = make_event_id("github", "pr_event", "PR-47", "2026-04-26T09:30:00+08:00")
    assert a == b


def test_make_event_id_changes_on_any_input_change() -> None:
    base = make_event_id("github", "pr_event", "PR-47", "2026-04-26T09:30:00+08:00")
    assert make_event_id("linear", "pr_event", "PR-47", "2026-04-26T09:30:00+08:00") != base
    assert make_event_id("github", "comment", "PR-47", "2026-04-26T09:30:00+08:00") != base
    assert make_event_id("github", "pr_event", "PR-48", "2026-04-26T09:30:00+08:00") != base
    assert make_event_id("github", "pr_event", "PR-47", "2026-04-26T09:31:00+08:00") != base


def test_make_event_id_format() -> None:
    eid = make_event_id("github", "pr_event", "x", "2026-04-26T09:30:00+08:00")
    assert eid.startswith("evt-2026-04-26-")
    assert len(eid) == len("evt-2026-04-26-") + 10


# ----------------------------------------------------------------------
# emit / timeline


def test_emit_creates_day_file_with_sentinel(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    ev = _make_event()
    res = emit(memory, [ev])
    assert ev in res.events
    day_file = timeline_file_path(memory, "2026-04-26")
    assert day_file.exists()
    text = day_file.read_text(encoding="utf-8")
    assert f"<!-- evt:{ev.id} -->" in text
    assert f"<!-- /evt:{ev.id} -->" in text
    assert "## 09:30" in text


def test_emit_is_idempotent_byte_for_byte(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    ev = _make_event()
    emit(memory, [ev])
    day_file = timeline_file_path(memory, "2026-04-26")
    first = day_file.read_text(encoding="utf-8")
    res2 = emit(memory, [ev])
    second = day_file.read_text(encoding="utf-8")
    assert first == second
    assert res2.skipped == 1


def test_emit_writes_index_with_record(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    ev = _make_event()
    emit(memory, [ev])
    idx = load_index(memory)
    assert isinstance(idx["events"], list)
    assert any(e["id"] == ev.id for e in idx["events"])
    rec = next(e for e in idx["events"] if e["id"] == ev.id)
    assert rec["source"] == "github"
    assert rec["actor"] == "eric"
    assert rec["refs"]["projects"] == ["v1-launch"]


def test_emit_fans_out_to_entity_files(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    ev = _make_event()
    res = emit(memory, [ev])
    eric_path = memory / "people" / "eric.md"
    daizhe_path = memory / "people" / "daizhe.md"
    project_path = memory / "projects" / "v1-launch.md"
    assert eric_path.exists()
    assert daizhe_path.exists()
    assert project_path.exists()
    assert {eric_path, daizhe_path, project_path}.issubset(set(res.entity_writes))
    text = eric_path.read_text(encoding="utf-8")
    assert "## Timeline mentions" in text
    assert ev.id in text


def test_emit_entity_fanout_idempotent(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    ev = _make_event()
    emit(memory, [ev])
    eric_path = memory / "people" / "eric.md"
    text1 = eric_path.read_text(encoding="utf-8")
    emit(memory, [ev])
    text2 = eric_path.read_text(encoding="utf-8")
    assert text1 == text2


def test_emit_handles_multiple_events_same_day(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    ev1 = _make_event(id=make_event_id("a", "x", "y", "2026-04-26T09:30:00+08:00"))
    ev2 = _make_event(
        id=make_event_id("a", "x", "z", "2026-04-26T11:30:00+08:00"),
        ts="2026-04-26T11:30:00+08:00",
        body="another event",
    )
    emit(memory, [ev1, ev2])
    day_file = timeline_file_path(memory, "2026-04-26")
    text = day_file.read_text(encoding="utf-8")
    assert ev1.id in text and ev2.id in text
    idx = load_index(memory)
    ids = [e["id"] for e in idx["events"]]
    assert ev1.id in ids and ev2.id in ids


def test_emit_index_is_sorted_by_ts_ascending(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    later = _make_event(
        id=make_event_id("a", "x", "later", "2026-04-26T20:00:00+08:00"),
        ts="2026-04-26T20:00:00+08:00",
    )
    earlier = _make_event(
        id=make_event_id("a", "x", "early", "2026-04-26T07:00:00+08:00"),
        ts="2026-04-26T07:00:00+08:00",
    )
    emit(memory, [later])
    emit(memory, [earlier])
    idx = load_index(memory)
    timestamps = [e["ts"] for e in idx["events"]]
    assert timestamps == sorted(timestamps)


def test_lifecycle_serializes_into_index(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    ev = _make_event(
        kind="decision",
        lifecycle=EventLifecycle(decided="2026-04-26", review_by="2026-06-07"),
    )
    emit(memory, [ev])
    idx = load_index(memory)
    rec = next(e for e in idx["events"] if e["id"] == ev.id)
    assert rec["lifecycle"]["decided"] == "2026-04-26"
    assert rec["lifecycle"]["review_by"] == "2026-06-07"


def test_sample_events_marked_in_index(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    ev = _make_event(sample=True)
    emit(memory, [ev])
    idx = load_index(memory)
    rec = next(e for e in idx["events"] if e["id"] == ev.id)
    assert rec["sample"] is True


# ----------------------------------------------------------------------
# rebuild_index


def test_rebuild_index_reads_existing_files(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    ev1 = _make_event()
    ev2 = _make_event(
        id=make_event_id("b", "comment", "x", "2026-04-27T08:00:00+08:00"),
        ts="2026-04-27T08:00:00+08:00",
        actor="alice",
        body="standup note",
    )
    emit(memory, [ev1, ev2])
    # Wipe the index and rebuild from disk.
    timeline_index_path(memory).unlink()
    idx = rebuild_index(memory)
    ids = sorted(e["id"] for e in idx["events"])
    assert ids == sorted([ev1.id, ev2.id])


def test_rebuild_index_handles_empty_root(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    idx = rebuild_index(memory)
    assert idx == {"version": 1, "events": [], "rebuilt_at": idx["rebuilt_at"]}


# ----------------------------------------------------------------------
# process() — end-to-end on real meeting + decision files


def test_process_meeting_file_emits_chunks_and_summary(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    meeting_path = memory / "meetings" / "2026-04-26-david-sync.md"
    body = (
        "---\n"
        "date: 2026-04-26\n"
        "title: David sync\n"
        "source: discord\n"
        "participants:\n"
        "- daizhe\n"
        "- david\n"
        "duration_min: 47\n"
        "meeting_id: 2026-04-26-david-sync\n"
        "---\n\n"
        "## Transcript\n\n"
        "[09:30:00] daizhe: lets review pricing\n"
        "[09:31:00] david: i think we need 20 seats minimum\n"
        "[09:32:00] daizhe: agreed, lock it\n\n"
        "## Summary\n\nPricing locked at 20 seats.\n\n"
        "## Decisions\n\n- [pricing 20 seats](../decisions/pricing-20-seats.md)\n"
    )
    _write(meeting_path, body)
    res = process(memory, meeting_path)
    assert len(res.events) >= 4  # 3 chunks + 1 summary + 1 decision pointer
    kinds = {e.kind for e in res.events}
    assert "meeting_chunk" in kinds
    assert "summary" in kinds
    assert "decision" in kinds
    # People fan-out
    assert (memory / "people" / "daizhe.md").exists()
    assert (memory / "people" / "david.md").exists()
    # Index was written
    idx = load_index(memory)
    assert len(idx["events"]) >= 4


def test_process_meeting_idempotent(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    meeting_path = memory / "meetings" / "2026-04-26-x.md"
    body = (
        "---\ndate: 2026-04-26\ntitle: x\nparticipants:\n- ana\n"
        "meeting_id: 2026-04-26-x\n---\n\n"
        "## Transcript\n\n[10:00:00] ana: hi\n"
    )
    _write(meeting_path, body)
    process(memory, meeting_path)
    snap1 = (memory / "timeline" / "2026-04-26.md").read_text(encoding="utf-8")
    idx1 = json.loads(timeline_index_path(memory).read_text(encoding="utf-8"))
    process(memory, meeting_path)
    snap2 = (memory / "timeline" / "2026-04-26.md").read_text(encoding="utf-8")
    idx2 = json.loads(timeline_index_path(memory).read_text(encoding="utf-8"))
    assert snap1 == snap2
    # Index can differ in `rebuilt_at` only — emit() doesn't write that field;
    # all event records must match.
    assert idx1["events"] == idx2["events"]


def test_process_decision_file_emits_decision_event(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    decision_path = memory / "decisions" / "pricing-20-seats.md"
    body = (
        "---\ndate: 2026-04-26\ntitle: Pricing 20 seats\nsource: meeting\n"
        "source_id: 2026-04-26-david-sync\nstatus: decided\n---\n\n"
        "## Decision\n\nDecided to charge $20/seat\n\n"
        "**Decided by**: daizhe, david\n\n## Context\n\n...\n"
    )
    _write(decision_path, body)
    res = process(memory, decision_path)
    assert len(res.events) == 1
    ev = res.events[0]
    assert ev.kind == "decision"
    assert ev.lifecycle.decided == "2026-04-26"
    assert "pricing-20-seats" in ev.refs.decisions
    assert "daizhe" in ev.refs.people


def test_process_unknown_file_uses_generic_extractor(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    other_path = memory / "linear" / "iss-101.md"
    _write(other_path, "---\nactor: alice\nts: 2026-04-26T11:00:00+08:00\n---\n\nfoo\n")
    res = process(memory, other_path)
    assert len(res.events) == 1
    assert res.events[0].kind == "comment"
    assert res.events[0].actor == "alice"


def test_process_missing_file_returns_empty(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    res = process(memory, memory / "does-not-exist.md")
    assert res.events == []


# ----------------------------------------------------------------------
# Performance — synthetic 10K events on rebuild


@pytest.mark.timeout(10)
def test_rebuild_10k_events_under_2s(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    # Spread over 100 days to keep daily files modest (~100 events each).
    base_date = datetime(2026, 1, 1, tzinfo=timezone.utc)
    events: list[Event] = []
    for i in range(10_000):
        day = base_date.fromordinal(base_date.toordinal() + (i % 100)).date().isoformat()
        ts = f"{day}T{(i % 24):02d}:{((i * 7) % 60):02d}:00+08:00"
        ev_id = make_event_id("synthetic", "comment", f"i{i}", ts)
        events.append(
            Event(
                id=ev_id,
                ts=ts,
                source="system",
                actor=f"user{i % 5}",
                actors=[f"user{i % 5}"],
                kind="comment",
                refs=EventRefs(),
                body=f"event {i}",
            )
        )
    # Emit in batches so we exercise the upsert path realistically.
    BATCH = 500
    for chunk_start in range(0, len(events), BATCH):
        emit(memory, events[chunk_start : chunk_start + BATCH])
    # Wipe the cached index and time the rebuild.
    timeline_index_path(memory).unlink()
    import time

    start = time.perf_counter()
    idx = rebuild_index(memory)
    elapsed = time.perf_counter() - start
    assert len(idx["events"]) == 10_000
    assert elapsed < 2.0, f"rebuild took {elapsed:.3f}s, want < 2s"


# ----------------------------------------------------------------------
# Sidecar layout


def test_sidecar_dir_is_sibling_of_memory_root(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    sd = sidecar_dir(memory)
    assert sd == tmp_path / ".tangerine"
    assert sd.exists()


def test_timeline_dir_under_memory_root(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    td = timeline_dir(memory)
    assert td == memory / "timeline"
    assert td.exists()


def test_write_sidecar_docs_creates_readme_and_schema(tmp_path: Path) -> None:
    from tmi.event_router import write_sidecar_docs

    memory = tmp_path / "memory"
    readme, schema = write_sidecar_docs(memory)
    assert readme.exists()
    assert schema.exists()
    readme_text = readme.read_text(encoding="utf-8")
    assert "Records Management" in readme_text
    assert "timeline.json" in readme_text
    assert "RMS v1.7" in schema.read_text(encoding="utf-8")


def test_write_sidecar_docs_idempotent(tmp_path: Path) -> None:
    from tmi.event_router import write_sidecar_docs

    memory = tmp_path / "memory"
    r1, s1 = write_sidecar_docs(memory)
    text1 = r1.read_text(encoding="utf-8")
    r2, s2 = write_sidecar_docs(memory)
    text2 = r2.read_text(encoding="utf-8")
    assert text1 == text2
    assert r1 == r2 and s1 == s2
