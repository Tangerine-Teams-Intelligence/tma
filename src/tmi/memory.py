"""Memory-layer writers — unified ``memory/`` tree under the user's target repo.

Spec: INTERFACES.md §13 (Memory Layer). v1.5 covered ``meetings/`` and
``decisions/``. v1.6 adds ``people/``, ``projects/``, ``threads/`` and
``glossary/`` driven by the AI extractor in ``tmi.extractor``.

Layout::

    <target_repo>/
    └── memory/
        ├── meetings/
        │   └── 2026-04-25-david-roadmap-sync.md
        ├── decisions/
        │   └── postgres-over-mongo.md
        ├── people/
        │   └── david.md
        ├── projects/
        │   └── pricing.md
        ├── threads/
        │   └── seat-pricing.md
        └── glossary/
            └── tmi.md

Each meeting is a single flat file (YAML frontmatter + markdown body) instead of
a per-meeting directory. Decisions are extracted from the wrap-mode summary and
written as standalone files with provenance pointing back to the source meeting
file (and a transcript line anchor).

The four entity writers (``write_people``, ``write_projects``, ``write_threads``,
``write_glossary``) are airtight idempotent: re-running on the same meeting
replaces that meeting's mention block in place rather than appending a duplicate.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

import yaml

from .meeting import Meeting
from .utils import SHANGHAI, atomic_write_text

if TYPE_CHECKING:
    from .extractor import (
        ExtractedEntities,
        GlossaryTerm,
        PersonMention,
        ProjectMention,
        ThreadMention,
    )

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


# ----------------------------------------------------------------------
# Entity files (v1.6+): people / projects / threads / glossary
#
# Shared file layout::
#
#     ---
#     <key>: <value>
#     last_seen: 2026-04-25
#     mention_count: 12
#     sources: [meeting]
#     ---
#
#     # <display>
#
#     [optional preamble — for glossary, the locked definition lives here]
#
#     ## Mentions
#
#     <!-- mention:<meeting_id> -->
#     ### 2026-04-25 — <meeting_title>
#     - <bullet>
#     - <bullet>
#     [→ meeting](../meetings/<meeting_filename>.md)
#
#     <!-- mention:<other_meeting_id> -->
#     ### ...
#
# Each mention block is sentinel-fenced by an HTML comment (``<!-- mention:<id>
# -->``) so we can find + replace it idempotently without parsing markdown.


_MENTION_SENTINEL_RE = re.compile(
    r"<!-- mention:(?P<mid>[A-Za-z0-9._-]+) -->\n(?P<body>.*?)(?=\n<!-- mention:|\Z)",
    re.DOTALL,
)


def people_file_path(memory_root: Path, alias: str) -> Path:
    return memory_root / "people" / f"{slugify_for_memory(alias)}.md"


def projects_file_path(memory_root: Path, slug: str) -> Path:
    return memory_root / "projects" / f"{slugify_for_memory(slug)}.md"


def threads_file_path(memory_root: Path, topic: str) -> Path:
    return memory_root / "threads" / f"{slugify_for_memory(topic)}.md"


def glossary_file_path(memory_root: Path, term: str) -> Path:
    return memory_root / "glossary" / f"{slugify_for_memory(term)}.md"


def _split_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Return ``(frontmatter_dict, body)``. If no frontmatter, ``({}, text)``."""
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    raw = text[4:end]
    body = text[end + 5 :].lstrip("\n")
    try:
        loaded = yaml.safe_load(raw) or {}
    except yaml.YAMLError:
        return {}, text
    if not isinstance(loaded, dict):
        return {}, body
    return loaded, body


def _parse_mentions(body: str) -> tuple[str, dict[str, str]]:
    """Pull out every ``<!-- mention:<id> -->`` block. Returns
    ``(preamble_above_mentions_section, {meeting_id: full_block_with_sentinel})``.

    The mentions section is fenced by ``## Mentions``. Anything above stays as-is.
    """
    mentions_idx = body.find("\n## Mentions\n")
    if mentions_idx == -1:
        # Older file without a Mentions section, or file we just created.
        if body.startswith("## Mentions\n"):
            preamble = ""
            rest = body[len("## Mentions\n") :]
        else:
            return body, {}
    else:
        preamble = body[: mentions_idx + 1]  # keep trailing newline
        rest = body[mentions_idx + len("\n## Mentions\n") :]

    mentions: dict[str, str] = {}
    for m in _MENTION_SENTINEL_RE.finditer(rest):
        mid = m.group("mid")
        full = m.group(0).rstrip() + "\n"
        mentions[mid] = full
    return preamble, mentions


def _render_entity_file(
    *,
    title: str,
    fm: dict[str, Any],
    preamble: str,
    mentions: dict[str, str],
) -> str:
    """Compose frontmatter + ``# title`` + preamble + ``## Mentions`` + ordered
    mention blocks. Mentions are sorted by meeting_id descending (newest first
    given our YYYY-MM-DD-<slug> id format).
    """
    parts: list[str] = []
    parts.append(_frontmatter(fm))
    parts.append("")
    parts.append(f"# {title}")
    parts.append("")
    if preamble.strip():
        parts.append(preamble.rstrip())
        parts.append("")
    parts.append("## Mentions")
    parts.append("")
    for mid in sorted(mentions, reverse=True):
        block = mentions[mid].rstrip() + "\n"
        parts.append(block)
    return "\n".join(parts).rstrip() + "\n"


def _format_lines_ref(lines: tuple[int, ...] | list[int]) -> str:
    if not lines:
        return ""
    return ", ".join(f"L{n}" for n in lines)


def _meeting_link(meeting: Meeting, *, anchor_line: int | None = None) -> str:
    fname = meeting_filename(meeting)
    anchor = f"#L{anchor_line}" if anchor_line else ""
    return f"[→ meeting]({Path('..') / 'meetings' / fname}{anchor})".replace("\\", "/")


def _build_mention_block(
    *,
    meeting: Meeting,
    bullets: list[str],
    extra_first_line: int | None = None,
) -> str:
    """Sentinel-wrapped mention block. Bullet list + meeting link."""
    date = meeting.created_at.astimezone(SHANGHAI).date().isoformat()
    parts = [
        f"<!-- mention:{meeting.id} -->",
        f"### {date} — {meeting.title}",
    ]
    for b in bullets:
        b = b.strip()
        if not b:
            continue
        parts.append(f"- {b}")
    parts.append(_meeting_link(meeting, anchor_line=extra_first_line))
    parts.append("")  # trailing blank between blocks
    return "\n".join(parts)


def _upsert_entity(
    *,
    path: Path,
    title: str,
    base_fm: dict[str, Any],
    preamble: str,
    meeting: Meeting,
    new_block: str,
) -> bool:
    """Read existing entity file (if any), replace or insert the mention block
    for ``meeting.id``, recompute ``last_seen`` + ``mention_count``, and write
    back atomically.

    Returns ``True`` if the file was written (created or content changed),
    ``False`` if the file was already up to date (true idempotent no-op).
    """
    existing = ""
    if path.exists():
        try:
            existing = path.read_text(encoding="utf-8")
        except OSError:
            existing = ""

    fm, body = _split_frontmatter(existing)
    # Drop the leading ``# <title>\n\n`` from the body so we don't double-render
    # it on every write. We always re-emit our own.
    body_stripped = body
    leading_h1 = re.match(r"^#\s+[^\n]+\n+", body_stripped)
    if leading_h1:
        body_stripped = body_stripped[leading_h1.end() :]

    parsed_preamble, mentions = _parse_mentions(body_stripped)
    final_preamble = preamble.strip() or parsed_preamble.strip()

    mentions[meeting.id] = new_block.rstrip() + "\n"

    # Recompute frontmatter — preserve user-added keys.
    merged_fm = dict(fm)
    merged_fm.update(base_fm)
    dates = sorted(_extract_dates_from_mentions(mentions), reverse=True)
    if dates:
        merged_fm["last_seen"] = dates[0]
    merged_fm["mention_count"] = len(mentions)
    sources = merged_fm.get("sources")
    if not isinstance(sources, list) or "meeting" not in sources:
        merged_fm["sources"] = ["meeting"] if not isinstance(sources, list) else sorted(set(sources) | {"meeting"})

    new_text = _render_entity_file(
        title=title,
        fm=merged_fm,
        preamble=final_preamble,
        mentions=mentions,
    )
    if new_text == existing:
        return False
    atomic_write_text(path, new_text)
    return True


_DATE_RE = re.compile(r"^(?P<date>\d{4}-\d{2}-\d{2})-")


def _extract_dates_from_mentions(mentions: dict[str, str]) -> list[str]:
    out: list[str] = []
    for mid in mentions:
        m = _DATE_RE.match(mid)
        if m:
            out.append(m.group("date"))
    return out


# ----------------------------------------------------------------------
# people


def write_people(
    memory_root: Path,
    mentions: list["PersonMention"],
    meeting: Meeting,
) -> list[Path]:
    """Append/refresh person mentions. Returns paths written (created OR updated).

    Files that were already up to date (true no-op) are NOT included — this lets
    callers report "wrote N files" honestly. Callers who want every path should
    look up by alias.
    """
    written: list[Path] = []
    for mention in mentions:
        path = people_file_path(memory_root, mention.alias)
        bullets = [mention.context] if mention.context else ["Mentioned in this meeting."]
        first_line = mention.transcript_lines[0] if mention.transcript_lines else None
        block = _build_mention_block(
            meeting=meeting, bullets=bullets, extra_first_line=first_line
        )
        changed = _upsert_entity(
            path=path,
            title=mention.alias,
            base_fm={"alias": mention.alias},
            preamble="",
            meeting=meeting,
            new_block=block,
        )
        if changed:
            written.append(path)
    return written


# ----------------------------------------------------------------------
# projects


def write_projects(
    memory_root: Path,
    mentions: list["ProjectMention"],
    meeting: Meeting,
) -> list[Path]:
    written: list[Path] = []
    for mention in mentions:
        path = projects_file_path(memory_root, mention.slug)
        bullets = [mention.context] if mention.context else ["Mentioned in this meeting."]
        first_line = mention.transcript_lines[0] if mention.transcript_lines else None
        block = _build_mention_block(
            meeting=meeting, bullets=bullets, extra_first_line=first_line
        )
        changed = _upsert_entity(
            path=path,
            title=mention.name or mention.slug,
            base_fm={"slug": mention.slug, "name": mention.name or mention.slug},
            preamble="",
            meeting=meeting,
            new_block=block,
        )
        if changed:
            written.append(path)
    return written


# ----------------------------------------------------------------------
# threads
#
# Threads are special: they MERGE — repeated topics across meetings accumulate
# context + open questions. The preamble holds an evergreen summary line; each
# mention block carries the per-meeting summary + open questions.


def write_threads(
    memory_root: Path,
    mentions: list["ThreadMention"],
    meeting: Meeting,
) -> list[Path]:
    written: list[Path] = []
    for mention in mentions:
        path = threads_file_path(memory_root, mention.topic)
        bullets: list[str] = []
        if mention.summary:
            bullets.append(mention.summary)
        for q in mention.open_questions:
            bullets.append(f"Open question: {q}")
        if not bullets:
            bullets.append("Mentioned in this meeting.")
        first_line = mention.transcript_lines[0] if mention.transcript_lines else None
        block = _build_mention_block(
            meeting=meeting, bullets=bullets, extra_first_line=first_line
        )
        changed = _upsert_entity(
            path=path,
            title=mention.title or mention.topic,
            base_fm={"topic": mention.topic, "title": mention.title or mention.topic},
            preamble="",
            meeting=meeting,
            new_block=block,
        )
        if changed:
            written.append(path)
    return written


# ----------------------------------------------------------------------
# glossary
#
# Glossary entries dedupe by term. First seen wins for the definition, but every
# meeting's reference accumulates. The locked definition lives in the preamble.


def write_glossary(
    memory_root: Path,
    terms: list["GlossaryTerm"],
    meeting: Meeting,
) -> list[Path]:
    written: list[Path] = []
    for term in terms:
        path = glossary_file_path(memory_root, term.term)
        # Build a one-line preamble for the definition. Only set it if missing —
        # first-seen wins.
        preamble = ""
        if path.exists():
            existing = path.read_text(encoding="utf-8")
            _, body = _split_frontmatter(existing)
            # Strip leading h1
            body = re.sub(r"^#\s+[^\n]+\n+", "", body)
            existing_pre, _ = _parse_mentions(body)
            preamble = existing_pre.strip()
        if not preamble and term.definition:
            preamble = f"**Definition**: {term.definition}"

        bullets: list[str] = []
        bullets.append(f"Used in this meeting{': ' + term.definition if term.definition else ''}")
        first_line = term.transcript_lines[0] if term.transcript_lines else None
        block = _build_mention_block(
            meeting=meeting, bullets=bullets, extra_first_line=first_line
        )

        date = meeting.created_at.astimezone(SHANGHAI).date().isoformat()
        base_fm: dict[str, Any] = {
            "term": term.term,
        }
        # Set first_seen only on creation.
        if not path.exists():
            base_fm["first_seen"] = date

        changed = _upsert_entity(
            path=path,
            title=term.term,
            base_fm=base_fm,
            preamble=preamble,
            meeting=meeting,
            new_block=block,
        )
        if changed:
            written.append(path)
    return written


# ----------------------------------------------------------------------
# Convenience: write all four at once


def write_extracted_entities(
    memory_root: Path,
    entities: "ExtractedEntities",
    meeting: Meeting,
) -> dict[str, list[Path]]:
    """Run all four entity writers. Returns a per-bucket list of changed files.

    The returned dict has the same keys as ``ExtractedEntities.counts()``::

        {"people": [...], "projects": [...], "threads": [...], "glossary": [...]}
    """
    return {
        "people": write_people(memory_root, entities.people, meeting),
        "projects": write_projects(memory_root, entities.projects, meeting),
        "threads": write_threads(memory_root, entities.threads, meeting),
        "glossary": write_glossary(memory_root, entities.glossary, meeting),
    }


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
    # Entity (v1.6+) writers
    "people_file_path",
    "projects_file_path",
    "threads_file_path",
    "glossary_file_path",
    "write_people",
    "write_projects",
    "write_threads",
    "write_glossary",
    "write_extracted_entities",
]
