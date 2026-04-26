"""Integration-ish tests for ClaudeCodeAdapter against a real (temp) git repo."""
from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path

import pytest
from git import Actor, Repo

from tmi.adapters import ClaudeCodeAdapter
from tmi.adapters.diff_parser import parse_diff
from tmi.adapters.types import DiffBlock, KnowledgeDiff

FIXTURE_REPO = Path(__file__).parent / "fixtures" / "sample_target_repo"
FIXTURE_DIFF = Path(__file__).parent / "fixtures" / "sample_diff.md"

_FILE_MAPPINGS = {
    "claude_md": "CLAUDE.md",
    "knowledge_dir": "knowledge/",
    "session_state": "knowledge/session-state.md",
}


def _fresh_target_repo(tmp_path: Path) -> Path:
    """Copy fixture to tmp_path, init git, commit baseline."""
    dst = tmp_path / "target"
    shutil.copytree(FIXTURE_REPO, dst)
    repo = Repo.init(dst)
    repo.index.add(["CLAUDE.md", "knowledge/session-state.md", "knowledge/index.md"])
    repo.index.commit(
        "baseline",
        author=Actor("Test", "test@example.com"),
        committer=Actor("Test", "test@example.com"),
    )
    return dst


def _make_adapter(target: Path) -> ClaudeCodeAdapter:
    return ClaudeCodeAdapter(
        target_repo=target,
        file_mappings=_FILE_MAPPINGS,
        commit_author="TMA Test <tma-test@example.com>",
    )


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------
def test_init_requires_known_file_mappings(tmp_path: Path) -> None:
    target = _fresh_target_repo(tmp_path)
    with pytest.raises(ValueError):
        ClaudeCodeAdapter(target_repo=target, file_mappings={}, commit_author="X")


# ---------------------------------------------------------------------------
# Ground truth
# ---------------------------------------------------------------------------
def test_read_ground_truth_loads_files(tmp_path: Path) -> None:
    target = _fresh_target_repo(tmp_path)
    a = _make_adapter(target)
    gt = a.read_ground_truth()
    assert "Sample target repo" in gt.claude_md
    assert "Recent meetings" in gt.session_state
    # session-state should NOT appear in knowledge_files (deduped)
    paths = [kf.path for kf in gt.knowledge_files]
    assert "knowledge/index.md" in paths
    assert "knowledge/session-state.md" not in paths


def test_read_ground_truth_handles_missing_files(tmp_path: Path) -> None:
    # Empty target with just .git
    target = tmp_path / "empty"
    target.mkdir()
    Repo.init(target)
    a = ClaudeCodeAdapter(
        target_repo=target,
        file_mappings=_FILE_MAPPINGS,
        commit_author="X <y@z>",
    )
    gt = a.read_ground_truth()
    assert gt.claude_md == ""
    assert gt.session_state == ""
    assert gt.knowledge_files == []


# ---------------------------------------------------------------------------
# generate_diff is reserved
# ---------------------------------------------------------------------------
def test_generate_diff_raises_not_implemented(tmp_path: Path) -> None:
    target = _fresh_target_repo(tmp_path)
    a = _make_adapter(target)
    from tmi.adapters.types import Summary, Transcript

    with pytest.raises(NotImplementedError):
        a.generate_diff(
            summary=Summary(markdown="", meeting_id="x", participants=[]),
            intents=[],
            transcript=Transcript(text="", line_count=0),
        )


# ---------------------------------------------------------------------------
# apply_diff happy path
# ---------------------------------------------------------------------------
def test_apply_diff_writes_files_and_commits(tmp_path: Path) -> None:
    target = _fresh_target_repo(tmp_path)
    a = _make_adapter(target)
    diff = parse_diff(FIXTURE_DIFF.read_text(encoding="utf-8"))

    result = a.apply_diff(diff, approved_block_ids=[1, 2, 3])

    assert result.commit_sha is not None
    assert set(result.written_files) == {
        "knowledge/session-state.md",
        "CLAUDE.md",
        "knowledge/whisper-latency.md",
    }
    assert result.skipped_block_ids == []

    # Verify the commit landed.
    repo = Repo(target)
    head = repo.head.commit
    assert head.hexsha == result.commit_sha
    assert head.author.email == "tma-test@example.com"

    # Spot-check content.
    sess = (target / "knowledge/session-state.md").read_text(encoding="utf-8")
    assert "v1 scope locked" in sess
    claude = (target / "CLAUDE.md").read_text(encoding="utf-8")
    assert "Meeting discipline" in claude
    new_file = (target / "knowledge/whisper-latency.md").read_text(encoding="utf-8")
    assert new_file.startswith("# Whisper API latency")


def test_apply_diff_no_op_returns_empty(tmp_path: Path) -> None:
    target = _fresh_target_repo(tmp_path)
    a = _make_adapter(target)
    diff = parse_diff(FIXTURE_DIFF.read_text(encoding="utf-8"))
    result = a.apply_diff(diff, approved_block_ids=[])
    assert result.written_files == []
    assert result.commit_sha is None
    assert result.skipped_block_ids == []


def test_apply_diff_no_commit_flag(tmp_path: Path) -> None:
    target = _fresh_target_repo(tmp_path)
    a = _make_adapter(target)
    diff = parse_diff(FIXTURE_DIFF.read_text(encoding="utf-8"))

    pre = Repo(target).head.commit.hexsha
    result = a.apply_diff(diff, approved_block_ids=[1], commit=False)
    assert result.commit_sha is None
    assert result.written_files == ["knowledge/session-state.md"]
    # HEAD didn't move.
    post = Repo(target).head.commit.hexsha
    assert pre == post


# ---------------------------------------------------------------------------
# Dirty repo guard
# ---------------------------------------------------------------------------
def test_apply_refuses_dirty_target(tmp_path: Path) -> None:
    target = _fresh_target_repo(tmp_path)
    # Introduce uncommitted change to a file that block 1 targets.
    (target / "knowledge/session-state.md").write_text(
        "dirty content\n", encoding="utf-8"
    )

    a = _make_adapter(target)
    diff = parse_diff(FIXTURE_DIFF.read_text(encoding="utf-8"))
    result = a.apply_diff(diff, approved_block_ids=[1, 2])

    assert result.commit_sha is None
    assert set(result.skipped_block_ids) == {1, 2}
    assert any("uncommitted" in m for m in result.messages)
    # File on disk is the dirty version, untouched by adapter.
    assert (target / "knowledge/session-state.md").read_text(encoding="utf-8") == "dirty content\n"


def test_apply_ignores_unrelated_dirty_files(tmp_path: Path) -> None:
    target = _fresh_target_repo(tmp_path)
    # Dirty an unrelated file.
    (target / "knowledge/index.md").write_text("dirty\n", encoding="utf-8")
    a = _make_adapter(target)
    diff = parse_diff(FIXTURE_DIFF.read_text(encoding="utf-8"))
    # Block 1 targets session-state.md, which is clean.
    result = a.apply_diff(diff, approved_block_ids=[1])
    assert result.commit_sha is not None
    assert result.written_files == ["knowledge/session-state.md"]


# ---------------------------------------------------------------------------
# Edited blocks
# ---------------------------------------------------------------------------
def test_apply_uses_edited_block_when_provided(tmp_path: Path) -> None:
    target = _fresh_target_repo(tmp_path)
    a = _make_adapter(target)
    diff = parse_diff(FIXTURE_DIFF.read_text(encoding="utf-8"))

    edited = DiffBlock(
        id=1,
        target_file="knowledge/session-state.md",
        action="append",
        reason="edited reason",
        transcript_refs=["L99"],
        body="+ EDITED ENTRY",
    )
    a.apply_diff(diff, approved_block_ids=[1], edited_blocks={1: edited})
    sess = (target / "knowledge/session-state.md").read_text(encoding="utf-8")
    assert "EDITED ENTRY" in sess
    assert "v1 scope locked" not in sess


# ---------------------------------------------------------------------------
# Replace + create error paths
# ---------------------------------------------------------------------------
def test_apply_replace_block(tmp_path: Path) -> None:
    target = _fresh_target_repo(tmp_path)
    a = _make_adapter(target)

    block = DiffBlock(
        id=1,
        target_file="CLAUDE.md",
        action="replace",
        reason="rewrite",
        transcript_refs=["L1"],
        body="- - Python 3.11+\n+ - Python 3.12+",
    )
    diff = KnowledgeDiff(
        blocks=[block],
        generated_at=datetime.now(timezone.utc),
        meeting_id="t",
    )
    result = a.apply_diff(diff, approved_block_ids=[1])
    assert result.commit_sha is not None
    claude = (target / "CLAUDE.md").read_text(encoding="utf-8")
    assert "Python 3.12+" in claude
    assert "Python 3.11+" not in claude


def test_apply_create_skips_existing(tmp_path: Path) -> None:
    target = _fresh_target_repo(tmp_path)
    a = _make_adapter(target)

    block = DiffBlock(
        id=1,
        target_file="CLAUDE.md",  # already exists
        action="create",
        reason="x",
        body="# new",
    )
    diff = KnowledgeDiff(
        blocks=[block],
        generated_at=datetime.now(timezone.utc),
        meeting_id="t",
    )
    result = a.apply_diff(diff, approved_block_ids=[1])
    assert result.skipped_block_ids == [1]
    assert result.written_files == []


def test_apply_insert_anchor_missing(tmp_path: Path) -> None:
    target = _fresh_target_repo(tmp_path)
    a = _make_adapter(target)

    block = DiffBlock(
        id=1,
        target_file="CLAUDE.md",
        action="insert",
        insert_anchor="## Nonexistent heading",
        reason="x",
        body="+ won't land",
    )
    diff = KnowledgeDiff(
        blocks=[block],
        generated_at=datetime.now(timezone.utc),
        meeting_id="t",
    )
    result = a.apply_diff(diff, approved_block_ids=[1])
    assert result.skipped_block_ids == [1]
    assert any("anchor not found" in m for m in result.messages)


def test_apply_rejects_path_escape(tmp_path: Path) -> None:
    target = _fresh_target_repo(tmp_path)
    a = _make_adapter(target)

    # Construct DiffBlock via model_construct to bypass validator, simulating
    # a malicious or buggy upstream that might surface this case at apply time.
    block = DiffBlock.model_construct(
        id=1,
        target_file="../../escape.md",
        action="append",
        reason="x",
        transcript_refs=[],
        body="+ y",
    )
    diff = KnowledgeDiff(
        blocks=[block],
        generated_at=datetime.now(timezone.utc),
        meeting_id="t",
    )
    with pytest.raises(ValueError):
        a.apply_diff(diff, approved_block_ids=[1])
