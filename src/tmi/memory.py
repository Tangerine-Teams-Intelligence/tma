"""Memory-layer writers — unified ``memory/`` tree under the user's target repo.

Spec: INTERFACES.md §13 (Memory Layer). v1.5 covers ``meetings/`` and
``decisions/``. ``people/``, ``projects/``, ``threads/``, ``glossary/`` are
deferred to v1.6+.

Layout::

    <target_repo>/
    └── memory/
        ├── meetings/
        │   └── 2026-04-25-david-roadmap-sync.md
        └── decisions/
            └── postgres-over-mongo.md

Each meeting is a single flat file (YAML frontmatter + markdown body) instead of
a per-meeting directory. Decisions are extracted from the wrap-mode summary and
written as standalone files with provenance pointing back to the source meeting
file (and a transcript line anchor).
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml

from .meeting import Meeting
from .utils import SHANGHAI, atomic_write_text

# ----------------------------------------------------------------------
# Slug + path helpers


def slugify_for_memory(title: str) -> str:
    """Lowercased, hyphenated, alphanumerics-only slug for memory filenames.

    Mirrors the broader project ``slugify`` but kept local so future tweaks
    (e.g. unicode handling) don't ripple into meeting-id generation.
    """
    s = title.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "untitled"


def meeting_filename(meeting: Meeting) -> str:
    """Filename = ``<YYYY-MM-DD>-<slug>.md``. Date is the meeting's ``created_at``."""
    date = meeting.created_at.astimezone(SHANGHAI).date().isoformat()
    return f"{date}-{slugify_for_memory(meeting.title)}.md"


def meeting_file_path(memory_root: Path, meeting: Meeting) -> Path:
    return memory_root / "meetings" / meeting_filename(meeting)


def decision_file_path(memory_root: Path, decision_slug: str) -> Path:
    return memory_root / "decisions" / f"{slugify_for_memory(decision_slug)}.md"


# ----------------------------------------------------------------------
# Meeting file writer


def _frontmatter(payload: dict[str, Any]) -> str:
    body = yaml.safe_dump(payload, sort_keys=False, default_flow_style=False, allow_unicode=True)
    return f"---\n{body}---\n"


def _duration_minutes(transcript: str) -> int | None:
    """Best-effort duration from first/last ``[HH:MM:SS]`` prefixes. None if unparseable."""
    times: list[tuple[int, int, int]] = []
    for line in transcript.splitlines():
        m = re.match(r"^\[(\d{2}):(\d{2}):(\d{2})\]", line)
        if m:
            times.append((int(m.group(1)), int(m.group(2)), int(m.group(3))))
    if len(times) < 2:
        return None
    first = times[0][0] * 3600 + times[0][1] * 60 + times[0][2]
    last = times[-1][0] * 3600 + times[-1][1] * 60 + times[-1][2]
    if last < first:  # crossed midnight; punt
        return None
    return max(0, (last - first) // 60)


def render_meeting_file(
    meeting: Meeting,
    transcript: str,
    *,
    summary_body: str | None = None,
    decision_links: list[tuple[str, str]] | None = None,
    source: str = "discord",
) -> str:
    """Render the unified ``memory/meetings/<slug>.md`` content.

    Args:
        meeting: parsed ``meeting.yaml``.
        transcript: full ``transcript.md`` content (chronological turns).
        summary_body: optional markdown body of the wrap-mode summary (without
            its own frontmatter). Goes under ``## Summary``.
        decision_links: optional list of ``(title, slug)`` pairs. Each becomes a
            relative link under ``## Decisions`` to ``../decisions/<slug>.md``.
        source: provenance hint. Defaults to ``"discord"``.
    """
    fm = _frontmatter(
        {
            "date": meeting.created_at.astimezone(SHANGHAI).date().isoformat(),
            "title": meeting.title,
            "source": source,
            "participants": [p.alias for p in meeting.participants],
            "duration_min": _duration_minutes(transcript),
            "meeting_id": meeting.id,
        }
    )
    parts: list[str] = [fm, ""]
    parts.append("## Transcript")
    parts.append("")
    parts.append(transcript.rstrip("\n") if transcript else "(empty)")
    parts.append("")
    if summary_body:
        parts.append("## Summary")
        parts.append("")
        parts.append(summary_body.rstrip("\n"))
        parts.append("")
    if decision_links:
        parts.append("## Decisions")
        parts.append("")
        for title, slug in decision_links:
            parts.append(f"- [{title}](../decisions/{slugify_for_memory(slug)}.md)")
        parts.append("")
    return "\n".join(parts).rstrip() + "\n"


def write_meeting_file(
    memory_root: Path,
    meeting: Meeting,
    transcript: str,
    *,
    summary_body: str | None = None,
    decision_links: list[tuple[str, str]] | None = None,
    source: str = "discord",
) -> Path:
    """Write the unified meeting file. Returns the absolute path written."""
    path = meeting_file_path(memory_root, meeting)
    content = render_meeting_file(
        meeting,
        transcript,
        summary_body=summary_body,
        decision_links=decision_links,
        source=source,
    )
    atomic_write_text(path, content)
    return path


# ----------------------------------------------------------------------
# Decision extraction + writer


# Heuristic: scan the wrap-mode summary for "## Topics covered" subsections
# whose **Outcome** line starts with "decided" or "agreed". Each such topic
# becomes one decision file.
_TOPIC_HEADING_RE = re.compile(r"^### Topic\s+\d+:\s*(?P<title>.+?)\s*$", re.MULTILINE)


def extract_decisions_from_summary(summary_markdown: str) -> list[dict[str, Any]]:
    """Parse the wrap-mode ``summary.md`` into a list of decision dicts.

    Returns one entry per "decided"/"agreed" topic. Each dict has::

        {"title": str, "outcome": str, "decided_by": str,
         "transcript_refs": [str], "context": str}

    If the summary doesn't follow the expected format, returns ``[]`` — callers
    treat decision extraction as best-effort.
    """
    if not summary_markdown:
        return []

    # Drop frontmatter if present
    body = summary_markdown
    if body.startswith("---\n"):
        end = body.find("\n---\n", 4)
        if end != -1:
            body = body[end + 5 :]

    # Restrict to "## Topics covered" section if present
    section_start = body.find("## Topics covered")
    if section_start != -1:
        # End at next "## " heading
        rest = body[section_start + len("## Topics covered") :]
        next_h = re.search(r"^##\s+", rest, re.MULTILINE)
        scope = rest[: next_h.start()] if next_h else rest
    else:
        scope = body

    decisions: list[dict[str, Any]] = []
    matches = list(_TOPIC_HEADING_RE.finditer(scope))
    for i, m in enumerate(matches):
        title = m.group("title").strip()
        block_start = m.end()
        block_end = matches[i + 1].start() if i + 1 < len(matches) else len(scope)
        block = scope[block_start:block_end].strip()

        outcome = _bullet_value(block, "Outcome")
        if not outcome:
            continue
        # Only treat as decision if outcome starts with "decided" or "agreed"
        olc = outcome.lower()
        if not (olc.startswith("decided") or olc.startswith("agreed")):
            continue

        decided_by = _bullet_value(block, "Decided by") or ""
        refs_raw = _bullet_value(block, "Transcript refs") or ""
        refs = [r.strip() for r in refs_raw.split(",") if r.strip()]
        decisions.append(
            {
                "title": title,
                "outcome": outcome,
                "decided_by": decided_by,
                "transcript_refs": refs,
                "context": block,
            }
        )
    return decisions


def _bullet_value(block: str, key: str) -> str | None:
    """Extract ``- **<key>**: <value>`` from a markdown bullet block. Returns
    ``None`` if missing.
    """
    m = re.search(rf"^[-*]\s+\*\*{re.escape(key)}\*\*:\s*(?P<val>.+?)\s*$", block, re.MULTILINE)
    return m.group("val").strip() if m else None


def _first_transcript_line(refs: list[str]) -> int | None:
    """Pull a leading line number out of a transcript ref like ``L47`` or ``L47-L52``."""
    for r in refs:
        m = re.search(r"L(\d+)", r)
        if m:
            return int(m.group(1))
    return None


def render_decision_file(
    decision: dict[str, Any],
    *,
    meeting: Meeting,
    meeting_filename_value: str,
) -> str:
    """Render one ``memory/decisions/<slug>.md``. Provenance section links back
    to the source meeting file using a relative path.
    """
    title = decision["title"]
    refs = decision.get("transcript_refs") or []
    line_no = _first_transcript_line(refs)
    fm = _frontmatter(
        {
            "date": meeting.created_at.astimezone(SHANGHAI).date().isoformat(),
            "title": title,
            "source": "meeting",
            "source_id": meeting.id,
            "source_line": line_no,
            "status": "decided",
        }
    )
    parts: list[str] = [fm, ""]
    parts.append("## Decision")
    parts.append("")
    parts.append(decision.get("outcome", "").strip() or title)
    parts.append("")
    if decision.get("decided_by"):
        parts.append(f"**Decided by**: {decision['decided_by']}")
        parts.append("")
    parts.append("## Context")
    parts.append("")
    parts.append(decision.get("context", "").strip() or f"Came up in {meeting.title}.")
    parts.append("")
    parts.append("## Provenance")
    parts.append("")
    if line_no is not None:
        anchor = f"#L{line_no}"
    else:
        anchor = ""
    parts.append(
        f"- Source meeting: [{meeting.title}](../meetings/{meeting_filename_value}{anchor})"
    )
    if refs:
        parts.append(f"- Transcript refs: {', '.join(refs)}")
    parts.append("")
    return "\n".join(parts).rstrip() + "\n"


def write_decisions(
    memory_root: Path,
    meeting: Meeting,
    summary_markdown: str,
) -> list[tuple[str, Path]]:
    """Extract decisions from a wrap summary and write each to its own file.

    Returns a list of ``(slug, path)`` tuples for every decision written.
    Returns an empty list if extraction yields no decisions.
    """
    decisions = extract_decisions_from_summary(summary_markdown)
    if not decisions:
        return []
    written: list[tuple[str, Path]] = []
    mfn = meeting_filename(meeting)
    for d in decisions:
        slug = slugify_for_memory(d["title"])
        path = decision_file_path(memory_root, slug)
        content = render_decision_file(d, meeting=meeting, meeting_filename_value=mfn)
        atomic_write_text(path, content)
        written.append((slug, path))
    return written


__all__ = [
    "slugify_for_memory",
    "meeting_filename",
    "meeting_file_path",
    "decision_file_path",
    "render_meeting_file",
    "write_meeting_file",
    "extract_decisions_from_summary",
    "render_decision_file",
    "write_decisions",
]
