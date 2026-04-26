"""Observer subprocess: three modes (prep / observe / wrap), three I/O loops.

Per design call: do NOT unify into a shared driver. Prep is interactive raw-passthrough,
observe polls a JSON envelope every 30s, wrap is one-shot.

Only `_spawn_claude` and JSON helpers are shared.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import IO, Any

from ..config import Config

# Resource path for prompts. They are package data; access via Path on the package.
PROMPTS_DIR = Path(__file__).parent / "prompts"


def prompt_path(mode: str) -> Path:
    p = PROMPTS_DIR / f"{mode}.md"
    if not p.exists():
        raise FileNotFoundError(f"observer prompt missing: {p}")
    return p


def claude_cmd(cfg: Config) -> str:
    return cfg.claude.cli_path or "claude"


def _spawn_claude(
    cfg: Config,
    mode: str,
    meeting_dir: Path,
    *,
    extra_args: list[str] | None = None,
    stdin: int | None = subprocess.PIPE,
    stdout: int | None = subprocess.PIPE,
    mock: bool = False,
) -> subprocess.Popen[bytes]:
    """Shared spawn helper. Per INTERFACES.md §6.1.

    `mock=True` runs `python -m tmi.observer.mock_claude <mode>` instead. Useful for
    tests on Windows where the real `claude` binary may not be installed.
    """
    log_path = meeting_dir / ".tmi" / "observer.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_fp = open(log_path, "ab")

    if mock:
        cmd = [sys.executable, "-m", "tmi.observer.mock_claude", mode]
    else:
        cmd = [
            claude_cmd(cfg),
            "--append-system-prompt",
            str(prompt_path(mode)),
            "--no-confirm",
            "--output-format",
            "stream-json",
        ]
        if extra_args:
            cmd.extend(extra_args)

    return subprocess.Popen(
        cmd,
        stdin=stdin,
        stdout=stdout,
        stderr=log_fp,
        env=os.environ.copy(),
    )


# JSON helpers ---------------------------------------------------------------

FENCED_JSON_RE = re.compile(r"```json\s*\n(.*?)\n```", re.DOTALL)


def extract_fenced_json_blocks(text: str) -> list[Any]:
    """Pull every ```json ... ``` block out of a chunk of text. Returns parsed objects.

    Per INTERFACES.md §6.5: the protocol is fenced JSON blocks. Caller decides which
    block(s) to use (prep: last, observe: per-tick, wrap: first two).
    """
    out: list[Any] = []
    for m in FENCED_JSON_RE.finditer(text):
        try:
            out.append(json.loads(m.group(1)))
        except json.JSONDecodeError:
            continue
    return out


def write_json_envelope(stdin_pipe: IO[bytes], envelope: dict[str, Any]) -> None:
    payload = json.dumps(envelope, ensure_ascii=False).encode("utf-8")
    stdin_pipe.write(payload + b"\n")
    stdin_pipe.flush()


__all__ = [
    "PROMPTS_DIR",
    "prompt_path",
    "claude_cmd",
    "_spawn_claude",
    "extract_fenced_json_blocks",
    "write_json_envelope",
    "FENCED_JSON_RE",
]
