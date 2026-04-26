"""Tests for tmi.daemon_cli (the subprocess CLI used by the Rust daemon)."""

from __future__ import annotations

import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from tmi.daemon_cli import main
from tmi.event_router import (
    Event,
    EventRefs,
    emit,
    make_event_id,
    sidecar_dir,
)


def _capture(argv: list[str]) -> tuple[int, dict[str, object]]:
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = main(argv)
    out = buf.getvalue().strip()
    parsed = json.loads(out) if out else {}
    return rc, parsed


def _seed_event(memory: Path) -> Event:
    ev = Event(
        id=make_event_id("a", "comment", "x", "2026-04-26T09:00:00+08:00"),
        ts="2026-04-26T09:00:00+08:00",
        source="system",
        actor="daizhe",
        actors=["daizhe"],
        kind="comment",
        refs=EventRefs(),
        body="seed",
    )
    emit(memory, [ev])
    return ev


def test_cli_index_rebuild_runs(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    _seed_event(memory)
    rc, payload = _capture(["index-rebuild", "--memory-root", str(memory)])
    assert rc == 0
    assert payload["op"] == "index-rebuild"
    assert payload["events"] >= 1


def test_cli_alerts_refresh_writes_file(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    _seed_event(memory)
    rc, payload = _capture(["alerts-refresh", "--memory-root", str(memory)])
    assert rc == 0
    assert Path(str(payload["path"])).exists()


def test_cli_alignment_snapshot_emits_snapshot(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    _seed_event(memory)
    rc, payload = _capture(["alignment-snapshot", "--memory-root", str(memory)])
    assert rc == 0
    assert payload["op"] == "alignment-snapshot"
    assert "snapshot" in payload
    snap = payload["snapshot"]
    assert "rate" in snap
    assert "total_atoms" in snap


def test_cli_brief_today_writes_brief(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    _seed_event(memory)
    rc, payload = _capture(
        ["brief-today", "--memory-root", str(memory), "--date", "2026-04-26"]
    )
    assert rc == 0
    assert Path(str(payload["path"])).exists()


def test_cli_daemon_status_writes_sidecar(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    rc, payload = _capture(["daemon-status", "--memory-root", str(memory)])
    assert rc == 0
    p = Path(str(payload["path"]))
    assert p == sidecar_dir(memory) / "daemon-status.json"
    assert p.exists()


def test_cli_route_file_routes(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    src = memory / "meetings" / "2026-04-26-x.md"
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_text(
        "---\ndate: 2026-04-26\ntitle: x\nparticipants:\n- ana\n"
        "meeting_id: 2026-04-26-x\n---\n\n## Transcript\n\n[10:00:00] ana: hi\n",
        encoding="utf-8",
    )
    rc, payload = _capture(
        ["route-file", "--memory-root", str(memory), "--file", str(src)]
    )
    assert rc == 0
    assert payload["events"] >= 2  # at least chunk + summary
    assert (memory / "timeline" / "2026-04-26.md").exists()


def test_cli_route_file_requires_file(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    # No --file passed → exits 2
    rc = main(["route-file", "--memory-root", str(memory)])
    assert rc == 2


def test_cli_unknown_subcommand_exits_nonzero(tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        # argparse rejects unknown choice → SystemExit
        main(["nope", "--memory-root", str(tmp_path)])
