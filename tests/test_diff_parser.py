"""Tests for diff_parser.parse_diff and serialize_diff (round-trip property)."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from tmi.adapters.diff_parser import DiffParseError, parse_diff, serialize_diff
from tmi.adapters.types import DiffBlock, KnowledgeDiff

FIXTURE = Path(__file__).parent / "fixtures" / "sample_diff.md"


def _read_fixture() -> str:
    return FIXTURE.read_text(encoding="utf-8")


def test_parse_fixture_yields_three_blocks() -> None:
    diff = parse_diff(_read_fixture())
    assert len(diff.blocks) == 3
    assert diff.meeting_id == "2026-04-24-david-sync"
    assert [b.id for b in diff.blocks] == [1, 2, 3]
    assert [b.action for b in diff.blocks] == ["append", "insert", "create"]


def test_parse_extracts_metadata() -> None:
    diff = parse_diff(_read_fixture())
    b1, b2, b3 = diff.blocks
    assert b1.target_file == "knowledge/session-state.md"
    assert b1.transcript_refs == ["L47", "L52", "L58"]
    assert "v1 scope" in b1.reason
    assert b2.insert_anchor == "## Workflow rules"
    assert b3.target_file == "knowledge/whisper-latency.md"
    assert b3.body.startswith("# Whisper API latency")


def test_serialize_round_trip_idempotent() -> None:
    """serialize(parse(x)) == serialize(parse(serialize(parse(x))))."""
    src = _read_fixture()
    parsed = parse_diff(src)
    once = serialize_diff(parsed)
    twice = serialize_diff(parse_diff(once))
    assert once == twice


def test_serialize_round_trip_preserves_canonical_form() -> None:
    """The fixture is in canonical form, so serialize(parse(fixture)) == fixture."""
    src = _read_fixture()
    parsed = parse_diff(src)
    out = serialize_diff(parsed)
    assert out == src, (
        "fixture is canonical; serializer must reproduce it byte-for-byte\n"
        f"---expected---\n{src}\n---got---\n{out}"
    )


def test_parse_rejects_non_monotonic_ids() -> None:
    bad = """<!-- TMA knowledge-diff schema_version=1 meeting_id=t -->

## Block 2 · append · a.md
**Reason**: r
**Transcript refs**: L1
**Block-ID**: 2

```diff
+ x
```
"""
    with pytest.raises(DiffParseError):
        parse_diff(bad)


def test_parse_rejects_block_id_disagreement() -> None:
    bad = """<!-- TMA knowledge-diff schema_version=1 meeting_id=t -->

## Block 1 · append · a.md
**Reason**: r
**Transcript refs**: L1
**Block-ID**: 99

```diff
+ x
```
"""
    with pytest.raises(DiffParseError):
        parse_diff(bad)


def test_parse_rejects_insert_without_anchor() -> None:
    bad = """<!-- TMA knowledge-diff schema_version=1 meeting_id=t -->

## Block 1 · insert · a.md
**Reason**: r
**Transcript refs**: L1
**Block-ID**: 1

```diff
+ x
```
"""
    with pytest.raises(DiffParseError):
        parse_diff(bad)


def test_parse_rejects_wrong_fence_lang_for_create() -> None:
    bad = """<!-- TMA knowledge-diff schema_version=1 meeting_id=t -->

## Block 1 · create · new.md
**Reason**: r
**Transcript refs**: L1
**Block-ID**: 1

```diff
+ should be markdown not diff
```
"""
    with pytest.raises(DiffParseError):
        parse_diff(bad)


def test_parse_rejects_missing_reason() -> None:
    bad = """<!-- TMA knowledge-diff schema_version=1 meeting_id=t -->

## Block 1 · append · a.md
**Transcript refs**: L1
**Block-ID**: 1

```diff
+ x
```
"""
    with pytest.raises(DiffParseError):
        parse_diff(bad)


def test_parse_rejects_unterminated_fence() -> None:
    bad = """<!-- TMA knowledge-diff schema_version=1 meeting_id=t -->

## Block 1 · append · a.md
**Reason**: r
**Transcript refs**: L1
**Block-ID**: 1

```diff
+ x
"""
    with pytest.raises(DiffParseError):
        parse_diff(bad)


def test_empty_diff_parses_to_empty_blocks() -> None:
    src = "<!-- TMA knowledge-diff schema_version=1 meeting_id=empty -->\n\n"
    diff = parse_diff(src)
    assert diff.blocks == []
    assert diff.meeting_id == "empty"


def test_parse_diff_uses_fallback_meeting_id_when_no_preamble() -> None:
    src = """## Block 1 · append · a.md
**Reason**: r
**Transcript refs**: L1
**Block-ID**: 1

```diff
+ x
```
"""
    diff = parse_diff(src, meeting_id_fallback="fallback-id")
    assert diff.meeting_id == "fallback-id"
    assert len(diff.blocks) == 1


def test_serialize_with_anchor_field() -> None:
    diff = KnowledgeDiff(
        blocks=[
            DiffBlock(
                id=1,
                target_file="x.md",
                action="insert",
                insert_anchor="## Heading",
                reason="r",
                transcript_refs=["L1"],
                body="+ new line",
            ),
        ],
        generated_at=datetime.now(timezone.utc),
        meeting_id="t",
    )
    out = serialize_diff(diff)
    assert "**Anchor**: ## Heading" in out
    # round-trip
    again = parse_diff(out)
    assert again.blocks[0].insert_anchor == "## Heading"
