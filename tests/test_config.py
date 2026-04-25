"""Tests for tmi.config."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
import yaml

from tmi.config import (
    AdapterFiles,
    Config,
    OutputAdapter,
    TeamMember,
    load_config,
    render_default_template,
    save_config,
)


def _git_init(p: Path) -> None:
    subprocess.run(["git", "init"], cwd=str(p), check=True, capture_output=True)


def test_load_save_roundtrip(tmp_path: Path) -> None:
    repo = tmp_path / "m"
    repo.mkdir()
    _git_init(repo)
    target = tmp_path / "t"
    target.mkdir()
    _git_init(target)

    cfg = Config(
        meetings_repo=str(repo),
        output_adapters=[
            OutputAdapter(name="x", target_repo=str(target), files=AdapterFiles())
        ],
        team=[TeamMember(alias="daizhe", display_name="Daizhe")],
    )
    p = tmp_path / "config.yaml"
    save_config(cfg, p)
    loaded = load_config(p)
    assert loaded.meetings_repo == str(repo)
    assert loaded.team[0].alias == "daizhe"


def test_alias_validation() -> None:
    with pytest.raises(ValueError):
        TeamMember(alias="Bad-Name", display_name="x")


def test_duplicate_team_alias_rejected(tmp_path: Path) -> None:
    repo = tmp_path / "m"
    repo.mkdir()
    with pytest.raises(ValueError):
        Config(
            meetings_repo=str(repo),
            team=[
                TeamMember(alias="a", display_name="A"),
                TeamMember(alias="a", display_name="A2"),
            ],
        )


def test_knowledge_dir_must_have_trailing_slash() -> None:
    with pytest.raises(ValueError):
        AdapterFiles(knowledge_dir="knowledge")


def test_auto_push_must_be_false() -> None:
    with pytest.raises(ValueError):
        OutputAdapter(name="x", target_repo="/tmp", auto_push=True)


def test_render_default_template_valid_yaml(tmp_path: Path) -> None:
    text = render_default_template(tmp_path / "m", tmp_path / "t")
    parsed = yaml.safe_load(text)
    assert parsed["schema_version"] == 1
    assert parsed["meetings_repo"]
    assert parsed["whisper"]["provider"] == "openai"


def test_schema_version_too_new_rejected(tmp_path: Path) -> None:
    repo = tmp_path / "m"
    repo.mkdir()
    with pytest.raises(ValueError):
        Config(meetings_repo=str(repo), schema_version=99)
