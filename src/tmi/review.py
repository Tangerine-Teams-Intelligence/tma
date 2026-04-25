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


__all__ = ["review_loop", "ReviewOutcome"]
