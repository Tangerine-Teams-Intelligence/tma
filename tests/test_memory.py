"""Tests for tmi.memory — memory layer writers (meetings/ + decisions/)."""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from pathlib import Path

import yaml

from tmi.config import (
    AdapterFiles,
    Config,
    LoggingConfig,
    OutputAdapter,
    TeamMember,
)
from tmi.meeting import Meeting, Participant
from tmi.memory import (
    decision_file_path,
    extract_decisions_from_summary,
    meeting_file_path,
    meeting_filename,
    render_decision_file,
    render_meeting_file,
    slugify_for_memory,
    write_decisions,
    write_meeting_file,
)


SHA = timezone(timedelta(hours=8))


def _meeting(title: str = "David roadmap sync") -> Meeting:
    return Meeting(
        id="2026-04-25-david-roadmap-sync",
        title=title,
        created_at=datetime(2026, 4, 25, 19, 0, tzinfo=SHA),
        participants=[
            Participant(alias="daizhe", display_name="Daizhe Zou"),
            Participant(alias="david", display_name="David Liu"),
        ],
        target_adapter="default",
    )


# ----------------------------------------------------------------------
# Slug + filename


def test_slugify_basic() -> None:
    assert slugify_for_memory("David roadmap sync") == "david-roadmap-sync"
    assert slugify_for_memory("v1.5 Launch!") == "v1-5-launch"
    assert slugify_for_memory("   ") == "untitled"
    # Non-ASCII collapses to hyphens
    assert "david" in slugify_for_memory("David — sync")


def test_meeting_filename_uses_created_at_date() -> None:
    m = _meeting()
    assert meeting_filename(m) == "2026-04-25-david-roadmap-sync.md"


def test_meeting_file_path_is_under_meetings_subdir(tmp_path: Path) -> None:
    m = _meeting()
    p = meeting_file_path(tmp_path, m)
    assert p.parent == tmp_path / "meetings"
    assert p.name == "2026-04-25-david-roadmap-sync.md"


def test_decision_file_path_under_decisions_subdir(tmp_path: Path) -> None:
    p = decision_file_path(tmp_path, "Postgres over Mongo")
    assert p.parent == tmp_path / "decisions"
    assert p.name == "postgres-over-mongo.md"


# ----------------------------------------------------------------------
# Meeting file rendering


def test_render_meeting_file_has_frontmatter_and_transcript() -> None:
    m = _meeting()
    transcript = (
        "[19:00:00] daizhe: hello\n"
        "[19:00:30] david: hi\n"
        "[19:47:12] daizhe: bye\n"
    )
    out = render_meeting_file(m, transcript)
    # YAML frontmatter
    assert out.startswith("---\n")
    end = out.find("\n---\n", 4)
    fm = yaml.safe_load(out[4:end])
    assert fm["title"] == "David roadmap sync"
    assert fm["date"] == "2026-04-25"
    assert fm["source"] == "discord"
    assert fm["participants"] == ["daizhe", "david"]
    assert fm["duration_min"] == 47  # 19:00:00 -> 19:47:12 ≈ 47 min
    # Body
    assert "## Transcript" in out
    assert "[19:00:00] daizhe: hello" in out


def test_render_meeting_file_with_summary_and_decisions() -> None:
    m = _meeting()
    out = render_meeting_file(
        m,
        transcript="[19:00:00] daizhe: ok\n",
        summary_body="Test summary body.",
        decision_links=[("Use Postgres", "use-postgres-over-mongo")],
    )
    assert "## Summary" in out
    assert "Test summary body." in out
    assert "## Decisions" in out
    assert "(../decisions/use-postgres-over-mongo.md)" in out


def test_write_meeting_file_actually_writes(tmp_path: Path) -> None:
    m = _meeting()
    p = write_meeting_file(tmp_path, m, "[19:00:00] daizhe: ok\n")
    assert p.exists()
    content = p.read_text(encoding="utf-8")
    assert "David roadmap sync" in content


# ----------------------------------------------------------------------
# Decision extraction


_SUMMARY_WITH_DECISIONS = """---
schema_version: 1
generated_at: 2026-04-25T20:00:00+08:00
meeting_id: 2026-04-25-david-roadmap-sync
participants: [daizhe, david]
duration_minutes: 47
---

# David roadmap sync

## Topics covered

### Topic 1: Database choice
- **Outcome**: decided — Postgres for v1
- **Decided by**: daizhe; david agreed at L52
- **Stance changes**: david shifted from Mongo to Postgres
- **Transcript refs**: L40, L52

### Topic 2: Logging stack
- **Outcome**: agreed — keep current stack
- **Decided by**: consensus
- **Stance changes**: none
- **Transcript refs**: L88

### Topic 3: Open question
- **Outcome**: discussed but not resolved
- **Decided by**: nobody
- **Stance changes**: none
- **Transcript refs**: L100

## Topics raised but not resolved
- Pricing (L150)

## Action items
- [ ] @daizhe — ship migration script

## New facts surfaced
- Postgres CN-region latency: ~5ms
"""


def test_extract_decisions_finds_decided_and_agreed_topics() -> None:
    decisions = extract_decisions_from_summary(_SUMMARY_WITH_DECISIONS)
    titles = [d["title"] for d in decisions]
    assert "Database choice" in titles
    assert "Logging stack" in titles
    # Topic 3 should be excluded — outcome doesn't start with decided/agreed
    assert "Open question" not in titles
    assert len(decisions) == 2


def test_extract_decisions_pulls_metadata() -> None:
    decisions = extract_decisions_from_summary(_SUMMARY_WITH_DECISIONS)
    db = next(d for d in decisions if d["title"] == "Database choice")
    assert db["outcome"].startswith("decided")
    assert "daizhe" in db["decided_by"]
    assert "L40" in db["transcript_refs"]
    assert "L52" in db["transcript_refs"]


def test_extract_decisions_handles_empty_input() -> None:
    assert extract_decisions_from_summary("") == []
    assert extract_decisions_from_summary("# Random\n\nNo topics.\n") == []


# ----------------------------------------------------------------------
# Decision file render


def test_render_decision_file_includes_provenance() -> None:
    m = _meeting()
    decisions = extract_decisions_from_summary(_SUMMARY_WITH_DECISIONS)
    db = next(d for d in decisions if d["title"] == "Database choice")
    out = render_decision_file(db, meeting=m, meeting_filename_value=meeting_filename(m))
    # Frontmatter
    end = out.find("\n---\n", 4)
    fm = yaml.safe_load(out[4:end])
    assert fm["title"] == "Database choice"
    assert fm["source"] == "meeting"
    assert fm["source_id"] == m.id
    assert fm["source_line"] == 40
    assert fm["status"] == "decided"
    # Body sections
    assert "## Decision" in out
    assert "## Context" in out
    assert "## Provenance" in out
    # Provenance link uses relative path
    assert "(../meetings/2026-04-25-david-roadmap-sync.md#L40)" in out


def test_write_decisions_writes_one_file_per_decision(tmp_path: Path) -> None:
    m = _meeting()
    written = write_decisions(tmp_path, m, _SUMMARY_WITH_DECISIONS)
    assert len(written) == 2
    slugs = {slug for slug, _ in written}
    assert "database-choice" in slugs
    assert "logging-stack" in slugs
    for _, p in written:
        assert p.exists()
        assert p.parent == tmp_path / "decisions"


def test_write_decisions_returns_empty_when_no_decisions(tmp_path: Path) -> None:
    assert write_decisions(tmp_path, _meeting(), "") == []


# ----------------------------------------------------------------------
# Config.memory_root_path()


def _git_init(p: Path) -> None:
    import subprocess

    subprocess.run(["git", "init"], cwd=str(p), check=True, capture_output=True)


def test_memory_root_uses_target_repo_when_single_adapter(tmp_path: Path) -> None:
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
    assert cfg.memory_root_path() == target / "memory"
    assert cfg.memory_root_path("default") == target / "memory"


def test_memory_root_falls_back_to_home_when_no_adapters(tmp_path: Path) -> None:
    repo = tmp_path / "m"
    repo.mkdir()
    cfg = Config(
        meetings_repo=str(repo),
        output_adapters=[],
        team=[TeamMember(alias="x", display_name="X")],
        logging=LoggingConfig(file=str(tmp_path / "tmi.log")),
    )
    root = cfg.memory_root_path()
    assert root.name == ".tangerine-memory"
    assert root.parent == Path.home()
