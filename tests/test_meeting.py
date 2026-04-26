"""Tests for tmi.meeting."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from tmi.config import (
    AdapterFiles,
    Config,
    LoggingConfig,
    OutputAdapter,
    TeamMember,
)
from tmi.meeting import (
    ID_RE,
    create_meeting,
    list_meetings,
    load_meeting,
    make_id,
)


def _git_init(p: Path) -> None:
    subprocess.run(["git", "init"], cwd=str(p), check=True, capture_output=True)


@pytest.fixture
def cfg(tmp_path: Path) -> Config:
    repo = tmp_path / "m"
    repo.mkdir()
    _git_init(repo)
    target = tmp_path / "t"
    target.mkdir()
    _git_init(target)
    return Config(
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


def test_make_id_format() -> None:
    mid = make_id("David sync — meeting product direction")
    assert ID_RE.match(mid)
    assert "david-sync" in mid


def test_create_meeting_writes_full_dir(cfg: Config) -> None:
    mdir = create_meeting(cfg, "Test Sync")
    assert (mdir / "meeting.yaml").exists()
    assert (mdir / "transcript.md").exists()
    assert (mdir / "observations.md").exists()
    assert (mdir / "intents").is_dir()
    assert (mdir / ".tmi").is_dir()
    assert (mdir / "status.yaml").exists()

    m = load_meeting(mdir)
    assert m.title == "Test Sync"
    assert {p.alias for p in m.participants} == {"daizhe", "hongyu"}
    assert m.target_adapter == "default"


def test_create_meeting_id_collision_exits(cfg: Config) -> None:
    create_meeting(cfg, "Same Title")
    with pytest.raises(SystemExit) as exc:
        create_meeting(cfg, "Same Title")
    assert exc.value.code == 1


def test_create_meeting_with_suffix(cfg: Config) -> None:
    a = create_meeting(cfg, "Same Title")
    b = create_meeting(cfg, "Same Title", suffix="b")
    assert a.name != b.name
    assert b.name.endswith("-b")


def test_list_meetings_sorted_desc(cfg: Config) -> None:
    create_meeting(cfg, "alpha")
    create_meeting(cfg, "beta")
    rows = list_meetings(cfg)
    assert len(rows) == 2
    # Same date prefix; alphabetic suffix gives deterministic ordering
    ids = [r[0] for r in rows]
    assert ids == sorted(ids, reverse=True)


def test_create_meeting_unknown_adapter_exits(tmp_path: Path) -> None:
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
        team=[TeamMember(alias="x", display_name="X")],
        logging=LoggingConfig(file=str(tmp_path / "tmi.log")),
    )
    with pytest.raises(SystemExit):
        create_meeting(cfg, "title", target="nonexistent")
