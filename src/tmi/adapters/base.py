"""Abstract base for output adapters.

The adapter abstraction lets TMA target multiple AI-context tools — Claude Code
in v1, Cursor / aider / continue.dev in later releases. Adapter type strings
(``claude_code``) are stable identifiers per INTERFACES.md §11.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

from .types import (
    AppliedResult,
    GroundTruth,
    Intent,
    KnowledgeDiff,
    Summary,
    Transcript,
)


class OutputAdapter(ABC):
    """Abstract output adapter.

    Concrete subclasses MUST be safe to import (no I/O at import time) and MUST
    perform every read/write strictly within ``target_repo``.
    """

    target_repo: Path
    file_mappings: dict[str, str]
    commit_author: str

    @abstractmethod
    def __init__(
        self,
        target_repo: Path,
        file_mappings: dict[str, str],
        commit_author: str,
    ) -> None: ...

    @abstractmethod
    def read_ground_truth(self) -> GroundTruth:
        """Return a frozen snapshot of the target repo's authoritative files."""

    @abstractmethod
    def parse_diff(self, diff_markdown: str) -> KnowledgeDiff:
        """Parse a knowledge-diff.md document into structured blocks."""

    @abstractmethod
    def generate_diff(
        self,
        summary: Summary,
        intents: list[Intent],
        transcript: Transcript,
    ) -> KnowledgeDiff:
        """Reserved for future direct-generation paths.

        v1: wrap-mode LLM produces the diff; this method raises
        ``NotImplementedError``. Kept in the API per design-call #10 to avoid a
        future breaking change.
        """

    @abstractmethod
    def apply_diff(
        self,
        diff: KnowledgeDiff,
        approved_block_ids: list[int],
        edited_blocks: dict[int, "DiffBlock"] | None = None,  # noqa: F821
        commit: bool = True,
    ) -> AppliedResult:
        """Apply approved blocks to ``target_repo`` and (optionally) commit."""


__all__ = ["OutputAdapter"]
