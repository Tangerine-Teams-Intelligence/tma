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
from tmi.extractor import (
    ExtractedEntities,
    GlossaryTerm,
    PersonMention,
    ProjectMention,
    ThreadMention,
)
from tmi.memory import (
    decision_file_path,
    extract_decisions_from_summary,
    glossary_file_path,
    meeting_file_path,
    meeting_filename,
    people_file_path,
    projects_file_path,
    render_decision_file,
    render_meeting_file,
    slugify_for_memory,
    threads_file_path,
    write_decisions,
    write_extracted_entities,
    write_glossary,
    write_meeting_file,
    write_people,
    write_projects,
    write_threads,
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


# ----------------------------------------------------------------------
# v1.6 entity writers — people / projects / threads / glossary


def _other_meeting() -> Meeting:
    return Meeting(
        id="2026-04-26-followup",
        title="Followup sync",
        created_at=datetime(2026, 4, 26, 10, 0, tzinfo=SHA),
        participants=[
            Participant(alias="daizhe", display_name="Daizhe Zou"),
            Participant(alias="david", display_name="David Liu"),
        ],
        target_adapter="default",
    )


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


# ----- people -----


def test_write_people_creates_file_with_frontmatter(tmp_path: Path) -> None:
    m = _meeting()
    written = write_people(
        tmp_path,
        [PersonMention(alias="david", context="Pushed for Postgres", transcript_lines=(7,))],
        m,
    )
    assert len(written) == 1
    p = people_file_path(tmp_path, "david")
    assert p.exists()
    txt = _read(p)
    # Frontmatter
    end = txt.find("\n---\n", 4)
    fm = yaml.safe_load(txt[4:end])
    assert fm["alias"] == "david"
    assert fm["last_seen"] == "2026-04-25"
    assert fm["mention_count"] == 1
    assert fm["sources"] == ["meeting"]
    # Body has h1 + Mentions
    assert "# david" in txt
    assert "## Mentions" in txt
    assert "<!-- mention:2026-04-25-david-roadmap-sync -->" in txt
    assert "Pushed for Postgres" in txt
    assert "../meetings/2026-04-25-david-roadmap-sync.md#L7" in txt


def test_write_people_appends_new_meeting_mention(tmp_path: Path) -> None:
    m1 = _meeting()
    m2 = _other_meeting()
    write_people(tmp_path, [PersonMention(alias="david", context="first")], m1)
    write_people(tmp_path, [PersonMention(alias="david", context="second")], m2)
    txt = _read(people_file_path(tmp_path, "david"))
    assert "<!-- mention:2026-04-25-david-roadmap-sync -->" in txt
    assert "<!-- mention:2026-04-26-followup -->" in txt
    end = txt.find("\n---\n", 4)
    fm = yaml.safe_load(txt[4:end])
    assert fm["mention_count"] == 2
    # last_seen = max date across mentions (2026-04-26 > 2026-04-25)
    assert fm["last_seen"] == "2026-04-26"


def test_write_people_idempotent_for_same_meeting(tmp_path: Path) -> None:
    """Re-running the SAME meeting must not duplicate the mention block, and
    must produce a byte-identical file on the second run.
    """
    m = _meeting()
    mention = PersonMention(alias="david", context="Pushed for Postgres", transcript_lines=(7,))
    write_people(tmp_path, [mention], m)
    first = _read(people_file_path(tmp_path, "david"))
    written2 = write_people(tmp_path, [mention], m)
    assert written2 == []  # no-op when content unchanged
    second = _read(people_file_path(tmp_path, "david"))
    assert first == second
    # Run a third time to be paranoid
    write_people(tmp_path, [mention], m)
    third = _read(people_file_path(tmp_path, "david"))
    assert second == third
    # mention_count never grew beyond 1
    end = third.find("\n---\n", 4)
    fm = yaml.safe_load(third[4:end])
    assert fm["mention_count"] == 1
    # Only one sentinel for that meeting
    assert third.count("<!-- mention:2026-04-25-david-roadmap-sync -->") == 1


def test_write_people_replaces_mention_when_context_changes(tmp_path: Path) -> None:
    """Re-running same meeting with a new context replaces the block in place,
    rather than appending a duplicate.
    """
    m = _meeting()
    write_people(tmp_path, [PersonMention(alias="david", context="old context")], m)
    write_people(tmp_path, [PersonMention(alias="david", context="new context")], m)
    txt = _read(people_file_path(tmp_path, "david"))
    assert "new context" in txt
    assert "old context" not in txt
    assert txt.count("<!-- mention:2026-04-25-david-roadmap-sync -->") == 1


# ----- projects -----


def test_write_projects_creates_file_with_name_in_h1(tmp_path: Path) -> None:
    m = _meeting()
    write_projects(
        tmp_path,
        [ProjectMention(slug="tmi-v16", name="TMI v1.6", context="Memory layer")],
        m,
    )
    p = projects_file_path(tmp_path, "tmi-v16")
    assert p.exists()
    txt = _read(p)
    assert "# TMI v1.6" in txt
    end = txt.find("\n---\n", 4)
    fm = yaml.safe_load(txt[4:end])
    assert fm["slug"] == "tmi-v16"
    assert fm["name"] == "TMI v1.6"


def test_write_projects_idempotent(tmp_path: Path) -> None:
    m = _meeting()
    pm = ProjectMention(slug="x", name="X", context="ctx")
    write_projects(tmp_path, [pm], m)
    a = _read(projects_file_path(tmp_path, "x"))
    written2 = write_projects(tmp_path, [pm], m)
    assert written2 == []
    b = _read(projects_file_path(tmp_path, "x"))
    assert a == b


# ----- threads -----


def test_write_threads_includes_open_questions(tmp_path: Path) -> None:
    m = _meeting()
    tm = ThreadMention(
        topic="seat-pricing",
        title="Seat pricing",
        summary="$20/seat 3-seat min",
        open_questions=("Who pays for the second seat?",),
        transcript_lines=(12,),
    )
    write_threads(tmp_path, [tm], m)
    txt = _read(threads_file_path(tmp_path, "seat-pricing"))
    assert "# Seat pricing" in txt
    assert "$20/seat 3-seat min" in txt
    assert "Open question: Who pays for the second seat?" in txt


def test_write_threads_merges_across_meetings(tmp_path: Path) -> None:
    m1 = _meeting()
    m2 = _other_meeting()
    write_threads(
        tmp_path,
        [ThreadMention(topic="x", title="X", summary="round 1")],
        m1,
    )
    write_threads(
        tmp_path,
        [ThreadMention(topic="x", title="X", summary="round 2")],
        m2,
    )
    txt = _read(threads_file_path(tmp_path, "x"))
    assert "round 1" in txt
    assert "round 2" in txt
    end = txt.find("\n---\n", 4)
    fm = yaml.safe_load(txt[4:end])
    assert fm["mention_count"] == 2


def test_write_threads_idempotent(tmp_path: Path) -> None:
    m = _meeting()
    tm = ThreadMention(topic="x", title="X", summary="s", open_questions=("q",))
    write_threads(tmp_path, [tm], m)
    a = _read(threads_file_path(tmp_path, "x"))
    write_threads(tmp_path, [tm], m)
    b = _read(threads_file_path(tmp_path, "x"))
    assert a == b


# ----- glossary -----


def test_write_glossary_locks_first_seen_definition(tmp_path: Path) -> None:
    m1 = _meeting()
    m2 = _other_meeting()
    write_glossary(
        tmp_path, [GlossaryTerm(term="tmi", definition="first definition")], m1
    )
    write_glossary(
        tmp_path,
        [GlossaryTerm(term="tmi", definition="LATER definition (should NOT replace)")],
        m2,
    )
    txt = _read(glossary_file_path(tmp_path, "tmi"))
    # Preamble (above ## Mentions) should keep the first-seen definition
    assert "**Definition**: first definition" in txt
    assert "**Definition**: LATER" not in txt
    # Both meeting refs are listed
    assert "<!-- mention:2026-04-25-david-roadmap-sync -->" in txt
    assert "<!-- mention:2026-04-26-followup -->" in txt
    end = txt.find("\n---\n", 4)
    fm = yaml.safe_load(txt[4:end])
    # first_seen set on creation, last_seen updates with each mention
    assert fm["first_seen"] == "2026-04-25"
    assert fm["last_seen"] == "2026-04-26"
    assert fm["mention_count"] == 2


def test_write_glossary_idempotent(tmp_path: Path) -> None:
    m = _meeting()
    gt = GlossaryTerm(term="abc", definition="def", transcript_lines=(1,))
    write_glossary(tmp_path, [gt], m)
    a = _read(glossary_file_path(tmp_path, "abc"))
    write_glossary(tmp_path, [gt], m)
    b = _read(glossary_file_path(tmp_path, "abc"))
    assert a == b


# ----- write_extracted_entities (the "do all four" wrapper) -----


def test_write_extracted_entities_writes_all_four(tmp_path: Path) -> None:
    m = _meeting()
    e = ExtractedEntities(
        people=[PersonMention("david", "ctx")],
        projects=[ProjectMention("p1", "P1", "ctx")],
        threads=[ThreadMention("t1", "T1", "sum")],
        glossary=[GlossaryTerm("g1", "def")],
    )
    out = write_extracted_entities(tmp_path, e, m)
    assert len(out["people"]) == 1
    assert len(out["projects"]) == 1
    assert len(out["threads"]) == 1
    assert len(out["glossary"]) == 1
    # All four files exist
    assert people_file_path(tmp_path, "david").exists()
    assert projects_file_path(tmp_path, "p1").exists()
    assert threads_file_path(tmp_path, "t1").exists()
    assert glossary_file_path(tmp_path, "g1").exists()


def test_write_extracted_entities_full_idempotency(tmp_path: Path) -> None:
    """End-to-end: running the full extraction-write twice produces an
    identical filesystem state for every entity file. No duplicates anywhere.
    """
    m = _meeting()
    e = ExtractedEntities(
        people=[
            PersonMention("david", "Pushed for Postgres", (7,)),
            PersonMention("daizhe", "CEO", (1,)),
        ],
        projects=[ProjectMention("tmi-v16", "TMI v1.6", "Memory layer", (10,))],
        threads=[
            ThreadMention(
                "seat-pricing",
                "Seat pricing",
                "$20/seat 3-seat min",
                ("Who pays?",),
                (12,),
            )
        ],
        glossary=[GlossaryTerm("tmi", "Tangerine Meeting Intelligence", (1,))],
    )
    write_extracted_entities(tmp_path, e, m)

    def snapshot(root: Path) -> dict[str, str]:
        snap: dict[str, str] = {}
        for sub in ("people", "projects", "threads", "glossary"):
            d = root / sub
            if not d.exists():
                continue
            for f in sorted(d.iterdir()):
                if f.is_file():
                    snap[f"{sub}/{f.name}"] = f.read_text(encoding="utf-8")
        return snap

    before = snapshot(tmp_path)
    # Re-run identically
    out = write_extracted_entities(tmp_path, e, m)
    # Every bucket should report 0 changes
    for bucket, paths in out.items():
        assert paths == [], f"bucket {bucket} had unexpected writes: {paths}"
    after = snapshot(tmp_path)
    assert before == after
    # Run a 3rd time too
    write_extracted_entities(tmp_path, e, m)
    again = snapshot(tmp_path)
    assert before == again
    # Sanity: each file exists exactly once and has mention_count=1
    for relpath, content in before.items():
        end = content.find("\n---\n", 4)
        fm = yaml.safe_load(content[4:end])
        assert fm["mention_count"] == 1, f"{relpath}: mention_count drifted"
