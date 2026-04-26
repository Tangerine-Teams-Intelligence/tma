"""Unit tests for adapter Pydantic types."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from tmi.adapters.types import (
    AppliedResult,
    DiffBlock,
    GroundTruth,
    Intent,
    KnowledgeDiff,
    KnowledgeFile,
    Summary,
    Transcript,
)


def test_diff_block_round_trips_through_pydantic() -> None:
    block = DiffBlock(
        id=1,
        target_file="knowledge/session-state.md",
        action="append",
        reason="test",
        transcript_refs=["L1", "L2-L5"],
        body="+ hello",
    )
    again = DiffBlock.model_validate(block.model_dump())
    assert again == block


def test_diff_block_rejects_path_escape() -> None:
    with pytest.raises(ValueError):
        DiffBlock(
            id=1,
            target_file="../etc/passwd",
            action="append",
            reason="r",
            body="+ x",
        )


def test_diff_block_rejects_absolute_path() -> None:
    with pytest.raises(ValueError):
        DiffBlock(
            id=1,
            target_file="/etc/foo",
            action="append",
            reason="r",
            body="+ x",
        )


def test_diff_block_rejects_backslash_path() -> None:
    with pytest.raises(ValueError):
        DiffBlock(
            id=1,
            target_file="knowledge\\foo.md",
            action="append",
            reason="r",
            body="+ x",
        )


def test_diff_block_id_is_one_based() -> None:
    with pytest.raises(ValueError):
        DiffBlock(
            id=0,
            target_file="x.md",
            action="append",
            reason="r",
            body="+ y",
        )


def test_ground_truth_is_frozen() -> None:
    gt = GroundTruth(
        claude_md="hi",
        session_state="",
        knowledge_files=[],
        detected_at=datetime.now(timezone.utc),
    )
    with pytest.raises((TypeError, ValueError)):
        gt.claude_md = "mutated"  # type: ignore[misc]


def test_knowledge_file_is_frozen() -> None:
    kf = KnowledgeFile(path="knowledge/a.md", content="x")
    with pytest.raises((TypeError, ValueError)):
        kf.content = "y"  # type: ignore[misc]


def test_summary_intent_transcript_basic() -> None:
    s = Summary(markdown="# hi", meeting_id="2026-04-24-test", participants=["a"])
    i = Intent(
        alias="daizhe",
        markdown="---\nx: y\n---\nbody",
        locked_at=datetime.now(timezone.utc),
    )
    t = Transcript(text="[19:00:00] daizhe: hi", line_count=1)
    assert s.meeting_id == "2026-04-24-test"
    assert i.alias == "daizhe"
    assert t.line_count == 1


def test_applied_result_defaults() -> None:
    r = AppliedResult()
    assert r.written_files == []
    assert r.commit_sha is None
    assert r.skipped_block_ids == []
    assert r.messages == []


def test_knowledge_diff_holds_blocks() -> None:
    blocks = [
        DiffBlock(id=1, target_file="x.md", action="append", reason="r", body="+ a"),
        DiffBlock(id=2, target_file="y.md", action="append", reason="r", body="+ b"),
    ]
    diff = KnowledgeDiff(
        blocks=blocks,
        generated_at=datetime.now(timezone.utc),
        meeting_id="2026-04-24-test",
    )
    assert len(diff.blocks) == 2
    assert diff.blocks[0].id == 1
