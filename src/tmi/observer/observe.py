"""Observe-mode driver — long-poll JSON envelope every 30s.

Spec: INTERFACES.md §6.3. Distinct I/O loop: timer-driven, sends envelope on each
tick, parses fenced JSON response, appends flags to observations.md. Survives tick
timeouts; three consecutive failures -> mark errors[] but keep running.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from ..config import Config
from ..meeting import Meeting
from ..state import add_error, load_status, save_status
from ..transcript import append_observation, window_since
from ..utils import now_iso
from . import _spawn_claude, extract_fenced_json_blocks, write_json_envelope

logger = logging.getLogger(__name__)

POLL_INTERVAL_SEC = 30
WINDOW_SEC = 120  # last 2 minutes per spec
MAX_CONSECUTIVE_FAILS = 3


def format_flag(flag: dict[str, Any]) -> str:
    """Format a flag dict per INTERFACES.md §2.4."""
    now = datetime.now().strftime("%H:%M:%S")
    return (
        f"## [{now}] FLAG: {flag.get('type', 'unknown')}\n"
        f"**Topic**: {flag.get('topic', '')}\n"
        f"**Transcript ref**: {flag.get('transcript_ref', '')}\n"
        f"**Detail**: {flag.get('detail', '')}\n"
        f"**Severity**: {flag.get('severity', 'low')}\n"
    )


def _read_intents_summary(meeting_dir: Path, meeting: Meeting) -> list[dict[str, Any]]:
    """Build a compact summary of locked intents for the envelope."""
    from ..intent import read_intent

    out: list[dict[str, Any]] = []
    for p in meeting.participants:
        try:
            fm, body = read_intent(meeting_dir, p.alias)
        except (FileNotFoundError, ValueError):
            continue
        if not fm.locked:
            continue
        out.append({"alias": p.alias, "topics_markdown": body[:2000]})
    return out


def _last_n_observation_blocks(meeting_dir: Path, n: int = 3) -> list[str]:
    p = meeting_dir / "observations.md"
    if not p.exists():
        return []
    text = p.read_text(encoding="utf-8")
    blocks = [b.strip() for b in text.split("\n---\n") if b.strip()]
    return blocks[-n:]


def run_observe(
    cfg: Config,
    meeting_dir: Path,
    meeting: Meeting,
    *,
    ground_truth_digest: str = "",
    stop_event: threading.Event | None = None,
    mock: bool = False,
) -> None:
    """Spawn observer in observe mode and run the polling loop until stop_event is set
    or the subprocess dies past the retry budget. Blocking call — caller may run in a
    thread or detach in a separate process via tmi start/observe.
    """
    stop = stop_event or threading.Event()
    consecutive_fails = 0
    restarts = 0
    proc = None

    while not stop.is_set():
        if proc is None or proc.poll() is not None:
            if restarts >= 3:
                # Mark failed_observer in status (CLI / state machine)
                status = load_status(meeting_dir)
                add_error(
                    status,
                    "observer",
                    "restart_budget_exceeded",
                    "observer died 3+ times in observe mode",
                )
                save_status(meeting_dir, status)
                logger.error("observer restart budget exhausted")
                return
            proc = _spawn_claude(cfg, "observe", meeting_dir, mock=mock)
            if proc.stdin is None or proc.stdout is None:
                raise RuntimeError("subprocess stdin/stdout missing")
            restarts += 1
            logger.info("observe subprocess (re)started pid=%s", proc.pid)
            # Update status.observer
            status = load_status(meeting_dir)
            status.observer.pid = proc.pid
            status.observer.mode = "observe"
            save_status(meeting_dir, status)

        # Send poll envelope
        envelope = {
            "mode": "observe",
            "tick_at": now_iso(),
            "transcript_window": window_since(meeting_dir, WINDOW_SEC),
            "intents_summary": _read_intents_summary(meeting_dir, meeting),
            "ground_truth_digest": ground_truth_digest,
            "previous_flags": _last_n_observation_blocks(meeting_dir, 3),
        }
        try:
            assert proc.stdin is not None
            write_json_envelope(proc.stdin, envelope)
        except (BrokenPipeError, OSError) as e:
            logger.warning("observe stdin write failed: %s", e)
            consecutive_fails += 1
            if consecutive_fails >= MAX_CONSECUTIVE_FAILS:
                status = load_status(meeting_dir)
                add_error(status, "observer", "stdin_failure", str(e))
                save_status(meeting_dir, status)
                consecutive_fails = 0
            try:
                proc.kill()
            except OSError:
                pass
            proc = None
            if stop.wait(timeout=2):
                return
            continue

        # Read response with timeout
        response = _read_until_block(proc, timeout=cfg.claude.default_timeout_seconds)
        if response is None:
            consecutive_fails += 1
            logger.warning("observe tick produced no response (fails=%d)", consecutive_fails)
            if consecutive_fails >= MAX_CONSECUTIVE_FAILS:
                status = load_status(meeting_dir)
                add_error(status, "observer", "tick_timeout", f"{consecutive_fails} consecutive misses")
                save_status(meeting_dir, status)
                consecutive_fails = 0
        else:
            consecutive_fails = 0
            for flag in response.get("flags", []) or []:
                if isinstance(flag, dict):
                    append_observation(meeting_dir, format_flag(flag))
            status = load_status(meeting_dir)
            from datetime import datetime as _dt

            status.observer.last_poll_at = _dt.fromisoformat(now_iso())
            save_status(meeting_dir, status)

        # Wait for next tick
        if stop.wait(timeout=POLL_INTERVAL_SEC):
            break

    # Cleanup
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except (subprocess.TimeoutExpired, OSError):
            try:
                proc.kill()
            except OSError:
                pass
    status = load_status(meeting_dir)
    status.observer.pid = None
    status.observer.mode = None
    save_status(meeting_dir, status)


def _read_until_block(proc, timeout: float) -> dict[str, Any] | None:
    """Read subprocess stdout until we see a complete fenced JSON block or timeout."""
    import subprocess as _sp

    assert proc.stdout is not None
    deadline = time.monotonic() + timeout
    buf = bytearray()
    while time.monotonic() < deadline:
        # Use a small read with a simple timeout via threading
        chunk = _readline_with_timeout(proc, max(0.5, deadline - time.monotonic()))
        if chunk is None:
            continue
        if chunk == b"":
            return None  # eof
        buf.extend(chunk)
        text = buf.decode("utf-8", errors="replace")
        blocks = extract_fenced_json_blocks(text)
        if blocks:
            last = blocks[-1]
            if isinstance(last, dict):
                return last
    return None


def _readline_with_timeout(proc, timeout: float) -> bytes | None:
    """Cross-platform readline with timeout via thread."""
    result: dict[str, bytes | None] = {"line": None}

    def _read() -> None:
        try:
            assert proc.stdout is not None
            result["line"] = proc.stdout.readline()
        except Exception:
            result["line"] = b""

    t = threading.Thread(target=_read, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        return None
    return result["line"]


# Need this import only when running as separate process
import subprocess  # noqa: E402

__all__ = ["run_observe", "format_flag", "POLL_INTERVAL_SEC", "WINDOW_SEC"]
