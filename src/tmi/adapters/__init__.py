"""TMA output adapters.

Public entry points are deliberately small — D1's CLI imports only what's
listed in ``__all__``. Importing this module performs no I/O.
"""
from __future__ import annotations

from .base import OutputAdapter
from .claude_code import ClaudeCodeAdapter
from .diff_parser import DiffParseError, parse_diff, serialize_diff
from .types import (
    AppliedResult,
    DiffAction,
    DiffBlock,
    GroundTruth,
    Intent,
    KnowledgeDiff,
    KnowledgeFile,
    Summary,
    Transcript,
)

__all__ = [
    "OutputAdapter",
    "ClaudeCodeAdapter",
    "parse_diff",
    "serialize_diff",
    "DiffParseError",
    "AppliedResult",
    "DiffAction",
    "DiffBlock",
    "GroundTruth",
    "Intent",
    "KnowledgeDiff",
    "KnowledgeFile",
    "Summary",
    "Transcript",
]
