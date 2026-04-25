"""Prep-mode driver — interactive turn-by-turn passthrough.

Spec: INTERFACES.md §6.2. Distinct I/O loop: relays user stdin to subprocess stdin,
prints subprocess stdout to user. On `done` (user) or turn limit, captures the LAST
fenced JSON block from the model's output and validates it as an intent.

Owns its own loop — does not share with observe/wrap.
"""

from __future__ import annotations

import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

from ..config import Config
from ..meeting import Meeting
from . import _spawn_claude, extract_fenced_json_blocks, write_json_envelope


def _drain_to_buffer(proc: subprocess.Popen[bytes], buf: list[bytes], stop: threading.Event) -> None:
    """Read subprocess stdout in a thread; mirror to user stdout, accumulate for parsing.

    Threading instead of select() because Windows lacks select() on pipes.
    """
    assert proc.stdout is not None
    while not stop.is_set():
        line = proc.stdout.readline()
        if not line:
            break
        buf.append(line)
        try:
            sys.stdout.buffer.write(line)
            sys.stdout.flush()
        except (BrokenPipeError, OSError):
            break


def run_prep(
    cfg: Config,
    meeting_dir: Path,
    meeting: Meeting,
    alias: str,
    *,
    ground_truth: dict[str, Any],
    turn_limit: int = 20,
    mock: bool = False,
) -> str:
    """Run interactive prep session. Returns the final intent markdown.

    Raises RuntimeError on subprocess failure or missing/invalid JSON output.
    """
    proc = _spawn_claude(cfg, "prep", meeting_dir, mock=mock)

    if proc.stdin is None or proc.stdout is None:
        raise RuntimeError("claude subprocess stdin/stdout not available")

    # First turn: send envelope (per §6.2)
    envelope = {
        "mode": "prep",
        "meeting": meeting.model_dump(mode="json"),
        "alias": alias,
        "ground_truth": ground_truth,
    }
    try:
        write_json_envelope(proc.stdin, envelope)
    except (BrokenPipeError, OSError) as e:
        proc.kill()
        raise RuntimeError(f"failed to send prep envelope: {e}") from e

    # Output collection thread
    out_buf: list[bytes] = []
    stop_evt = threading.Event()
    out_thread = threading.Thread(
        target=_drain_to_buffer, args=(proc, out_buf, stop_evt), daemon=True
    )
    out_thread.start()

    sys.stderr.write(
        f"\n[prep] subprocess started (pid={proc.pid}). Type messages; `done` to finalize.\n"
    )
    sys.stderr.flush()

    turn = 0
    try:
        while turn < turn_limit:
            try:
                line = sys.stdin.readline()
            except KeyboardInterrupt:
                sys.stderr.write("\n[prep] interrupted; finalizing\n")
                break
            if not line:
                break
            line_s = line.strip()
            if line_s.lower() in {"done", ":done", "/done", "exit", "quit"}:
                break
            try:
                proc.stdin.write(line.encode("utf-8"))
                proc.stdin.flush()
            except (BrokenPipeError, OSError) as e:
                sys.stderr.write(f"[prep] subprocess closed: {e}\n")
                break
            turn += 1
        else:
            sys.stderr.write(f"\n[prep] turn limit ({turn_limit}) reached; finalizing\n")
    finally:
        # Signal end-of-input to model so it produces final block
        try:
            proc.stdin.close()
        except OSError:
            pass

    # Wait briefly for model to flush final output
    try:
        proc.wait(timeout=cfg.claude.default_timeout_seconds)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)
    stop_evt.set()
    out_thread.join(timeout=2)

    full_out = b"".join(out_buf).decode("utf-8", errors="replace")
    blocks = extract_fenced_json_blocks(full_out)
    if not blocks:
        raise RuntimeError(
            "prep subprocess produced no fenced JSON block; see .tmi/observer.log"
        )

    final = blocks[-1]
    if not isinstance(final, dict) or "intent_markdown" not in final:
        raise RuntimeError(
            f"prep subprocess final JSON missing 'intent_markdown' key: {final!r}"
        )
    md = final["intent_markdown"]
    if not isinstance(md, str):
        raise RuntimeError("prep subprocess returned non-string intent_markdown")
    return md


__all__ = ["run_prep"]
