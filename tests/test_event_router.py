"""Tests for tmi.event_router (A1)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from tmi.event_router import (
    DEFAULT_AGI_FIELDS,
    DEFAULT_VECTOR_STORE,
    DEFAULT_WORLD_MODEL,
    Event,
    EventLifecycle,
    EventRefs,
    clear_atom_subscribers,
    emit,
    ensure_world_model,
    load_index,
    make_event_id,
    on_atom,
    process,
    rebuild_index,
    sidecar_dir,
    timeline_dir,
    timeline_file_path,
    timeline_index_path,
    validate_atom,
    world_model_path,
    write_sidecar_docs,
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
    # vector_store slot ships in every index per Stage 2 hook §6.
    assert idx == {
        "version": 1,
        "events": [],
        "rebuilt_at": idx["rebuilt_at"],
        "vector_store": DEFAULT_VECTOR_STORE,
    }


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


def test_sidecar_dir_default_is_inside_memory_root(tmp_path: Path) -> None:
    """v1.20.1 — sidecar unified on ``<memory_root>/.tangerine`` to match
    the Rust daemon. Prior versions put it at ``memory_root.parent/.tangerine``
    which left the Python writer and Rust reader pointing at different paths
    on disk.
    """
    memory = tmp_path / "memory"
    sd = sidecar_dir(memory)
    assert sd == memory / ".tangerine"
    assert sd.exists()


def test_sidecar_dir_honours_legacy_path_for_existing_installs(
    tmp_path: Path,
) -> None:
    """Backward compat: if the legacy ``<parent>/.tangerine`` already
    exists with content (an upgraded user from <=v1.20.0), keep using
    it so cursors / briefs / alignment files written before the upgrade
    aren't orphaned.
    """
    memory = tmp_path / "memory"
    memory.mkdir(parents=True)
    legacy = tmp_path / ".tangerine"
    legacy.mkdir()
    (legacy / "cursors").mkdir()
    sd = sidecar_dir(memory)
    assert sd == legacy


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


# ----------------------------------------------------------------------
# Stage 2 hook §1 — atom validation (8 future-proof fields)


def test_validate_atom_injects_all_defaults_when_absent() -> None:
    raw: dict[str, object] = {"id": "evt-x", "ts": "2026-04-26T09:30:00+08:00"}
    out = validate_atom(raw)
    # Same dict mutated + returned
    assert out is raw
    for key, default in DEFAULT_AGI_FIELDS.items():
        assert key in out
        assert out[key] == default


def test_validate_atom_preserves_existing_values() -> None:
    raw: dict[str, object] = {
        "id": "evt-x",
        "embedding": [0.1, 0.2, 0.3],
        "concepts": ["postgres", "migration"],
        "confidence": 0.42,
        "alternatives": [{"interpretation": "another"}],
        "source_count": 3,
        "reasoning_notes": "double-checked",
        "sentiment": "neutral",
        "importance": 0.8,
    }
    out = validate_atom(raw)
    assert out["embedding"] == [0.1, 0.2, 0.3]
    assert out["concepts"] == ["postgres", "migration"]
    assert out["confidence"] == 0.42
    assert out["alternatives"] == [{"interpretation": "another"}]
    assert out["source_count"] == 3
    assert out["reasoning_notes"] == "double-checked"
    assert out["sentiment"] == "neutral"
    assert out["importance"] == 0.8


def test_validate_atom_default_lists_are_independent() -> None:
    """Two atoms validated separately must not share the same list instance."""
    a: dict[str, object] = {}
    b: dict[str, object] = {}
    validate_atom(a)
    validate_atom(b)
    assert isinstance(a["concepts"], list)
    assert isinstance(b["concepts"], list)
    a["concepts"].append("contamination")  # type: ignore[union-attr]
    assert b["concepts"] == []


def test_default_agi_fields_are_8() -> None:
    """Schema must reserve exactly 8 future-proof slots per STAGE1_AGI_HOOKS.md."""
    expected = {
        "embedding",
        "concepts",
        "confidence",
        "alternatives",
        "source_count",
        "reasoning_notes",
        "sentiment",
        "importance",
    }
    assert set(DEFAULT_AGI_FIELDS.keys()) == expected


# ----------------------------------------------------------------------
# Stage 2 hook §1 — Event dataclass exposes the 8 fields


def test_event_dataclass_has_agi_fields_with_defaults() -> None:
    ev = _make_event()
    assert ev.embedding is None
    assert ev.concepts == []
    assert ev.confidence == 1.0
    assert ev.alternatives == []
    assert ev.source_count == 1
    assert ev.reasoning_notes is None
    assert ev.sentiment is None
    assert ev.importance is None


def test_emit_does_not_pollute_index_with_default_agi_fields(tmp_path: Path) -> None:
    """Default values stay out of the index to keep it lean. Only non-defaults
    bubble up so Stage 2 reads can detect 'has been processed' cheaply."""
    memory = tmp_path / "memory"
    ev = _make_event()
    emit(memory, [ev])
    idx = load_index(memory)
    rec = next(e for e in idx["events"] if e["id"] == ev.id)
    for key in DEFAULT_AGI_FIELDS:
        assert key not in rec, f"default {key} leaked into index"


def test_emit_serializes_non_default_agi_fields_into_index(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    ev = _make_event(
        embedding=[0.1, 0.2],
        concepts=["postgres"],
        confidence=0.7,
        sentiment="neutral",
        importance=0.55,
    )
    emit(memory, [ev])
    idx = load_index(memory)
    rec = next(e for e in idx["events"] if e["id"] == ev.id)
    assert rec["embedding"] == [0.1, 0.2]
    assert rec["concepts"] == ["postgres"]
    assert rec["confidence"] == 0.7
    assert rec["sentiment"] == "neutral"
    assert rec["importance"] == 0.55


# ----------------------------------------------------------------------
# Stage 2 hook §2 — on_atom subscriber API


def test_on_atom_dispatches_to_subscribers(tmp_path: Path) -> None:
    clear_atom_subscribers()
    seen: list[tuple[dict[str, object], list[str]]] = []

    @on_atom
    def collect(atom: dict[str, object], paths: list[str]) -> None:
        seen.append((atom, paths))

    try:
        memory = tmp_path / "memory"
        ev = _make_event()
        emit(memory, [ev])
        assert len(seen) == 1
        atom, paths = seen[0]
        # Validated atom carries the AGI defaults.
        for k in DEFAULT_AGI_FIELDS:
            assert k in atom
        # Fan-out paths include the timeline file at minimum.
        assert any("timeline" in p for p in paths)
    finally:
        clear_atom_subscribers()


def test_on_atom_subscriber_failure_does_not_break_ingest(tmp_path: Path) -> None:
    clear_atom_subscribers()

    @on_atom
    def boom(atom, paths):
        raise RuntimeError("subscriber sad")

    try:
        memory = tmp_path / "memory"
        ev = _make_event()
        # Should not raise.
        emit(memory, [ev])
        # Atom still landed in the timeline.
        idx = load_index(memory)
        assert any(e["id"] == ev.id for e in idx["events"])
    finally:
        clear_atom_subscribers()


def test_on_atom_no_subscribers_is_silent(tmp_path: Path) -> None:
    clear_atom_subscribers()
    memory = tmp_path / "memory"
    ev = _make_event()
    res = emit(memory, [ev])
    assert ev in res.events  # ingest still works


# ----------------------------------------------------------------------
# Stage 2 hook §6 — vector_store slot in index.json


def test_load_index_seeds_vector_store_when_missing(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    idx = load_index(memory)
    assert idx.get("vector_store") == DEFAULT_VECTOR_STORE


def test_emit_persists_vector_store_block(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    ev = _make_event()
    emit(memory, [ev])
    idx = load_index(memory)
    assert idx["vector_store"]["type"] == "none"
    assert idx["vector_store"]["dimensions"] is None
    assert idx["vector_store"]["model"] is None


def test_rebuild_index_preserves_vector_store_setting(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    ev = _make_event()
    emit(memory, [ev])
    # Simulate Stage 2 flipping the flag.
    from tmi.event_router import save_index

    idx = load_index(memory)
    idx["vector_store"] = {"type": "sqlite-vec", "dimensions": 1536, "model": "ada-3"}
    save_index(memory, idx)
    # Rebuild — preserved.
    rebuilt = rebuild_index(memory)
    assert rebuilt["vector_store"] == {
        "type": "sqlite-vec",
        "dimensions": 1536,
        "model": "ada-3",
    }


# ----------------------------------------------------------------------
# Stage 2 hook §8 — world_model.json


def test_ensure_world_model_creates_file_with_defaults(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    p = ensure_world_model(memory)
    assert p.exists()
    assert p == world_model_path(memory)
    loaded = json.loads(p.read_text(encoding="utf-8"))
    assert loaded == DEFAULT_WORLD_MODEL


def test_ensure_world_model_idempotent_does_not_overwrite(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    ensure_world_model(memory)
    p = world_model_path(memory)
    # Tinker with it as Stage 2 would.
    p.write_text(json.dumps({"version": 1, "team_state": {"members": {"daizhe": {}}}}),
                 encoding="utf-8")
    ensure_world_model(memory)
    # Still our content.
    loaded = json.loads(p.read_text(encoding="utf-8"))
    assert "members" in loaded["team_state"]


def test_default_world_model_has_team_health_block() -> None:
    health = DEFAULT_WORLD_MODEL["team_state"]["team_health"]  # type: ignore[index]
    assert set(health.keys()) == {
        "alignment",
        "velocity",
        "thrash_score",
        "decision_freshness",
    }
    # Stage 1 starts everything null; daemon updates alignment over time.
    assert all(v is None for v in health.values())


def test_write_sidecar_docs_seeds_world_model(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    write_sidecar_docs(memory)
    assert world_model_path(memory).exists()


# ----------------------------------------------------------------------
# v1.20.1 regression: rebuild_index walks personal-agent atoms
#
# Before v1.20.1, `rebuild_index` only walked sentinel-fenced blocks in
# `timeline/<YYYY-MM-DD>.md`. Personal-agent atoms (written one .md per
# conversation under `personal/<user>/threads/<source>/<id>.md`) and
# top-level `decisions/*.md` / `meetings/*.md` files were never picked
# up, so `read_timeline_recent` returned `[]` even when atoms existed
# on disk.  This is the regression test for the fix that closes the
# pipeline.


def test_rebuild_index_picks_up_personal_agent_atoms(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    threads_dir = memory / "personal" / "me" / "threads" / "claude-code"
    threads_dir.mkdir(parents=True)
    atom_path = threads_dir / "abc-123.md"
    atom_path.write_text(
        "---\n"
        "source: claude-code\n"
        "conversation_id: abc-123\n"
        "started_at: 2026-04-29T21:17:33.146Z\n"
        "ended_at: 2026-04-30T05:25:59.661Z\n"
        "message_count: 91\n"
        "source_mtime_nanos: 1777526759962999000\n"
        "topic: refactor the timeline rebuild path\n"
        "---\n"
        "\n"
        "# refactor the timeline rebuild path\n"
        "\n"
        "**User**: ...body...\n",
        encoding="utf-8",
    )
    idx = rebuild_index(memory)
    events = idx["events"]
    assert isinstance(events, list)
    assert len(events) == 1
    rec = events[0]
    assert rec["source"] == "claude-code"
    assert rec["kind"] == "thread"
    # YAML auto-parses ISO 8601 ts into datetime; we round-trip via
    # isoformat so the on-disk shape may add microsecond zeros and a
    # `+00:00` tz suffix for `Z`. The date prefix is what /feed sorts on.
    assert str(rec["ts"]).startswith("2026-04-30T05:25:59")
    assert rec["body"] == "refactor the timeline rebuild path"
    # Index has been written to disk under the unified sidecar layout.
    sidecar_index = timeline_index_path(memory)
    assert sidecar_index.exists()
    on_disk = json.loads(sidecar_index.read_text(encoding="utf-8"))
    assert len(on_disk["events"]) == 1


def test_rebuild_index_combines_timeline_and_personal_atoms(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    # Personal-agent atom.
    threads_dir = memory / "personal" / "me" / "threads" / "claude-code"
    threads_dir.mkdir(parents=True)
    (threads_dir / "session-x.md").write_text(
        "---\nsource: claude-code\nstarted_at: 2026-04-28T10:00:00Z\n"
        "ended_at: 2026-04-28T11:00:00Z\nmessage_count: 5\n"
        "source_mtime_nanos: 1\n---\n\n# Session X\n",
        encoding="utf-8",
    )
    # Sentinel-fenced timeline block (the existing format).
    ev = _make_event(
        id="evt-2026-04-29-deadbeef99",
        ts="2026-04-29T09:30:00+08:00",
    )
    res = emit(memory, [ev])
    assert res.events
    # Force a rebuild — should pick up both shapes.
    idx = rebuild_index(memory)
    events = idx["events"]
    assert len(events) == 2
    sources = {e["source"] for e in events}
    assert sources == {"claude-code", "github"}


def test_rebuild_index_dedupes_when_both_shapes_collide(tmp_path: Path) -> None:
    """Sentinel block wins when its id matches a standalone-atom record."""
    memory = tmp_path / "memory"
    ev = _make_event(
        id="evt-2026-04-26-abcd012345",
        ts="2026-04-26T09:30:00+08:00",
    )
    emit(memory, [ev])
    # Now write a standalone atom whose synthetic id might collide.
    threads_dir = memory / "personal" / "me" / "threads" / "claude-code"
    threads_dir.mkdir(parents=True)
    (threads_dir / "evt-2026-04-26-abcd012345.md").write_text(
        "---\nsource: claude-code\nts: 2026-04-26T09:30:00+08:00\n"
        "kind: thread\n---\n\n# topic\n",
        encoding="utf-8",
    )
    idx = rebuild_index(memory)
    events = idx["events"]
    # Only the canonical sentinel block survives — no duplicate.
    ids = [e["id"] for e in events]
    assert len(ids) == len(set(ids)), "rebuild produced duplicate ids"


def test_rebuild_index_skips_unparseable_atoms(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    threads_dir = memory / "personal" / "me" / "threads" / "claude-code"
    threads_dir.mkdir(parents=True)
    # No frontmatter at all.
    (threads_dir / "no-fm.md").write_text("just a markdown file\n", encoding="utf-8")
    # Frontmatter but no resolvable timestamp.
    (threads_dir / "no-ts.md").write_text(
        "---\nsource: claude-code\n---\n\nbody\n", encoding="utf-8"
    )
    # One valid atom — survives.
    (threads_dir / "ok.md").write_text(
        "---\nsource: claude-code\nstarted_at: 2026-04-28T10:00:00Z\n"
        "ended_at: 2026-04-28T11:00:00Z\nmessage_count: 1\n"
        "source_mtime_nanos: 1\n---\n\n# Ok\n",
        encoding="utf-8",
    )
    idx = rebuild_index(memory)
    events = idx["events"]
    assert len(events) == 1
    assert str(events[0].get("file", "")).endswith("ok.md")


def test_rebuild_index_writes_timeline_json_to_unified_sidecar(
    tmp_path: Path,
) -> None:
    """The Rust daemon reads ``<memory_root>/.tangerine/timeline.json``.
    v1.20.1 unifies the Python writer on the same path. This test guards
    the regression Daizhe hit on his actual machine — atoms on disk but
    timeline.json missing because Python was writing to memory.parent.
    """
    memory = tmp_path / ".tangerine-memory"
    memory.mkdir()
    threads_dir = memory / "personal" / "me" / "threads" / "claude-code"
    threads_dir.mkdir(parents=True)
    (threads_dir / "session.md").write_text(
        "---\nsource: claude-code\nended_at: 2026-04-30T00:00:00Z\n"
        "started_at: 2026-04-29T00:00:00Z\nmessage_count: 1\n"
        "source_mtime_nanos: 1\ntopic: hello\n---\n\n# hello\n",
        encoding="utf-8",
    )
    rebuild_index(memory)
    # Must land at the unified path the Rust reader expects.
    expected = memory / ".tangerine" / "timeline.json"
    assert expected.exists()
    raw = json.loads(expected.read_text(encoding="utf-8"))
    assert len(raw["events"]) == 1
    assert raw["events"][0]["source"] == "claude-code"
