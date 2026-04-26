"""Tests for tmi.extractor — AI auto-tag/classify pipeline.

Mocks Claude CLI by monkey-patching ``_run_claude``. No real subprocess.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tmi import extractor
from tmi.extractor import (
    ExtractedEntities,
    GlossaryTerm,
    PersonMention,
    ProjectMention,
    ThreadMention,
    build_prompt,
    extract_from_meeting,
    parse_extracted_json,
)


_CANNED_GOOD = """```json
{
  "people": [
    {"alias": "david", "context": "Pushed for Postgres", "transcript_lines": [3, 7]},
    {"alias": "Daizhe Zou", "context": "CEO", "transcript_lines": [1]}
  ],
  "projects": [
    {"slug": "tmi-v16", "name": "TMI v1.6", "context": "Memory layer expansion", "transcript_lines": [10]}
  ],
  "threads": [
    {
      "topic": "seat-pricing",
      "title": "Seat pricing",
      "summary": "$20/seat 3-seat min",
      "open_questions": ["Who pays for the second seat?"],
      "transcript_lines": [12, 14]
    }
  ],
  "glossary": [
    {"term": "tmi", "definition": "Tangerine Meeting Intelligence", "transcript_lines": [1]}
  ]
}
```
"""


_CANNED_EMPTY = """```json
{"people": [], "projects": [], "threads": [], "glossary": []}
```
"""


_CANNED_MALFORMED = "blah blah no fenced block here just prose"


# ----------------------------------------------------------------------
# Prompt building


def test_build_prompt_includes_locked_text_and_numbered_lines() -> None:
    transcript = "[19:00:00] daizhe: hi\n[19:00:30] david: hello\n"
    prompt = build_prompt(transcript)
    # Locked instructions
    assert "Output schema" in prompt
    assert "people" in prompt
    assert "glossary" in prompt
    # Numbered lines
    assert "L1: [19:00:00] daizhe: hi" in prompt
    assert "L2: [19:00:30] david: hello" in prompt


def test_build_prompt_truncates_long_transcript() -> None:
    huge = "[19:00:00] x: " + ("a" * 10) + "\n"
    transcript = huge * 50_000  # ~600KB
    prompt = build_prompt(transcript, max_chars=5000)
    assert "[... transcript truncated for length ...]" in prompt
    # The locked prompt above the transcript is NOT capped; the transcript body is.
    transcript_section = prompt.split("Transcript:\n", 1)[1]
    assert len(transcript_section) <= 5000 + len("\n[... transcript truncated for length ...]\n")


# ----------------------------------------------------------------------
# JSON parsing


def test_parse_extracted_json_happy_path() -> None:
    e = parse_extracted_json(_CANNED_GOOD)
    assert len(e.people) == 2
    assert e.people[0].alias == "david"
    assert e.people[0].transcript_lines == (3, 7)
    # Aliases get kebab-cased: "Daizhe Zou" -> "daizhe-zou"
    assert e.people[1].alias == "daizhe-zou"
    assert len(e.projects) == 1
    assert e.projects[0].slug == "tmi-v16"
    assert e.projects[0].name == "TMI v1.6"
    assert len(e.threads) == 1
    assert e.threads[0].topic == "seat-pricing"
    assert e.threads[0].open_questions == ("Who pays for the second seat?",)
    assert len(e.glossary) == 1
    assert e.glossary[0].term == "tmi"


def test_parse_extracted_json_empty_lists() -> None:
    e = parse_extracted_json(_CANNED_EMPTY)
    assert e.is_empty()
    assert e.counts() == {"people": 0, "projects": 0, "threads": 0, "glossary": 0}


def test_parse_extracted_json_malformed_returns_empty() -> None:
    e = parse_extracted_json(_CANNED_MALFORMED)
    assert e.is_empty()


def test_parse_extracted_json_handles_raw_json_no_fence() -> None:
    raw = json.dumps({"people": [{"alias": "x"}], "projects": [], "threads": [], "glossary": []})
    e = parse_extracted_json(raw)
    assert len(e.people) == 1
    assert e.people[0].alias == "x"


def test_parse_extracted_json_drops_entries_missing_required_field() -> None:
    raw = (
        "```json\n"
        '{"people": [{"context": "no alias"}, {"alias": "ok", "context": "fine"}],'
        ' "projects": [], "threads": [], "glossary": []}\n'
        "```"
    )
    e = parse_extracted_json(raw)
    assert len(e.people) == 1
    assert e.people[0].alias == "ok"


def test_parse_extracted_json_coerces_non_int_lines() -> None:
    raw = (
        "```json\n"
        '{"people": [{"alias": "a", "transcript_lines": [1, "2", "x", 3.0]}],'
        ' "projects": [], "threads": [], "glossary": []}\n'
        "```"
    )
    e = parse_extracted_json(raw)
    # int("2") = 2; "x" dropped; int(3.0) = 3
    assert e.people[0].transcript_lines == (1, 2, 3)


# ----------------------------------------------------------------------
# extract_from_meeting end-to-end (mock subprocess)


def test_extract_from_meeting_returns_parsed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(extractor, "_run_claude", lambda *a, **kw: _CANNED_GOOD)
    e = extract_from_meeting(tmp_path, "[19:00:00] x: hi\n", Path("claude"))
    assert len(e.people) == 2
    assert len(e.projects) == 1


def test_extract_from_meeting_empty_transcript_skips(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    called = {"n": 0}

    def _bad(*a, **kw):  # type: ignore[no-untyped-def]
        called["n"] += 1
        return "should not be called"

    monkeypatch.setattr(extractor, "_run_claude", _bad)
    e = extract_from_meeting(tmp_path, "", Path("claude"))
    assert e.is_empty()
    assert called["n"] == 0


def test_extract_from_meeting_subprocess_returns_none(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(extractor, "_run_claude", lambda *a, **kw: None)
    e = extract_from_meeting(tmp_path, "[19:00:00] x: hi\n", Path("claude"))
    assert e.is_empty()


def test_extract_from_meeting_malformed_output_falls_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(extractor, "_run_claude", lambda *a, **kw: "garbage no json here")
    e = extract_from_meeting(tmp_path, "[19:00:00] x: hi\n", Path("claude"))
    assert e.is_empty()


# ----------------------------------------------------------------------
# Subprocess wrapper guards (without actually running claude)


def test_run_claude_handles_missing_binary(tmp_path: Path) -> None:
    # Use a path that definitely doesn't exist
    fake = tmp_path / "nope" / "claude"
    out = extractor._run_claude(fake, "hi")
    assert out is None


# ----------------------------------------------------------------------
# Dataclass invariants


def test_extracted_entities_counts() -> None:
    e = ExtractedEntities(
        people=[PersonMention("a", "ctx")],
        projects=[ProjectMention("p", "P", "ctx")],
        threads=[ThreadMention("t", "T", "sum")],
        glossary=[GlossaryTerm("g", "def")],
    )
    assert e.counts() == {"people": 1, "projects": 1, "threads": 1, "glossary": 1}
    assert not e.is_empty()


def test_extracted_entities_empty() -> None:
    assert ExtractedEntities.empty().is_empty()
