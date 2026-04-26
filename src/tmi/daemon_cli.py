"""Subprocess CLI surface used by the Rust daemon (`app/src-tauri/src/daemon.rs`).

The daemon shells out to ``python -m tmi.daemon_cli <subcommand>`` rather
than reimplementing the timeline / cursors / briefs logic in Rust. That keeps
the source-of-truth for the RMS in one place and the Rust binary stays a
"supervisor".

Subcommands::

    python -m tmi.daemon_cli index-rebuild       --memory-root <path>
    python -m tmi.daemon_cli alerts-refresh      --memory-root <path>
    python -m tmi.daemon_cli alignment-snapshot  --memory-root <path>
    python -m tmi.daemon_cli brief-today         --memory-root <path> [--date YYYY-MM-DD]
    python -m tmi.daemon_cli daemon-status       --memory-root <path>
    python -m tmi.daemon_cli route-file          --memory-root <path> --file <file>

Exit code 0 on success; non-zero on any error. Stdout is reserved for
machine-readable JSON snapshots; stderr for human-readable diagnostics.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from .briefs import generate_today, refresh_pending, write_status_snapshot
from .cursors import compute_alignment, write_alignment_history
from .event_router import process as route_process
from .event_router import rebuild_index
from .utils import SHANGHAI


def _emit(payload: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    sys.stdout.flush()


def _now_iso() -> str:
    return datetime.now(tz=SHANGHAI).isoformat(timespec="seconds")


def _handle_index_rebuild(memory_root: Path) -> int:
    idx = rebuild_index(memory_root)
    events_obj = idx.get("events", [])
    n = len(events_obj) if isinstance(events_obj, list) else 0
    _emit({"op": "index-rebuild", "events": n, "ts": _now_iso()})
    return 0


def _handle_alerts_refresh(memory_root: Path) -> int:
    p = refresh_pending(memory_root)
    _emit({"op": "alerts-refresh", "path": str(p), "ts": _now_iso()})
    return 0


def _handle_alignment_snapshot(memory_root: Path) -> int:
    snap = compute_alignment(memory_root)
    write_alignment_history(memory_root, snap)
    _emit({"op": "alignment-snapshot", "snapshot": snap})
    return 0


def _handle_brief_today(memory_root: Path, date_iso: str | None) -> int:
    p = generate_today(memory_root, date_iso=date_iso)
    _emit({"op": "brief-today", "path": str(p), "ts": _now_iso()})
    return 0


def _handle_daemon_status(memory_root: Path) -> int:
    p = write_status_snapshot(
        memory_root,
        last_heartbeat=_now_iso(),
        last_pull=None,
        last_brief=None,
        errors=[],
    )
    _emit({"op": "daemon-status", "path": str(p)})
    return 0


def _handle_route_file(memory_root: Path, file: Path) -> int:
    res = route_process(memory_root, file)
    _emit(
        {
            "op": "route-file",
            "events": len(res.events),
            "skipped": res.skipped,
            "timeline_files": len(set(res.timeline_writes)),
            "entity_files": len(set(res.entity_writes)),
        }
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tmi.daemon_cli")
    parser.add_argument("subcommand", choices=[
        "index-rebuild",
        "alerts-refresh",
        "alignment-snapshot",
        "brief-today",
        "daemon-status",
        "route-file",
    ])
    parser.add_argument("--memory-root", type=Path, required=True)
    parser.add_argument("--date", type=str, default=None)
    parser.add_argument("--file", type=Path, default=None)
    args = parser.parse_args(argv)

    memory_root = args.memory_root
    memory_root.mkdir(parents=True, exist_ok=True)

    try:
        if args.subcommand == "index-rebuild":
            return _handle_index_rebuild(memory_root)
        if args.subcommand == "alerts-refresh":
            return _handle_alerts_refresh(memory_root)
        if args.subcommand == "alignment-snapshot":
            return _handle_alignment_snapshot(memory_root)
        if args.subcommand == "brief-today":
            return _handle_brief_today(memory_root, args.date)
        if args.subcommand == "daemon-status":
            return _handle_daemon_status(memory_root)
        if args.subcommand == "route-file":
            if args.file is None:
                print("error: --file required for route-file", file=sys.stderr)
                return 2
            return _handle_route_file(memory_root, args.file)
    except Exception as e:  # noqa: BLE001 — daemon needs a non-zero exit code
        print(f"error: {args.subcommand} failed: {e}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
