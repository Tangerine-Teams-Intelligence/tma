"""Detached daemon entry point — runs the observe loop until killed.

Spawned by `tmi start` / `tmi observe`. Single concern: drive observer/observe.run_observe
for a given meeting until the parent CLI signals stop (or process is killed).

Run via: python -m tmi.observer_daemon --meeting-id <id> --config <path>
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import threading
from pathlib import Path

from .config import load_config
from .meeting import load_meeting, meeting_dir
from .observer.observe import run_observe
from .utils import setup_logging


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--meeting-id", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--mock-claude", action="store_true")
    args = ap.parse_args()

    cfg = load_config(Path(args.config))
    setup_logging(cfg.logging.level, cfg.logfile_path())
    log = logging.getLogger("tmi.observer-daemon")

    mdir = meeting_dir(cfg, args.meeting_id)
    m = load_meeting(mdir)

    stop_event = threading.Event()

    def _on_signal(signum, _frame):
        log.info("daemon got signal %s; stopping", signum)
        stop_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _on_signal)
        except (ValueError, OSError):
            pass

    log.info("observer daemon starting for %s", args.meeting_id)
    try:
        run_observe(cfg, mdir, m, stop_event=stop_event, mock=args.mock_claude)
    except Exception as e:
        log.exception("observer daemon crashed: %s", e)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
