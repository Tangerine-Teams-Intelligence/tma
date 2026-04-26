"""Tests for tmi.state."""

from __future__ import annotations

from pathlib import Path

import pytest

from tmi.state import (
    LEGAL_TRANSITIONS,
    Status,
    add_error,
    load_status,
    save_status,
    transition,
    update_intent,
)


def test_initial_state_created() -> None:
    s = Status()
    assert s.state == "created"


def test_legal_transition() -> None:
    s = Status()
    transition(s, "prepped")
    assert s.state == "prepped"


def test_illegal_transition_rejected() -> None:
    s = Status()
    with pytest.raises(ValueError):
        transition(s, "merged")


def test_force_overrides() -> None:
    s = Status()
    transition(s, "merged", force=True)
    assert s.state == "merged"


def test_idempotent_same_state() -> None:
    s = Status()
    transition(s, "created")  # no-op
    assert s.state == "created"


def test_full_happy_path() -> None:
    s = Status()
    for tgt in ("prepped", "live", "ended", "wrapped", "reviewed", "merged"):
        transition(s, tgt)
    assert s.state == "merged"


def test_save_load_roundtrip(tmp_path: Path) -> None:
    s = Status()
    transition(s, "prepped")
    save_status(tmp_path, s)
    loaded = load_status(tmp_path)
    assert loaded.state == "prepped"


def test_update_intent(tmp_path: Path) -> None:
    s = Status()
    from tmi.utils import parse_iso, now_iso

    update_intent(s, "daizhe", ready=True, locked_at=parse_iso(now_iso()))
    assert s.intents["daizhe"].ready is True


def test_add_error(tmp_path: Path) -> None:
    s = Status()
    add_error(s, "bot", "whisper_timeout", "test")
    assert len(s.errors) == 1
    assert s.errors[0].code == "whisper_timeout"


def test_legal_transitions_keys_match_enum() -> None:
    # All values in transitions must be valid states (defensive check).
    valid = set(LEGAL_TRANSITIONS.keys())
    for froms, tos in LEGAL_TRANSITIONS.items():
        for t in tos:
            assert t in valid, f"{t} from {froms} is not a known state"
