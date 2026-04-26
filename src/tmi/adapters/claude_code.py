"""Concrete output adapter targeting Claude Code knowledge files.

This adapter knows the Claude Code convention: a top-level ``CLAUDE.md`` plus a
``knowledge/`` directory of Markdown notes (one of which is
``session-state.md``, the running session log). All paths are configured via
``file_mappings`` from ``config.output_adapters[].files``.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from .base import OutputAdapter
from .diff_applier import apply_blocks
from .diff_parser import parse_diff
from .types import (
    AppliedResult,
    DiffBlock,
    GroundTruth,
    Intent,
    KnowledgeDiff,
    KnowledgeFile,
    Summary,
    Transcript,
)


class ClaudeCodeAdapter(OutputAdapter):
    """Reads ground truth from + applies diffs to a Claude Code-style repo."""

    def __init__(
        self,
        target_repo: Path,
        file_mappings: dict[str, str],
        commit_author: str = "Tangerine Meeting Assistant <tma@tangerine.local>",
    ) -> None:
        # Defensive: don't resolve at __init__ time — INTERFACES.md says no I/O
        # at import time and we extend that to construction. resolve() in
        # methods that actually need it.
        self.target_repo = target_repo
        self.file_mappings = dict(file_mappings)
        self.commit_author = commit_author

        # Required mapping keys per §3 config schema.
        for required in ("claude_md", "knowledge_dir", "session_state"):
            if required not in self.file_mappings:
                raise ValueError(f"file_mappings missing required key: {required!r}")

    # ------------------------------------------------------------------
    # Read ground truth
    # ------------------------------------------------------------------
    def read_ground_truth(self) -> GroundTruth:
        repo = self.target_repo
        claude_md_path = repo / self.file_mappings["claude_md"]
        session_state_path = repo / self.file_mappings["session_state"]
        knowledge_dir = repo / self.file_mappings["knowledge_dir"]

        claude_md = (
            claude_md_path.read_text(encoding="utf-8") if claude_md_path.exists() else ""
        )
        session_state = (
            session_state_path.read_text(encoding="utf-8")
            if session_state_path.exists()
            else ""
        )

        knowledge_files: list[KnowledgeFile] = []
        if knowledge_dir.exists() and knowledge_dir.is_dir():
            for md in sorted(knowledge_dir.rglob("*.md")):
                # Skip session_state.md to avoid duplication — it's surfaced as
                # a top-level field.
                try:
                    rel = md.relative_to(repo).as_posix()
                except ValueError:
                    continue
                if rel == self.file_mappings["session_state"]:
                    continue
                knowledge_files.append(
                    KnowledgeFile(path=rel, content=md.read_text(encoding="utf-8"))
                )

        return GroundTruth(
            claude_md=claude_md,
            session_state=session_state,
            knowledge_files=knowledge_files,
            detected_at=datetime.now(timezone.utc),
        )

    # ------------------------------------------------------------------
    # Parse diff (delegates to module-level parser)
    # ------------------------------------------------------------------
    def parse_diff(self, diff_markdown: str) -> KnowledgeDiff:
        return parse_diff(diff_markdown)

    # ------------------------------------------------------------------
    # Generate diff (reserved — see design-call #10)
    # ------------------------------------------------------------------
    def generate_diff(
        self,
        summary: Summary,
        intents: list[Intent],
        transcript: Transcript,
    ) -> KnowledgeDiff:
        raise NotImplementedError(
            "v1: wrap-mode LLM produces diffs. Direct generation is reserved "
            "for v1.1+ per design-call #10."
        )

    # ------------------------------------------------------------------
    # Apply diff
    # ------------------------------------------------------------------
    def apply_diff(
        self,
        diff: KnowledgeDiff,
        approved_block_ids: list[int],
        edited_blocks: dict[int, DiffBlock] | None = None,
        commit: bool = True,
    ) -> AppliedResult:
        return apply_blocks(
            target_repo=self.target_repo,
            diff=diff,
            approved_block_ids=approved_block_ids,
            edited_blocks=edited_blocks,
            commit=commit,
            commit_author=self.commit_author,
            commit_message=f"meeting: applied diff {diff.meeting_id}",
        )


__all__ = ["ClaudeCodeAdapter"]
