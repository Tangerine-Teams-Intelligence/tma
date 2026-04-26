"""Tests for `tmi review --json` and `--apply-decisions`.

Covers the desktop-app contract added in v1.5: machine-readable diff output and
batch decision persistence (no TUI in the loop).
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from typer.testing import CliRunner

from tmi.adapters.diff_parser import parse_diff
from tmi.cli import app
from tmi.config import (
    AdapterFiles,
    Config,
    LoggingConfig,
    OutputAdapter,
    TeamMember,
    save_config,
)
from tmi.meeting import create_meeting
from tmi.review import apply_decisions_dict
from tmi.state import load_status, save_status, transition

FIXTURE_DIFF = (
    Path(__file__).parent / "fixtures" / "sample_diff.md"
).read_text(encoding="utf-8")


def _git_init(p: Path) -> None:
    subprocess.run(["git", "init"], cwd=str(p), check=True, capture_output=True)


@pytest.fixture
def cfg_path(tmp_path: Path) -> Path:
    repo = tmp_path / "m"
    repo.mkdir()
    _git_init(repo)
    target = tmp_path / "t"
    target.mkdir()
    _git_init(target)
    cfg = Config(
        meetings_repo=str(repo),
        output_adapters=[
            OutputAdapter(name="default", target_repo=str(target), files=AdapterFiles())
        ],
        team=[
            TeamMember(alias="daizhe", display_name="Daizhe"),
            TeamMember(alias="hongyu", display_name="Hongyu"),
        ],
        logging=LoggingConfig(file=str(tmp_path / "tmi.log")),
    )
    p = tmp_path / "config.yaml"
    save_config(cfg, p)
    return p


@pytest.fixture
def wrapped_meeting(cfg_path: Path) -> tuple[Path, str]:
    """Create a meeting whose state is `wrapped` with the fixture diff in place."""
    from tmi.config import load_config

    cfg = load_config(cfg_path)
    mdir = create_meeting(cfg, "Test review json")
    # Drop the fixture diff in
    (mdir / "knowledge-diff.md").write_text(FIXTURE_DIFF, encoding="utf-8")
    # Force state to wrapped
    s = load_status(mdir)
    transition(s, "prepped")
    transition(s, "live")
    transition(s, "ended")
    transition(s, "wrapped")
    save_status(mdir, s)
    return mdir, mdir.name


def test_apply_decisions_dict_persists_to_status(wrapped_meeting: tuple[Path, str]) -> None:
    mdir, _mid = wrapped_meeting
    diff = parse_diff(FIXTURE_DIFF)
    decisions = {
        "approved": [1, 3],
        "rejected": [2],
        "edited": {},
    }
    out = apply_decisions_dict(mdir, diff.blocks, decisions)
    assert out.approved == [1, 3]
    assert out.rejected == [2]

    s = load_status(mdir)
    assert s.review.approved_block_ids == [1, 3]
    assert s.review.rejected_block_ids == [2]


def test_apply_decisions_dict_edit_implies_approve(
    wrapped_meeting: tuple[Path, str],
) -> None:
    mdir, _ = wrapped_meeting
    diff = parse_diff(FIXTURE_DIFF)
    decisions = {"approved": [], "rejected": [2], "edited": {3: "+ edited"}}
    out = apply_decisions_dict(mdir, diff.blocks, decisions)
    assert 3 in out.approved
    assert out.edited == {3: "+ edited"}

    s = load_status(mdir)
    assert 3 in s.review.approved_block_ids
    assert 3 in s.review.edited_block_ids


def test_apply_decisions_dict_rejects_unknown_block(
    wrapped_meeting: tuple[Path, str],
) -> None:
    mdir, _ = wrapped_meeting
    diff = parse_diff(FIXTURE_DIFF)
    with pytest.raises(ValueError, match="unknown block"):
        apply_decisions_dict(mdir, diff.blocks, {"approved": [99]})


def test_apply_decisions_dict_overlap_conflict(
    wrapped_meeting: tuple[Path, str],
) -> None:
    mdir, _ = wrapped_meeting
    diff = parse_diff(FIXTURE_DIFF)
    with pytest.raises(ValueError, match="both approved and rejected"):
        apply_decisions_dict(
            mdir, diff.blocks, {"approved": [1], "rejected": [1]}
        )


def test_review_json_outputs_blocks(
    cfg_path: Path, wrapped_meeting: tuple[Path, str]
) -> None:
    runner = CliRunner()
    _, mid = wrapped_meeting
    result = runner.invoke(
        app, ["review", mid, "--json", "--config", str(cfg_path)]
    )
    assert result.exit_code == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout)
    assert payload["meeting_id"] == mid
    assert payload["state"] == "wrapped"
    assert len(payload["blocks"]) == 3
    b1 = payload["blocks"][0]
    assert b1["id"] == 1
    assert b1["target_file"] == "knowledge/session-state.md"
    assert b1["action"] == "append"
    assert b1["status"] == "pending"
    assert "L47" in b1["transcript_refs"]


def test_review_json_apply_decisions_writes_status(
    cfg_path: Path, wrapped_meeting: tuple[Path, str], tmp_path: Path
) -> None:
    runner = CliRunner()
    mdir, mid = wrapped_meeting
    decisions = {
        "approved": [1, 3],
        "rejected": [2],
        "edited": {},
    }
    decisions_path = tmp_path / "decisions.json"
    decisions_path.write_text(json.dumps(decisions), encoding="utf-8")

    result = runner.invoke(
        app,
        [
            "review",
            mid,
            "--json",
            "--apply-decisions",
            str(decisions_path),
            "--config",
            str(cfg_path),
        ],
    )
    assert result.exit_code == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout)
    # All three decided -> state should be reviewed
    assert payload["state"] == "reviewed"
    by_id = {b["id"]: b for b in payload["blocks"]}
    assert by_id[1]["status"] == "approved"
    assert by_id[2]["status"] == "rejected"
    assert by_id[3]["status"] == "approved"

    # Status file actually persisted
    s = load_status(mdir)
    assert s.state == "reviewed"
    assert s.review.approved_block_ids == [1, 3]
    assert s.review.rejected_block_ids == [2]


def test_review_json_apply_decisions_with_edit_rewrites_diff(
    cfg_path: Path, wrapped_meeting: tuple[Path, str], tmp_path: Path
) -> None:
    runner = CliRunner()
    mdir, mid = wrapped_meeting
    new_body = "+ EDITED BODY MARKER 12345"
    decisions = {
        "approved": [1, 2],
        "rejected": [],
        "edited": {"3": new_body},
    }
    decisions_path = tmp_path / "decisions.json"
    decisions_path.write_text(json.dumps(decisions), encoding="utf-8")

    result = runner.invoke(
        app,
        [
            "review",
            mid,
            "--json",
            "--apply-decisions",
            str(decisions_path),
            "--config",
            str(cfg_path),
        ],
    )
    assert result.exit_code == 0, result.stdout + result.stderr

    diff_text = (mdir / "knowledge-diff.md").read_text(encoding="utf-8")
    assert "EDITED BODY MARKER 12345" in diff_text


def test_review_interactive_unchanged_when_no_json(
    cfg_path: Path, wrapped_meeting: tuple[Path, str]
) -> None:
    """`--auto-approve-all` (sans --json) keeps prior behavior — proves the JSON
    branch does not short-circuit the interactive code path."""
    runner = CliRunner()
    _, mid = wrapped_meeting
    result = runner.invoke(
        app,
        ["review", mid, "--auto-approve-all", "--config", str(cfg_path)],
    )
    assert result.exit_code == 0, result.stdout + result.stderr
