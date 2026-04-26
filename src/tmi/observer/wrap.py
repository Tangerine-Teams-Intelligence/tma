"""Wrap-mode driver — one-shot. Stdin envelope in, two fenced JSON blocks out.

Spec: INTERFACES.md §6.4. Distinct I/O loop: send envelope, close stdin, wait for
process to finish, parse two fenced JSON blocks (summary_markdown + diff_markdown).
Per design call #6 atomic: either both blocks land or neither.
"""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Any

from ..config import Config
from . import _spawn_claude, extract_fenced_json_blocks, write_json_envelope

logger = logging.getLogger(__name__)


class WrapResult:
    def __init__(self, summary_markdown: str, diff_markdown: str) -> None:
        self.summary_markdown = summary_markdown
        self.diff_markdown = diff_markdown


class WrapError(RuntimeError):
    pass


def run_wrap(
    cfg: Config,
    meeting_dir: Path,
    envelope: dict[str, Any],
    *,
    retries: int = 1,
    mock: bool = False,
) -> WrapResult:
    """One-shot wrap. Retries up to `retries` extra times on parse failure.

    Per §10.4: on second failure, write raw output to .tmi/wrap-raw.txt and raise.
    """
    last_err: Exception | None = None
    raw_capture = b""
    for attempt in range(retries + 1):
        try:
            return _attempt(cfg, meeting_dir, envelope, mock=mock)
        except WrapError as e:
            last_err = e
            logger.warning("wrap attempt %d failed: %s", attempt + 1, e)
            # capture raw for debug
            raw_capture = getattr(e, "raw", b"") or b""
            continue

    # Persist raw output for debugging
    if raw_capture:
        debug_path = meeting_dir / ".tmi" / "wrap-raw.txt"
        debug_path.parent.mkdir(parents=True, exist_ok=True)
        debug_path.write_bytes(raw_capture)
    raise WrapError(f"wrap failed after {retries + 1} attempts: {last_err}")


def _attempt(
    cfg: Config,
    meeting_dir: Path,
    envelope: dict[str, Any],
    *,
    mock: bool = False,
) -> WrapResult:
    proc = _spawn_claude(cfg, "wrap", meeting_dir, mock=mock)
    if proc.stdin is None or proc.stdout is None:
        raise WrapError("wrap subprocess stdin/stdout missing")

    try:
        write_json_envelope(proc.stdin, envelope)
    except (BrokenPipeError, OSError) as e:
        proc.kill()
        raise WrapError(f"failed to send wrap envelope: {e}") from e
    finally:
        try:
            proc.stdin.close()
        except OSError:
            pass

    timeout = max(cfg.claude.default_timeout_seconds * 4, 240)
    try:
        out_bytes, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise WrapError("wrap subprocess timed out")

    text = out_bytes.decode("utf-8", errors="replace")
    blocks = extract_fenced_json_blocks(text)
    if len(blocks) < 2:
        err = WrapError(
            f"wrap produced {len(blocks)} fenced JSON block(s); expected 2"
        )
        err.raw = out_bytes  # type: ignore[attr-defined]
        raise err

    summary_obj, diff_obj = blocks[0], blocks[1]
    if not isinstance(summary_obj, dict) or "summary_markdown" not in summary_obj:
        err = WrapError("first JSON block missing 'summary_markdown'")
        err.raw = out_bytes  # type: ignore[attr-defined]
        raise err
    if not isinstance(diff_obj, dict) or "diff_markdown" not in diff_obj:
        err = WrapError("second JSON block missing 'diff_markdown'")
        err.raw = out_bytes  # type: ignore[attr-defined]
        raise err

    summary_md = summary_obj["summary_markdown"]
    diff_md = diff_obj["diff_markdown"]
    if not isinstance(summary_md, str) or not isinstance(diff_md, str):
        err = WrapError("summary_markdown / diff_markdown must be strings")
        err.raw = out_bytes  # type: ignore[attr-defined]
        raise err
    return WrapResult(summary_markdown=summary_md, diff_markdown=diff_md)


__all__ = ["run_wrap", "WrapResult", "WrapError"]
