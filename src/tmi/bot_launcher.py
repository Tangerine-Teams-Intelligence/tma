"""Spawn the Discord bot as a detached subprocess.

Spec: INTERFACES.md §5.1.

Bot is owned by D3 (separate package at `bot/`). We just invoke it with the contract
flags. If `TMI_BOT_MODE=stub`, we skip Node spawn entirely (test fixtures drive
transcript writes instead — see spec §12.1).
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

from .config import Config

logger = logging.getLogger(__name__)


def _bot_entry(repo_root: Path) -> Path:
    """Path to bot/dist/index.js. Spec §5.1."""
    return repo_root / "bot" / "dist" / "index.js"


def _find_repo_root(start: Path) -> Path:
    """Walk up to find pyproject.toml's directory."""
    for p in (start, *start.parents):
        if (p / "pyproject.toml").exists():
            return p
    return start


def spawn_bot(
    cfg: Config,
    cfg_path: Path,
    meeting_id: str,
    meeting_dir: Path,
    *,
    node_path: str = "node",
) -> Optional[subprocess.Popen[bytes]]:
    """Start the bot. Returns Popen, or None if `TMI_BOT_MODE=stub`.

    Bot stdout/stderr go to <meeting_dir>/.tmi/bot.log (spec §5.1).
    """
    if os.environ.get("TMI_BOT_MODE") == "stub":
        logger.info("TMI_BOT_MODE=stub; skipping bot spawn")
        return None

    repo_root = _find_repo_root(meeting_dir)
    entry = _bot_entry(repo_root)
    if not entry.exists():
        # Try CWD as fallback
        alt = Path.cwd() / "bot" / "dist" / "index.js"
        if alt.exists():
            entry = alt
        else:
            raise FileNotFoundError(
                f"bot entry not found: {entry}; build with `cd bot && npm run build`"
            )

    log_path = meeting_dir / ".tmi" / "bot.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_fp = open(log_path, "ab")

    cmd = [
        node_path,
        str(entry),
        "--meeting-id",
        meeting_id,
        "--meeting-dir",
        str(meeting_dir),
        "--config",
        str(cfg_path),
    ]
    logger.info("spawning bot: %s", " ".join(cmd))

    creationflags = 0
    if sys.platform == "win32":
        # DETACHED_PROCESS | CREATE_NO_WINDOW — survives parent exit
        creationflags = 0x00000008 | 0x08000000  # DETACHED_PROCESS | CREATE_NO_WINDOW

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=log_fp,
        stderr=log_fp,
        env=os.environ.copy(),
        creationflags=creationflags,
        close_fds=(sys.platform != "win32"),
    )
    return proc


__all__ = ["spawn_bot"]
