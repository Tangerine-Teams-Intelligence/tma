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


# ----------------------------------------------------------------------
# emit-atom — Module B (source connector) integration point


def test_cli_emit_atom_via_atom_json_writes_through_router(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    atom = {
        "ts": "2026-04-26T09:30:00+08:00",
        "source": "github",
        "actor": "eric",
        "actors": ["eric", "daizhe"],
        "kind": "pr_event",
        "source_id": "gh:myorg/api:pr-47:opened",
        "body": "**eric** opened PR #47",
        "refs": {
            "people": ["eric", "daizhe"],
            "projects": ["v1-launch"],
            "threads": ["pr-myorg-api-47"],
        },
    }
    rc, payload = _capture([
        "emit-atom",
        "--memory-root", str(memory),
        "--atom-json", json.dumps(atom),
    ])
    assert rc == 0
    assert payload["op"] == "emit-atom"
    assert payload["events"] == 1
    assert payload["id"].startswith("evt-2026-04-26-")
    # Timeline + entity files exist.
    assert (memory / "timeline" / "2026-04-26.md").exists()
    assert (memory / "people" / "eric.md").exists()
    assert (memory / "projects" / "v1-launch.md").exists()
    assert (memory / "threads" / "pr-myorg-api-47.md").exists()


def test_cli_emit_atom_via_atom_file(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    atom_path = tmp_path / "atom.json"
    atom_path.write_text(json.dumps({
        "ts": "2026-04-26T09:30:00+08:00",
        "source": "linear",
        "actor": "daizhe",
        "kind": "ticket_event",
        "body": "Created ENG-123",
        "source_id": "linear:ENG-123:created",
        "refs": {"threads": ["linear-ENG-123"]},
    }), encoding="utf-8")
    rc, payload = _capture([
        "emit-atom",
        "--memory-root", str(memory),
        "--atom-file", str(atom_path),
    ])
    assert rc == 0
    assert payload["events"] == 1


def test_cli_emit_atom_id_is_module_a_canonical(tmp_path: Path) -> None:
    """If a connector forgets `id`, daemon_cli computes it as
    sha256(source|kind|source_id|ts) — Module A wins."""
    memory = tmp_path / "memory"
    atom = {
        "ts": "2026-04-26T09:30:00+08:00",
        "source": "github",
        "actor": "eric",
        "kind": "pr_event",
        "source_id": "gh:myorg/api:pr-47:opened",
        "body": "x",
    }
    rc, payload = _capture([
        "emit-atom",
        "--memory-root", str(memory),
        "--atom-json", json.dumps(atom),
    ])
    assert rc == 0
    expected = make_event_id("github", "pr_event", "gh:myorg/api:pr-47:opened",
                             "2026-04-26T09:30:00+08:00")
    assert payload["id"] == expected


def test_cli_emit_atom_idempotent_second_call_skips(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    atom = {
        "ts": "2026-04-26T09:30:00+08:00",
        "source": "github",
        "actor": "eric",
        "kind": "pr_event",
        "source_id": "gh:idem-test",
        "body": "first",
    }
    payload1 = _capture(["emit-atom", "--memory-root", str(memory),
                         "--atom-json", json.dumps(atom)])[1]
    payload2 = _capture(["emit-atom", "--memory-root", str(memory),
                         "--atom-json", json.dumps(atom)])[1]
    assert payload1["events"] == 1
    # Same id → second call skipped.
    assert payload2["skipped"] >= 1


def test_cli_emit_atom_missing_required_field(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    rc = main([
        "emit-atom",
        "--memory-root", str(memory),
        "--atom-json", json.dumps({"ts": "2026-04-26T09:00:00Z"}),  # missing source/actor/kind
    ])
    assert rc != 0


def test_cli_emit_atom_validates_agi_fields(tmp_path: Path) -> None:
    """Even if a connector doesn't include the 8 future-fields, the atom
    written to disk has them via validate_atom — no migration needed Stage 2."""
    from tmi.event_router import clear_atom_subscribers, on_atom

    memory = tmp_path / "memory"
    seen: list[dict] = []
    clear_atom_subscribers()

    @on_atom
    def collect(atom, paths):
        seen.append(atom)

    try:
        atom = {
            "ts": "2026-04-26T09:00:00+08:00",
            "source": "github",
            "actor": "eric",
            "kind": "pr_event",
            "source_id": "agi-validate-test",
            "body": "validates",
        }
        rc, _ = _capture(["emit-atom", "--memory-root", str(memory),
                          "--atom-json", json.dumps(atom)])
        assert rc == 0
        assert len(seen) == 1
        for k in ("embedding", "concepts", "confidence", "alternatives",
                  "source_count", "reasoning_notes", "sentiment", "importance"):
            assert k in seen[0]
    finally:
        clear_atom_subscribers()


def test_cli_index_rebuild_seeds_world_model(tmp_path: Path) -> None:
    """Daemon's index-rebuild seeds world_model.json so a fresh repo bootstraps
    the Stage 2 hook §8 file without requiring `tmi wrap`."""
    from tmi.event_router import world_model_path

    memory = tmp_path / "memory"
    rc, _ = _capture(["index-rebuild", "--memory-root", str(memory)])
    assert rc == 0
    assert world_model_path(memory).exists()
