"""Tests for tmi.intent."""

from __future__ import annotations

from pathlib import Path

import pytest

from tmi.intent import (
    intent_path,
    is_locked,
    read_intent,
    validate_intent_text,
    write_intent,
)
from tmi.utils import now_iso

VALID_INTENT = """\
---
schema_version: 1
author: daizhe
created_at: 2026-04-24T18:00:00+08:00
locked: true
locked_at: 2026-04-24T18:35:00+08:00
turn_count: 5
---

## Topics

### Topic 1: v1 scope
- **Type**: decision
- **Goal**: lock Discord-only v1
- **My current stance**: yes

### Topic 2: standup cadence
- **Type**: sync
- **Goal**: agree on Monday standup
"""


def test_validate_happy_path() -> None:
    fm, body = validate_intent_text(VALID_INTENT)
    assert fm.author == "daizhe"
    assert fm.locked is True
    assert "## Topics" in body


def test_missing_frontmatter_rejected() -> None:
    with pytest.raises(ValueError):
        validate_intent_text("## Topics\n### Topic 1: x\n- **Type**: sync\n- **Goal**: g\n")


def test_missing_topics_rejected() -> None:
    bad = """\
---
schema_version: 1
author: daizhe
created_at: 2026-04-24T18:00:00+08:00
locked: false
turn_count: 0
---

just prose
"""
    with pytest.raises(ValueError):
        validate_intent_text(bad)


def test_topic_missing_type_rejected() -> None:
    bad = """\
---
schema_version: 1
author: daizhe
created_at: 2026-04-24T18:00:00+08:00
locked: false
turn_count: 0
---

## Topics

### Topic 1: x
- **Goal**: g
"""
    with pytest.raises(ValueError):
        validate_intent_text(bad)


def test_topic_unknown_type_rejected() -> None:
    bad = VALID_INTENT.replace("**Type**: decision", "**Type**: nonsense")
    with pytest.raises(ValueError):
        validate_intent_text(bad)


def test_write_intent_atomic(tmp_path: Path) -> None:
    mdir = tmp_path / "m"
    (mdir / "intents").mkdir(parents=True)
    fm = write_intent(mdir, "daizhe", VALID_INTENT)
    assert fm.locked is True
    assert intent_path(mdir, "daizhe").exists()
    assert is_locked(mdir, "daizhe") is True


def test_write_intent_alias_mismatch(tmp_path: Path) -> None:
    mdir = tmp_path / "m"
    (mdir / "intents").mkdir(parents=True)
    with pytest.raises(ValueError):
        write_intent(mdir, "hongyu", VALID_INTENT)  # frontmatter says daizhe


def test_read_intent_roundtrip(tmp_path: Path) -> None:
    mdir = tmp_path / "m"
    (mdir / "intents").mkdir(parents=True)
    write_intent(mdir, "daizhe", VALID_INTENT)
    fm, body = read_intent(mdir, "daizhe")
    assert fm.author == "daizhe"
    assert "Topic 1" in body
