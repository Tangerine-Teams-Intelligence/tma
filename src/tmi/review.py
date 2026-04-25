"""Interactive review TUI for knowledge-diff.md blocks.

Spec: INTERFACES.md §4.7. Parses diff blocks via the adapter, presents each, accepts
[a]pprove / [r]eject / [e]dit / [s]kip / [q]uit, persists choices to status.yaml.review.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from rich.console import Console
from rich.panel import Panel
from rich.text import Text

from .state import load_status, save_status
from .utils import atomic_write_text

console = Console()


@dataclass
class ReviewOutcome:
    approved: list[int]
    rejected: list[int]
    edited: dict[int, str]  # block_id -> new body text
    skipped: list[int]
    quit_early: bool


def _render_block(block, idx: int, total: int) -> None:
    header = (
        f"Block {idx}/{total}  ·  {block.target_file}  ·  {block.action}"
    )
    refs = ", ".join(block.transcript_refs) if block.transcript_refs else "(none)"
    panel_body = Text()
    panel_body.append(f"Reason: {block.reason}\n", style="bold")
    panel_body.append(f"Refs:   {refs}\n", style="dim")
    panel_body.append("─" * 60 + "\n", style="dim")
    # Color +/- lines
    for line in block.body.splitlines():
        if line.startswith("+ ") or line.startswith("+"):
            panel_body.append(line + "\n", style="green")
        elif line.startswith("- "):
            panel_body.append(line + "\n", style="red")
        else:
            panel_body.append(line + "\n")
    console.print(Panel(panel_body, title=header, border_style="cyan"))


def _edit_block_body(initial_body: str) -> str:
    """Open $EDITOR on a tempfile preloaded with `initial_body`, return saved content."""
    editor = os.environ.get("EDITOR") or os.environ.get("VISUAL")
    if not editor:
        editor = "notepad" if sys.platform == "win32" else "vi"
    fd, tmp_name = tempfile.mkstemp(suffix=".md", prefix="tmi-edit-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(initial_body)
        rc = subprocess.call([editor, tmp_name])
        if rc != 0:
            console.print(f"[yellow]editor exited with code {rc}; keeping original[/]")
            return initial_body
        with open(tmp_name, encoding="utf-8") as f:
            return f.read()
    finally:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass


def review_loop(
    meeting_dir: Path,
    blocks,  # list[DiffBlock]
    *,
    auto_approve_all: bool = False,
) -> ReviewOutcome:
    """Run the interactive loop. Returns aggregated outcome.

    `auto_approve_all` is for the test contract (spec §12.5 step 7).
    """
    status = load_status(meeting_dir)
    already_decided = (
        set(status.review.approved_block_ids)
        | set(status.review.rejected_block_ids)
        | set(status.review.edited_block_ids)
    )

    approved: list[int] = list(status.review.approved_block_ids)
    rejected: list[int] = list(status.review.rejected_block_ids)
    edited: dict[int, str] = {}
    skipped: list[int] = []
    quit_early = False

    pending = [b for b in blocks if b.id not in already_decided]
    total = len(blocks)

    if not pending:
        console.print("[green]All blocks already reviewed.[/]")
        return ReviewOutcome(approved, rejected, edited, skipped, False)

    for block in pending:
        if quit_early:
            skipped.append(block.id)
            continue
        _render_block(block, block.id, total)

        if auto_approve_all:
            approved.append(block.id)
            continue

        while True:
            console.print(
                "[bold]\\[a]pprove  \\[r]eject  \\[e]dit  \\[s]kip  \\[q]uit[/]"
            )
            try:
                choice = input("> ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                quit_early = True
                break
            if choice in {"a", "approve"}:
                approved.append(block.id)
                break
            if choice in {"r", "reject"}:
                rejected.append(block.id)
                break
            if choice in {"e", "edit"}:
                new_body = _edit_block_body(block.body)
                edited[block.id] = new_body
                approved.append(block.id)  # edit implies approve-with-edits
                break
            if choice in {"s", "skip"}:
                skipped.append(block.id)
                break
            if choice in {"q", "quit"}:
                quit_early = True
                break
            console.print("[yellow]unrecognized; pick a/r/e/s/q[/]")

    # Persist to status.yaml
    status.review.approved_block_ids = sorted(set(approved))
    status.review.rejected_block_ids = sorted(set(rejected))
    status.review.edited_block_ids = sorted(set(edited.keys()))
    save_status(meeting_dir, status)

    return ReviewOutcome(
        approved=sorted(set(approved)),
        rejected=sorted(set(rejected)),
        edited=edited,
        skipped=skipped,
        quit_early=quit_early,
    )


def apply_decisions_dict(
    meeting_dir: Path,
    blocks,  # list[DiffBlock]
    decisions: dict,
) -> ReviewOutcome:
    """Persist a batch of decisions from a JSON payload.

    Used by `tmi review --json --apply-decisions <path>` (the desktop app
    contract). Mirrors `review_loop` semantics: edits imply approve-with-edits;
    skipped blocks are left pending. Status is read-modify-written.

    Args:
        decisions: ``{"approved": [1,3], "rejected": [2], "edited": {"4": "body"}}``.
                   Edited keys may be int or str. Both list orderings are accepted.

    Raises:
        ValueError: if a referenced block id is not present in `blocks`.
    """
    block_ids = {b.id for b in blocks}

    approved_in = list(decisions.get("approved", []) or [])
    rejected_in = list(decisions.get("rejected", []) or [])
    edited_in_raw = decisions.get("edited", {}) or {}
    edited_in: dict[int, str] = {}
    for k, v in edited_in_raw.items():
        try:
            bid = int(k)
        except (TypeError, ValueError) as e:
            raise ValueError(f"edited key {k!r} not an integer") from e
        edited_in[bid] = str(v)

    referenced = set(approved_in) | set(rejected_in) | set(edited_in.keys())
    unknown = referenced - block_ids
    if unknown:
        raise ValueError(f"decisions reference unknown block ids: {sorted(unknown)}")

    # An edited block is implicitly approved (matches interactive behavior).
    approved_set = set(approved_in) | set(edited_in.keys())
    rejected_set = set(rejected_in)
    overlap = approved_set & rejected_set
    if overlap:
        raise ValueError(f"block ids both approved and rejected: {sorted(overlap)}")

    # Merge with any prior decisions persisted in status.yaml (idempotent).
    status = load_status(meeting_dir)
    approved_set |= set(status.review.approved_block_ids)
    rejected_set |= set(status.review.rejected_block_ids)
    # Re-resolve overlap after merge (caller may have flipped a decision).
    rejected_set -= approved_set

    edited_ids = sorted(set(status.review.edited_block_ids) | set(edited_in.keys()))

    status.review.approved_block_ids = sorted(approved_set)
    status.review.rejected_block_ids = sorted(rejected_set)
    status.review.edited_block_ids = edited_ids
    save_status(meeting_dir, status)

    skipped = sorted(block_ids - approved_set - rejected_set)

    return ReviewOutcome(
        approved=sorted(approved_set),
        rejected=sorted(rejected_set),
        edited=edited_in,
        skipped=skipped,
        quit_early=False,
    )


__all__ = ["review_loop", "ReviewOutcome", "apply_decisions_dict"]
