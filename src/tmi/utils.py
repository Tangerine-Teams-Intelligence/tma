"""Shared utilities: atomic writes, lock files, logging, timestamps."""

from __future__ import annotations

import logging
import os
import re
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

# Asia/Shanghai is +08:00 fixed offset (no DST). Use a fixed tzinfo so we don't
# depend on the OS tz database (which is patchy on Windows without tzdata).
from datetime import timedelta

SHANGHAI = timezone(timedelta(hours=8), name="Asia/Shanghai")


def now_iso() -> str:
    """RFC 3339 timestamp in Asia/Shanghai (+08:00)."""
    return datetime.now(tz=SHANGHAI).isoformat(timespec="seconds")


def now_dt() -> datetime:
    return datetime.now(tz=SHANGHAI)


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s)


def slugify(text: str) -> str:
    """Lowercase ASCII slug for meeting IDs. Non-ASCII collapsed to '-'."""
    s = text.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    if not s:
        s = "meeting"
    return s


def atomic_write_text(path: Path, content: str, encoding: str = "utf-8") -> None:
    """Write text atomically: write to .tmp + rename. Cross-platform safe."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=path.name + ".",
        suffix=".tmp",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding=encoding, newline="\n") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        # On Windows, os.replace handles existing target atomically.
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def append_text(path: Path, content: str, encoding: str = "utf-8") -> None:
    """Append-with-fsync. Used for transcript / observations."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding=encoding, newline="\n") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())


def pid_alive(pid: int) -> bool:
    """Cross-platform 'is this PID alive?' check."""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        try:
            import ctypes

            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not handle:
                return False
            exit_code = ctypes.c_ulong()
            still_active = 259
            kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
            kernel32.CloseHandle(handle)
            return exit_code.value == still_active
        except Exception:
            return False
    else:
        try:
            os.kill(pid, 0)
            return True
        except (OSError, ProcessLookupError):
            return False


@contextmanager
def meeting_lock(meeting_dir: Path) -> Iterator[None]:
    """Acquire .tmi/lock for this meeting. Stale locks (dead PID) are reclaimed.

    Per INTERFACES.md §10.6: lock contains current PID. If PID dead, warn + take over.
    """
    lock_path = meeting_dir / ".tmi" / "lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    if lock_path.exists():
        try:
            existing = int(lock_path.read_text(encoding="utf-8").strip())
        except (ValueError, OSError):
            existing = -1
        if existing > 0 and pid_alive(existing):
            raise RuntimeError(
                f"meeting {meeting_dir.name} is locked by PID {existing}; "
                f"refusing to start (exit 1)"
            )
        else:
            logging.warning("stale lock for PID %s; cleaning up", existing)
            try:
                lock_path.unlink()
            except OSError:
                pass

    atomic_write_text(lock_path, str(os.getpid()))
    try:
        yield
    finally:
        try:
            if lock_path.exists():
                # Only release if we still own it.
                try:
                    owner = int(lock_path.read_text(encoding="utf-8").strip())
                except (ValueError, OSError):
                    owner = -1
                if owner == os.getpid():
                    lock_path.unlink()
        except OSError:
            pass


def setup_logging(level: str = "info", logfile: Path | None = None) -> None:
    levels = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING, "error": logging.ERROR}
    lvl = levels.get(level.lower(), logging.INFO)
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]
    if logfile is not None:
        try:
            logfile.parent.mkdir(parents=True, exist_ok=True)
            handlers.append(logging.FileHandler(logfile, encoding="utf-8"))
        except OSError:
            pass
    logging.basicConfig(
        level=lvl,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
        force=True,
    )


__all__ = [
    "SHANGHAI",
    "now_iso",
    "now_dt",
    "parse_iso",
    "slugify",
    "atomic_write_text",
    "append_text",
    "pid_alive",
    "meeting_lock",
    "setup_logging",
]
