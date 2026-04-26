"""Tests for tmi.cursors (A3)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tmi.cursors import (
    DEFAULT_PREFERENCES,
    Cursor,
    alignment_path,
    compute_alignment,
    compute_diff,
    cursor_file_path,
    list_users,
    load_cursor,
    mark_acked,
    mark_deferred,
    mark_opened,
    mark_viewed,
    save_cursor,
    set_thread_cursor,
    stale_users,
    write_alignment_history,
)
from tmi.event_router import Event, EventRefs, emit, make_event_id


def _make_event(idx: int, *, ts: str, sample: bool = False) -> Event:
    return Event(
        id=make_event_id("synth", "comment", f"i{idx}", ts),
        ts=ts,
        source="system",
        actor="daizhe",
        actors=["daizhe"],
        kind="comment",
        refs=EventRefs(),
        body=f"event {idx}",
        sample=sample,
    )


# ----------------------------------------------------------------------
# Schema + paths


def test_cursor_round_trips_through_dict() -> None:
    cur = Cursor(
        user="daizhe",
        last_opened_at="2026-04-26T08:55:00+08:00",
        atoms_viewed={"evt-2026-04-26-aaaaaaaaaa": "2026-04-26T09:00:00+08:00"},
    )
    assert Cursor.from_dict(cur.to_dict()) == cur


def test_cursor_file_path_rejects_bad_alias(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        cursor_file_path(tmp_path / "memory", "Bad-User")
    with pytest.raises(ValueError):
        cursor_file_path(tmp_path / "memory", "..")


def test_load_cursor_returns_fresh_when_missing(tmp_path: Path) -> None:
    cur = load_cursor(tmp_path / "memory", "ghost")
    assert cur.user == "ghost"
    assert cur.last_opened_at is None
    assert cur.atoms_viewed == {}


def test_save_then_load_round_trip(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    cur = Cursor(user="daizhe", last_opened_at="2026-04-26T08:55:00+08:00")
    save_cursor(memory, cur)
    loaded = load_cursor(memory, "daizhe")
    assert loaded == cur


def test_load_cursor_handles_corrupt_json(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    p = cursor_file_path(memory, "daizhe")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("not json", encoding="utf-8")
    cur = load_cursor(memory, "daizhe")
    assert cur.atoms_viewed == {}


# ----------------------------------------------------------------------
# Mark API


def test_mark_opened_sets_timestamp(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    cur = mark_opened(memory, "daizhe")
    assert cur.last_opened_at is not None
    assert cur.last_opened_at == load_cursor(memory, "daizhe").last_opened_at


def test_mark_viewed_records_atom(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    aid = make_event_id("a", "x", "y", "2026-04-26T09:00:00+08:00")
    cur = mark_viewed(memory, "daizhe", aid)
    assert aid in cur.atoms_viewed


def test_mark_viewed_first_view_wins(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    aid = make_event_id("a", "x", "y", "2026-04-26T09:00:00+08:00")
    first = mark_viewed(memory, "daizhe", aid)
    first_ts = first.atoms_viewed[aid]
    second = mark_viewed(memory, "daizhe", aid)
    assert second.atoms_viewed[aid] == first_ts


def test_mark_acked_implies_viewed(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    aid = make_event_id("a", "x", "y", "2026-04-26T09:00:00+08:00")
    cur = mark_acked(memory, "daizhe", aid)
    assert aid in cur.atoms_acked
    assert aid in cur.atoms_viewed


def test_mark_deferred_records_until(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    aid = make_event_id("a", "x", "y", "2026-04-26T09:00:00+08:00")
    cur = mark_deferred(memory, "daizhe", aid, "2026-04-27T00:00:00+08:00")
    assert cur.atoms_deferred[aid] == "2026-04-27T00:00:00+08:00"


def test_set_thread_cursor_records_atom(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    aid = make_event_id("a", "x", "y", "2026-04-26T09:00:00+08:00")
    cur = set_thread_cursor(memory, "daizhe", "pricing-debate", aid)
    assert cur.thread_cursor["pricing-debate"] == aid


def test_mark_invalid_atom_id_rejected(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    with pytest.raises(ValueError):
        mark_viewed(memory, "daizhe", "not-an-atom-id")


def test_list_users_finds_cursor_files(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    save_cursor(memory, Cursor(user="daizhe"))
    save_cursor(memory, Cursor(user="eric"))
    assert list_users(memory) == ["daizhe", "eric"]


# ----------------------------------------------------------------------
# Diff


def test_compute_diff_returns_unseen_events(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    e1 = _make_event(1, ts="2026-04-26T09:00:00+08:00")
    e2 = _make_event(2, ts="2026-04-26T10:00:00+08:00")
    emit(memory, [e1, e2])
    # User opened the app at 08:00, hasn't viewed anything yet.
    save_cursor(
        memory, Cursor(user="daizhe", last_opened_at="2026-04-26T08:00:00+08:00")
    )
    diff = compute_diff(memory, "daizhe")
    ids = {r["id"] for r in diff}
    assert ids == {e1.id, e2.id}


def test_compute_diff_skips_already_viewed(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    e1 = _make_event(1, ts="2026-04-26T09:00:00+08:00")
    e2 = _make_event(2, ts="2026-04-26T10:00:00+08:00")
    emit(memory, [e1, e2])
    cur = Cursor(
        user="daizhe",
        last_opened_at="2026-04-26T08:00:00+08:00",
        atoms_viewed={e1.id: "2026-04-26T09:30:00+08:00"},
    )
    save_cursor(memory, cur)
    diff = compute_diff(memory, "daizhe")
    assert {r["id"] for r in diff} == {e2.id}


def test_compute_diff_skips_samples(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    e1 = _make_event(1, ts="2026-04-26T09:00:00+08:00", sample=True)
    e2 = _make_event(2, ts="2026-04-26T10:00:00+08:00")
    emit(memory, [e1, e2])
    save_cursor(
        memory, Cursor(user="daizhe", last_opened_at="2026-04-26T08:00:00+08:00")
    )
    diff = compute_diff(memory, "daizhe")
    assert {r["id"] for r in diff} == {e2.id}


def test_compute_diff_only_after_last_opened(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    e_old = _make_event(1, ts="2026-04-25T09:00:00+08:00")
    e_new = _make_event(2, ts="2026-04-26T09:00:00+08:00")
    emit(memory, [e_old, e_new])
    save_cursor(
        memory, Cursor(user="daizhe", last_opened_at="2026-04-26T07:00:00+08:00")
    )
    diff = compute_diff(memory, "daizhe")
    assert {r["id"] for r in diff} == {e_new.id}


# ----------------------------------------------------------------------
# Alignment


def test_compute_alignment_zero_when_no_events(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    save_cursor(memory, Cursor(user="daizhe"))
    snap = compute_alignment(memory)
    assert snap["total_atoms"] == 0
    assert snap["rate"] == 0.0


def test_compute_alignment_full_when_all_users_viewed_all(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    e1 = _make_event(1, ts="2026-04-26T09:00:00+08:00")
    e2 = _make_event(2, ts="2026-04-26T10:00:00+08:00")
    emit(memory, [e1, e2])
    for u in ("daizhe", "eric"):
        cur = Cursor(
            user=u,
            atoms_viewed={
                e1.id: "2026-04-26T09:30:00+08:00",
                e2.id: "2026-04-26T10:30:00+08:00",
            },
        )
        save_cursor(memory, cur)
    snap = compute_alignment(memory)
    assert snap["total_atoms"] == 2
    assert snap["shared_viewed"] == 2
    assert snap["rate"] == 1.0
    assert snap["per_user_seen"] == {"daizhe": 2, "eric": 2}


def test_compute_alignment_partial(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    e1 = _make_event(1, ts="2026-04-26T09:00:00+08:00")
    e2 = _make_event(2, ts="2026-04-26T10:00:00+08:00")
    e3 = _make_event(3, ts="2026-04-26T11:00:00+08:00")
    emit(memory, [e1, e2, e3])
    # daizhe saw all, eric saw only e1
    save_cursor(
        memory,
        Cursor(
            user="daizhe",
            atoms_viewed={e1.id: "x", e2.id: "x", e3.id: "x"},
        ),
    )
    save_cursor(memory, Cursor(user="eric", atoms_viewed={e1.id: "x"}))
    snap = compute_alignment(memory)
    assert snap["total_atoms"] == 3
    assert snap["shared_viewed"] == 1
    assert snap["rate"] == round(1 / 3, 4)
    assert snap["per_user_seen"]["daizhe"] == 3
    assert snap["per_user_seen"]["eric"] == 1


def test_compute_alignment_skips_samples(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    e_real = _make_event(1, ts="2026-04-26T09:00:00+08:00")
    e_sample = _make_event(2, ts="2026-04-26T10:00:00+08:00", sample=True)
    emit(memory, [e_real, e_sample])
    save_cursor(memory, Cursor(user="daizhe", atoms_viewed={e_real.id: "x"}))
    snap = compute_alignment(memory)
    assert snap["total_atoms"] == 1
    assert snap["shared_viewed"] == 1


def test_write_alignment_history_appends_and_caps(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    snap1 = compute_alignment(memory, users=["daizhe"])
    write_alignment_history(memory, snap1)
    snap2 = compute_alignment(memory, users=["daizhe"])
    write_alignment_history(memory, snap2)
    raw = json.loads(alignment_path(memory).read_text(encoding="utf-8"))
    assert len(raw["history"]) == 2
    assert raw["latest"] == snap2


# ----------------------------------------------------------------------
# Stale users


def test_stale_users_returns_users_past_threshold(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    e1 = _make_event(1, ts="2026-04-26T09:00:00+08:00")
    emit(memory, [e1])
    # User opened a long time ago; threshold default 48h.
    save_cursor(
        memory,
        Cursor(user="eric", last_opened_at="2020-01-01T00:00:00+08:00"),
    )
    stale = stale_users(memory)
    assert any(s["user"] == "eric" for s in stale)


def test_stale_users_skips_users_who_never_opened(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    e1 = _make_event(1, ts="2026-04-26T09:00:00+08:00")
    emit(memory, [e1])
    save_cursor(memory, Cursor(user="ghost"))  # last_opened_at = None
    assert stale_users(memory) == []


# ----------------------------------------------------------------------
# Stage 2 hook §7 — preferences block on cursors


def test_default_preferences_keys_match_spec() -> None:
    expected = {
        "brief_style",
        "brief_time",
        "notification_channels",
        "topics_of_interest",
        "topics_to_skip",
    }
    assert set(DEFAULT_PREFERENCES.keys()) == expected
    assert DEFAULT_PREFERENCES["brief_style"] == "default"
    assert DEFAULT_PREFERENCES["brief_time"] == "08:00"


def test_fresh_cursor_starts_with_default_preferences() -> None:
    cur = Cursor(user="daizhe")
    assert cur.preferences["brief_style"] == "default"
    assert cur.preferences["brief_time"] == "08:00"
    assert cur.preferences["notification_channels"] == ["os", "email"]
    assert cur.preferences["topics_of_interest"] == []
    assert cur.preferences["topics_to_skip"] == []


def test_cursor_preferences_persist_round_trip(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    cur = Cursor(user="daizhe")
    cur.preferences["brief_style"] = "terse"
    cur.preferences["topics_of_interest"] = ["pricing", "v1-launch"]
    save_cursor(memory, cur)
    re = load_cursor(memory, "daizhe")
    assert re.preferences["brief_style"] == "terse"
    assert re.preferences["topics_of_interest"] == ["pricing", "v1-launch"]


def test_legacy_cursor_without_preferences_gets_defaults_on_load(tmp_path: Path) -> None:
    """Cursor written by an older version (no preferences key) MUST upgrade
    cleanly — Stage 2 should never crash on an old cursor file."""
    memory = tmp_path / "memory"
    path = cursor_file_path(memory, "olduser")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({
            "user": "olduser",
            "last_opened_at": "2026-04-26T08:00:00+08:00",
            "atoms_viewed": {},
            "atoms_acked": {},
            "atoms_deferred": {},
            "thread_cursor": {},
        }),
        encoding="utf-8",
    )
    cur = load_cursor(memory, "olduser")
    assert cur.preferences["brief_style"] == "default"
    assert cur.preferences["topics_of_interest"] == []


def test_partial_preferences_get_missing_keys_filled(tmp_path: Path) -> None:
    """Cursor with some preference keys keeps user values + fills holes."""
    memory = tmp_path / "memory"
    path = cursor_file_path(memory, "partial")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({
            "user": "partial",
            "preferences": {"brief_style": "numbers-first"},  # missing the rest
        }),
        encoding="utf-8",
    )
    cur = load_cursor(memory, "partial")
    assert cur.preferences["brief_style"] == "numbers-first"  # user value preserved
    assert cur.preferences["brief_time"] == "08:00"            # default filled
    assert cur.preferences["topics_of_interest"] == []          # default filled


def test_preferences_default_lists_are_independent_per_cursor() -> None:
    """Two cursors must not share the same default list instance."""
    a = Cursor(user="a")
    b = Cursor(user="b")
    a.preferences["topics_of_interest"].append("contamination")  # type: ignore[union-attr]
    assert b.preferences["topics_of_interest"] == []
