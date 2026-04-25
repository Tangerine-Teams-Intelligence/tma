"""transcript.md tail/read helpers.

Spec: INTERFACES.md §2.3.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

from .utils import SHANGHAI


def transcript_path(meeting_dir: Path) -> Path:
    return meeting_dir / "transcript.md"


def observations_path(meeting_dir: Path) -> Path:
    return meeting_dir / "observations.md"


def read_all(meeting_dir: Path) -> str:
    p = transcript_path(meeting_dir)
    if not p.exists():
        return ""
    return p.read_text(encoding="utf-8")


def line_count(meeting_dir: Path) -> int:
    p = transcript_path(meeting_dir)
    if not p.exists():
        return 0
    with open(p, encoding="utf-8") as f:
        return sum(1 for _ in f)


def tail_lines(meeting_dir: Path, n: int) -> list[str]:
    """Return last `n` non-empty lines of transcript.md."""
    p = transcript_path(meeting_dir)
    if not p.exists():
        return []
    with open(p, encoding="utf-8") as f:
        lines = [ln.rstrip("\n") for ln in f if ln.strip()]
    return lines[-n:]


def window_since(meeting_dir: Path, seconds: int) -> str:
    """Return transcript lines whose `[HH:MM:SS]` timestamp is within last N seconds.

    Best-effort — assumes timestamps are wall-clock today in Asia/Shanghai per spec
    §2.3. Lines without a parseable prefix are dropped from the window.
    """
    now = datetime.now(tz=SHANGHAI)
    cutoff = now - timedelta(seconds=seconds)
    p = transcript_path(meeting_dir)
    if not p.exists():
        return ""
    out: list[str] = []
    with open(p, encoding="utf-8") as f:
        for ln in f:
            ln = ln.rstrip("\n")
            if not ln.startswith("["):
                continue
            close = ln.find("]")
            if close < 0:
                continue
            ts = ln[1:close]
            try:
                hh, mm, ss = ts.split(":")
                line_dt = now.replace(hour=int(hh), minute=int(mm), second=int(ss), microsecond=0)
            except (ValueError, AttributeError):
                continue
            if line_dt >= cutoff:
                out.append(ln)
    return "\n".join(out)


def append_transcript_line(meeting_dir: Path, alias: str, text: str) -> None:
    """Append a transcript line in canonical format. Used by tests / FakeBot."""
    from .utils import append_text

    now = datetime.now(tz=SHANGHAI).strftime("%H:%M:%S")
    safe = text.replace("\n", "\u2424")
    append_text(transcript_path(meeting_dir), f"[{now}] {alias}: {safe}\n")


def append_observation(meeting_dir: Path, flag_block: str) -> None:
    """Append an observer flag block (already formatted). Adds `---` separator if needed."""
    from .utils import append_text

    p = observations_path(meeting_dir)
    existing = p.read_text(encoding="utf-8") if p.exists() else ""
    sep = "" if not existing.strip() else "\n---\n\n"
    block = flag_block if flag_block.endswith("\n") else flag_block + "\n"
    append_text(p, sep + block)


__all__ = [
    "transcript_path",
    "observations_path",
    "read_all",
    "line_count",
    "tail_lines",
    "window_since",
    "append_transcript_line",
    "append_observation",
]
