"""Parser + serializer for ``knowledge-diff.md``.

Grammar (INTERFACES.md §8.1):

    diff-file := preamble? block (separator block)*
    preamble  := "<!-- TMA knowledge-diff schema_version=1 meeting_id=<id> -->"
    separator := "\\n---\\n"
    block     := "## Block <int> · <action> · <target-file>"
                 "**Reason**: <reason>"
                 "**Transcript refs**: <refs>"
                 ("**Anchor**: <anchor>")?
                 ("**Block-ID**: <int>")?
                 fenced-body

Round-trip guarantee: ``serialize(parse(x)) == x`` for any well-formed diff
file produced by ``serialize``. Documents with idiosyncratic whitespace round
through a *normal form* — the parser's job is to extract structured data, not
to preserve every byte. Tests assert round-trip on canonical fixtures.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Iterable

from .types import DiffAction, DiffBlock, KnowledgeDiff

# ---------------------------------------------------------------------------
# Regex
# ---------------------------------------------------------------------------
_PREAMBLE_RE = re.compile(
    r"^<!--\s*TMA knowledge-diff schema_version=(?P<ver>\d+)"
    r"\s+meeting_id=(?P<mid>[A-Za-z0-9_\-]+)\s*-->\s*$"
)

_HEADING_RE = re.compile(
    r"^##\s+Block\s+(?P<id>\d+)\s+·\s+(?P<action>append|insert|replace|create)\s+·\s+(?P<target>.+?)\s*$"
)

# Allow CRLF as well as LF.
_SEP_RE = re.compile(r"(?:\r?\n)---(?:\r?\n)")

_FENCE_OPEN_RE = re.compile(r"^```(?P<lang>diff|markdown)\s*$")
_FENCE_CLOSE_RE = re.compile(r"^```\s*$")

_VALID_ACTIONS: tuple[DiffAction, ...] = ("append", "insert", "replace", "create")


class DiffParseError(ValueError):
    """Raised on malformed diff input. Carries (line_no, message)."""

    def __init__(self, line_no: int, message: str) -> None:
        super().__init__(f"line {line_no}: {message}")
        self.line_no = line_no
        self.message = message


# ---------------------------------------------------------------------------
# Parse
# ---------------------------------------------------------------------------
def parse_diff(
    diff_markdown: str,
    *,
    meeting_id_fallback: str = "",
    generated_at: datetime | None = None,
) -> KnowledgeDiff:
    """Parse a knowledge-diff.md string into a ``KnowledgeDiff``.

    ``meeting_id_fallback`` is used only if no preamble is present.
    ``generated_at`` defaults to ``datetime.now(timezone.utc)``.
    """
    text = diff_markdown.replace("\r\n", "\n")
    lines = text.split("\n")

    # ---- preamble -----------------------------------------------------
    meeting_id = meeting_id_fallback
    cursor = 0
    # Skip leading blanks then look for preamble.
    while cursor < len(lines) and lines[cursor].strip() == "":
        cursor += 1
    if cursor < len(lines):
        m = _PREAMBLE_RE.match(lines[cursor])
        if m:
            meeting_id = m.group("mid")
            cursor += 1
            while cursor < len(lines) and lines[cursor].strip() == "":
                cursor += 1

    if not meeting_id:
        # Allow empty meeting_id only if caller passed an explicit fallback
        # string (which may itself be empty for unit tests). No raise.
        meeting_id = ""

    body = "\n".join(lines[cursor:])
    if body.strip() == "":
        return KnowledgeDiff(
            blocks=[],
            generated_at=generated_at or datetime.now(timezone.utc),
            meeting_id=meeting_id,
        )

    # ---- split on separator -----------------------------------------
    raw_blocks = _SEP_RE.split(body)

    blocks: list[DiffBlock] = []
    # Track absolute line numbers for error messages. Each split removes the
    # `\n---\n` (4 chars / 1 line). Approximate by counting lines per chunk.
    line_offset = cursor
    for raw in raw_blocks:
        if raw.strip() == "":
            line_offset += raw.count("\n") + 1
            continue
        block = _parse_one_block(raw, line_offset)
        blocks.append(block)
        line_offset += raw.count("\n") + 1  # +1 for the consumed separator

    # Validate monotonic, 1-based IDs (INTERFACES.md §8.3).
    expected = 1
    for b in blocks:
        if b.id != expected:
            raise DiffParseError(
                0,
                f"block IDs must be 1-based monotonic; got {b.id}, expected {expected}",
            )
        expected += 1

    return KnowledgeDiff(
        blocks=blocks,
        generated_at=generated_at or datetime.now(timezone.utc),
        meeting_id=meeting_id,
    )


def _parse_one_block(raw: str, line_offset: int) -> DiffBlock:
    lines = raw.split("\n")
    # Trim leading/trailing blanks but remember offset.
    i = 0
    while i < len(lines) and lines[i].strip() == "":
        i += 1
    if i >= len(lines):
        raise DiffParseError(line_offset, "empty block")

    heading_line_no = line_offset + i + 1
    heading_match = _HEADING_RE.match(lines[i])
    if not heading_match:
        raise DiffParseError(
            heading_line_no,
            f"expected '## Block N · <action> · <target>'; got: {lines[i]!r}",
        )

    block_id = int(heading_match.group("id"))
    action_str = heading_match.group("action")
    if action_str not in _VALID_ACTIONS:
        raise DiffParseError(heading_line_no, f"unknown action {action_str!r}")
    action: DiffAction = action_str  # type: ignore[assignment]
    target_file = heading_match.group("target").strip()
    i += 1

    # Metadata lines (Reason, Transcript refs, optional Anchor / Block-ID).
    reason = ""
    transcript_refs: list[str] = []
    anchor: str | None = None
    explicit_block_id: int | None = None

    while i < len(lines):
        line = lines[i]
        if line.strip() == "":
            i += 1
            continue
        if line.startswith("```"):
            break
        if line.startswith("**Reason**:"):
            reason = line[len("**Reason**:") :].strip()
        elif line.startswith("**Transcript refs**:"):
            raw_refs = line[len("**Transcript refs**:") :].strip()
            transcript_refs = [r.strip() for r in raw_refs.split(",") if r.strip()]
        elif line.startswith("**Anchor**:"):
            anchor = line[len("**Anchor**:") :].strip()
        elif line.startswith("**Block-ID**:"):
            try:
                explicit_block_id = int(line[len("**Block-ID**:") :].strip())
            except ValueError as e:
                raise DiffParseError(
                    line_offset + i + 1, f"**Block-ID** must be int: {e}"
                ) from e
        else:
            # Unknown metadata line — drop with effective warning (silent for
            # now; INTERFACES.md §8.5 says "dropped with a warning"). Tests
            # assert this lenient behavior.
            pass
        i += 1

    if not reason:
        raise DiffParseError(line_offset + i + 1, "missing **Reason**")
    if explicit_block_id is not None and explicit_block_id != block_id:
        raise DiffParseError(
            line_offset + i + 1,
            f"**Block-ID**: {explicit_block_id} disagrees with heading id {block_id}",
        )
    if action == "insert" and not anchor:
        raise DiffParseError(
            heading_line_no, "action=insert requires **Anchor** metadata"
        )

    # Fenced body
    if i >= len(lines) or not lines[i].startswith("```"):
        raise DiffParseError(line_offset + i + 1, "expected fenced code block")
    open_match = _FENCE_OPEN_RE.match(lines[i])
    if not open_match:
        raise DiffParseError(
            line_offset + i + 1,
            f"fence must be ```diff or ```markdown; got: {lines[i]!r}",
        )
    fence_lang = open_match.group("lang")
    expected_lang = "markdown" if action == "create" else "diff"
    if fence_lang != expected_lang:
        raise DiffParseError(
            line_offset + i + 1,
            f"action={action} requires ```{expected_lang} fence, got ```{fence_lang}",
        )
    i += 1

    body_lines: list[str] = []
    while i < len(lines):
        if _FENCE_CLOSE_RE.match(lines[i]):
            break
        body_lines.append(lines[i])
        i += 1
    else:
        raise DiffParseError(line_offset + i, "unterminated fenced code block")
    body = "\n".join(body_lines)

    return DiffBlock(
        id=block_id,
        target_file=target_file,
        action=action,
        insert_anchor=anchor,
        reason=reason,
        transcript_refs=transcript_refs,
        body=body,
    )


# ---------------------------------------------------------------------------
# Serialize
# ---------------------------------------------------------------------------
def serialize_diff(diff: KnowledgeDiff) -> str:
    """Serialize a ``KnowledgeDiff`` back to canonical Markdown.

    Round-trip property: for any string ``s`` produced by ``serialize_diff``,
    ``serialize_diff(parse_diff(s)) == s``.
    """
    parts: list[str] = []
    parts.append(
        f"<!-- TMA knowledge-diff schema_version=1 meeting_id={diff.meeting_id} -->"
    )
    parts.append("")  # blank line after preamble

    block_strs: list[str] = []
    for block in diff.blocks:
        block_strs.append(_serialize_block(block))

    # Canonical separator between blocks: blank line + "---" + blank line.
    # Each _serialize_block already ends with a single "\n"; we strip that and
    # rejoin with the canonical "\n\n---\n\n" separator.
    body = "\n\n---\n\n".join(b.rstrip("\n") for b in block_strs)
    parts.append(body)
    return "\n".join(parts) + "\n"


def _serialize_block(block: DiffBlock) -> str:
    fence_lang = "markdown" if block.action == "create" else "diff"
    lines: list[str] = []
    lines.append(f"## Block {block.id} · {block.action} · {block.target_file}")
    lines.append(f"**Reason**: {block.reason}")
    refs = ", ".join(block.transcript_refs)
    lines.append(f"**Transcript refs**: {refs}")
    if block.insert_anchor is not None:
        lines.append(f"**Anchor**: {block.insert_anchor}")
    lines.append(f"**Block-ID**: {block.id}")
    lines.append("")
    lines.append(f"```{fence_lang}")
    # Body should not have trailing newlines that would create blank lines
    # between content and closing fence.
    body = block.body.rstrip("\n")
    if body:
        lines.append(body)
    lines.append("```")
    return "\n".join(lines) + "\n"


__all__ = ["parse_diff", "serialize_diff", "DiffParseError"]
