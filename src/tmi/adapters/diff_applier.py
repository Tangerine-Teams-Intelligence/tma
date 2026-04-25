"""Apply approved DiffBlocks to a target git repo.

Behavior contract (INTERFACES.md §7.3, §8.2, §10.5):
- All paths are joined under ``target_repo`` and validated to stay inside it.
- Refuses to write if any *target file* has uncommitted changes.
- All file writes are atomic: write to ``<path>.tmp``, then ``Path.replace``.
- After all blocks are applied, optionally ``git add`` + ``git commit``. Never
  ``git push``.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path, PurePosixPath

from git import Repo
from git.exc import InvalidGitRepositoryError

from .types import AppliedResult, DiffBlock, KnowledgeDiff


class DiffApplyError(RuntimeError):
    """Internal — surfaces as messages in AppliedResult, not raised to caller."""


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
def apply_blocks(
    target_repo: Path,
    diff: KnowledgeDiff,
    approved_block_ids: list[int],
    edited_blocks: dict[int, DiffBlock] | None,
    commit: bool,
    commit_author: str,
    commit_message: str | None = None,
) -> AppliedResult:
    target_repo = target_repo.resolve()
    edited_blocks = edited_blocks or {}
    messages: list[str] = []

    # No-op short-circuit (INTERFACES.md §7.3 idempotence requirement).
    if not approved_block_ids:
        return AppliedResult(
            written_files=[],
            commit_sha=None,
            skipped_block_ids=[],
            messages=["no approved blocks; nothing to apply"],
        )

    # ---- repo guards -------------------------------------------------
    try:
        repo = Repo(target_repo)
    except InvalidGitRepositoryError as e:
        raise ValueError(f"target_repo is not a git repository: {target_repo}") from e

    # Resolve approved blocks (apply edits if present).
    approved: list[DiffBlock] = []
    by_id = {b.id: b for b in diff.blocks}
    for bid in approved_block_ids:
        if bid in edited_blocks:
            approved.append(edited_blocks[bid])
        elif bid in by_id:
            approved.append(by_id[bid])
        else:
            messages.append(f"approved block id {bid} not found in diff; skipped")

    # Validate all target paths up front (path-escape + collect set).
    target_files: set[str] = set()
    for block in approved:
        try:
            _validate_relative_path(block.target_file)
        except ValueError as e:
            raise ValueError(f"block {block.id}: {e}") from e
        target_files.add(block.target_file)

    # Refuse to write if any of the affected files are dirty (§10.5).
    dirty = _dirty_target_files(repo, target_files)
    if dirty:
        return AppliedResult(
            written_files=[],
            commit_sha=None,
            skipped_block_ids=[b.id for b in approved],
            messages=[
                "uncommitted changes in target_repo touching: "
                + ", ".join(sorted(dirty)),
            ],
        )

    # ---- apply each block --------------------------------------------
    written: list[str] = []
    skipped: list[int] = []
    for block in approved:
        try:
            _apply_one(target_repo, block)
            if block.target_file not in written:
                written.append(block.target_file)
            messages.append(f"block {block.id}: applied to {block.target_file}")
        except DiffApplyError as e:
            skipped.append(block.id)
            messages.append(f"block {block.id}: skipped — {e}")

    if not written:
        return AppliedResult(
            written_files=[],
            commit_sha=None,
            skipped_block_ids=skipped,
            messages=messages,
        )

    # ---- stage + commit ---------------------------------------------
    repo.index.add(written)
    commit_sha: str | None = None
    if commit:
        author_name, author_email = _split_author(commit_author)
        msg = commit_message or f"meeting: applied {len(written)} block(s) from TMA diff"
        c = repo.index.commit(
            msg,
            author=_actor(author_name, author_email),
            committer=_actor(author_name, author_email),
        )
        commit_sha = c.hexsha

    return AppliedResult(
        written_files=written,
        commit_sha=commit_sha,
        skipped_block_ids=skipped,
        messages=messages,
    )


# ---------------------------------------------------------------------------
# Per-action implementations
# ---------------------------------------------------------------------------
def _apply_one(target_repo: Path, block: DiffBlock) -> None:
    abs_path = target_repo / Path(block.target_file)
    if block.action == "create":
        if abs_path.exists():
            raise DiffApplyError(f"target {block.target_file} already exists (action=create)")
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        # body is the raw new file content (markdown)
        new_content = block.body
        if not new_content.endswith("\n"):
            new_content += "\n"
        _atomic_write(abs_path, new_content)
        return

    if not abs_path.exists():
        raise DiffApplyError(f"target file does not exist: {block.target_file}")

    current = abs_path.read_text(encoding="utf-8")

    if block.action == "append":
        added_lines = _extract_plus_lines(block.body)
        if not added_lines:
            raise DiffApplyError("append action has no '+ ' lines in body")
        if current and not current.endswith("\n"):
            current += "\n"
        new_content = current + "\n".join(added_lines) + "\n"
        _atomic_write(abs_path, new_content)
        return

    if block.action == "insert":
        if not block.insert_anchor:
            raise DiffApplyError("insert requires insert_anchor")
        added_lines = _extract_plus_lines(block.body)
        if not added_lines:
            raise DiffApplyError("insert action has no '+ ' lines in body")
        new_content = _insert_after_anchor(current, block.insert_anchor, added_lines)
        _atomic_write(abs_path, new_content)
        return

    if block.action == "replace":
        new_content = _apply_unified_replace(current, block.body)
        _atomic_write(abs_path, new_content)
        return

    raise DiffApplyError(f"unknown action: {block.action}")


def _extract_plus_lines(body: str) -> list[str]:
    """Pull `+ ...` lines out of a diff body, stripping the leading `+ ` marker.

    A leading `+` followed by either a single space or end-of-line counts.
    Lines that don't start with `+` are ignored (context lines are unusual in
    append/insert blocks but tolerated).
    """
    out: list[str] = []
    for line in body.split("\n"):
        if line.startswith("+ "):
            out.append(line[2:])
        elif line == "+":
            out.append("")
    return out


def _insert_after_anchor(current: str, anchor: str, new_lines: list[str]) -> str:
    lines = current.split("\n")
    # Note: split on "\n" yields a trailing "" if file ends with "\n". We want
    # to preserve that.
    matches = [i for i, ln in enumerate(lines) if ln == anchor]
    if not matches:
        raise DiffApplyError(f"anchor not found: {anchor!r}")
    if len(matches) > 1:
        raise DiffApplyError(f"anchor matches {len(matches)} lines (must be unique): {anchor!r}")
    idx = matches[0]
    before = lines[: idx + 1]
    after = lines[idx + 1 :]
    return "\n".join(before + new_lines + after)


def _apply_unified_replace(current: str, body: str) -> str:
    """Apply a tiny unified-diff-flavored replace.

    Body format (per §8.2): lines starting with ``- `` are the to-remove block,
    lines starting with ``+ `` are the to-add block, others are context.
    Implementation: locate the "- " block (joined into a string) inside
    ``current`` and replace with the "+ " block. Errors on absence or multiple
    matches.
    """
    minus: list[str] = []
    plus: list[str] = []
    for line in body.split("\n"):
        if line.startswith("- "):
            minus.append(line[2:])
        elif line == "-":
            minus.append("")
        elif line.startswith("+ "):
            plus.append(line[2:])
        elif line == "+":
            plus.append("")
    if not minus:
        raise DiffApplyError("replace action has no '- ' lines")

    needle = "\n".join(minus)
    replacement = "\n".join(plus)
    count = current.count(needle)
    if count == 0:
        raise DiffApplyError("replace target not found in file")
    if count > 1:
        raise DiffApplyError(f"replace target ambiguous ({count} matches)")
    return current.replace(needle, replacement, 1)


# ---------------------------------------------------------------------------
# Filesystem + git helpers
# ---------------------------------------------------------------------------
def _validate_relative_path(rel: str) -> None:
    if not rel:
        raise ValueError("empty target_file")
    if rel.startswith("/") or "\\" in rel:
        raise ValueError(f"target_file must be a relative POSIX path: {rel!r}")
    pp = PurePosixPath(rel)
    if pp.is_absolute() or any(part == ".." for part in pp.parts):
        raise ValueError(f"target_file escapes target_repo: {rel!r}")


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        Path(tmp).replace(path)
    except Exception:
        # Cleanup on failure.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _dirty_target_files(repo: Repo, target_files: set[str]) -> set[str]:
    """Return the subset of target_files that show uncommitted changes."""
    porcelain = repo.git.status("--porcelain")
    if not porcelain:
        return set()
    dirty: set[str] = set()
    for line in porcelain.splitlines():
        # First two chars are status, then space, then path.
        if len(line) < 4:
            continue
        path = line[3:].strip()
        # Handle rename "old -> new" by taking the new path.
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        # Quoted paths (with special chars) are wrapped in "..." — strip.
        path = path.strip('"')
        # Normalize to POSIX for comparison.
        path = path.replace("\\", "/")
        if path in target_files:
            dirty.add(path)
    return dirty


def _split_author(author: str) -> tuple[str, str]:
    """``"Name <email>"`` -> (name, email). Falls back gracefully."""
    if "<" in author and author.endswith(">"):
        name, _, rest = author.partition("<")
        return name.strip(), rest[:-1].strip()
    return author.strip(), "tma@tangerine.local"


def _actor(name: str, email: str):  # type: ignore[no-untyped-def]
    from git import Actor

    return Actor(name, email)


__all__ = ["apply_blocks", "DiffApplyError"]
