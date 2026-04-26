"""Pydantic types for the TMA output adapter API.

These types are the public contract between the CLI (D1) and the adapter (this
module). They follow INTERFACES.md §7 exactly. Do not rename fields without a
schema_version bump.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# ---------------------------------------------------------------------------
# Action enum (INTERFACES.md §8.2)
# ---------------------------------------------------------------------------
DiffAction = Literal["append", "replace", "insert", "create"]


class KnowledgeFile(BaseModel):
    """A single Markdown file under the target repo's knowledge_dir."""

    model_config = ConfigDict(frozen=True)

    path: str = Field(..., description="POSIX-style path relative to target_repo")
    content: str


class GroundTruth(BaseModel):
    """Frozen snapshot of the target repo's authoritative content.

    Built by ``ClaudeCodeAdapter.read_ground_truth`` and passed (verbatim) into
    the wrap-mode observer's input envelope. Once constructed it is read-only.
    """

    model_config = ConfigDict(frozen=True)

    claude_md: str = Field(..., description="Full content of CLAUDE.md")
    session_state: str = Field(
        default="", description="Full content of session-state.md (may be empty string)"
    )
    knowledge_files: list[KnowledgeFile] = Field(default_factory=list)
    detected_at: datetime


class Summary(BaseModel):
    """Structured wrapper around the wrap-mode summary.md."""

    markdown: str
    meeting_id: str
    participants: list[str]


class Intent(BaseModel):
    """One participant's locked intent file."""

    alias: str
    markdown: str
    locked_at: datetime


class Transcript(BaseModel):
    """Full transcript content + line count (sanity check)."""

    text: str
    line_count: int


class DiffBlock(BaseModel):
    """One proposed change to a target-repo file.

    Represents a single block in ``knowledge-diff.md``. Block IDs are 1-based
    monotonic integers within a single diff file (INTERFACES.md §8.3).
    """

    id: int = Field(..., ge=1, description="1-based monotonic ID within the diff file")
    target_file: str = Field(
        ..., description="POSIX-style path relative to target_repo (no `..` escapes)"
    )
    action: DiffAction
    insert_anchor: str | None = Field(
        default=None,
        description="Required when action=insert; the unique line in target_file "
        "after which the new content is placed.",
    )
    reason: str
    transcript_refs: list[str] = Field(
        default_factory=list,
        description='List of refs like "L47" or "L52-L58"',
    )
    body: str = Field(
        ...,
        description="Raw fenced body (without the ``` fences) — see §8.2 for "
        "language semantics per action.",
    )

    @field_validator("target_file")
    @classmethod
    def _no_path_escape(cls, v: str) -> str:
        # Defensive: parser/applier also re-check, but failing fast at type
        # construction prevents downstream logic from ever seeing a bad path.
        if v.startswith("/") or "\\" in v or ".." in v.split("/"):
            raise ValueError(f"target_file must be a relative POSIX path: {v!r}")
        return v


class KnowledgeDiff(BaseModel):
    """The parsed contents of a knowledge-diff.md."""

    blocks: list[DiffBlock]
    generated_at: datetime
    meeting_id: str


class AppliedResult(BaseModel):
    """Outcome of ``ClaudeCodeAdapter.apply_diff``."""

    written_files: list[str] = Field(default_factory=list)
    commit_sha: str | None = None
    skipped_block_ids: list[int] = Field(default_factory=list)
    messages: list[str] = Field(default_factory=list)


__all__ = [
    "DiffAction",
    "KnowledgeFile",
    "GroundTruth",
    "Summary",
    "Intent",
    "Transcript",
    "DiffBlock",
    "KnowledgeDiff",
    "AppliedResult",
]
