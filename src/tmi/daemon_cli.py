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
    python -m tmi.daemon_cli emit-atom           --memory-root <path>
                                                 (--atom-json <json> | --atom-file <path> | <stdin>)

The ``emit-atom`` form is the integration point for source connectors
(Module B) — Node-side connectors build the atom dict, hand it to this
subcommand, and Module A's event_router takes care of timeline + entity
fan-out + index update + AGI hook validation + on_atom dispatch.

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
from .event_router import (
    Event,
    EventLifecycle,
    EventRefs,
    emit as route_emit,
    ensure_world_model,
    make_event_id,
    process as route_process,
    rebuild_index,
    validate_atom,
    write_sidecar_docs,
)
from .utils import SHANGHAI


def _emit(payload: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    sys.stdout.flush()


def _now_iso() -> str:
    return datetime.now(tz=SHANGHAI).isoformat(timespec="seconds")


def _handle_index_rebuild(memory_root: Path) -> int:
    # Seed the sidecar docs + world_model.json on every rebuild so a fresh
    # repo gets the Stage 2 future-proof slots without requiring `tmi wrap`.
    write_sidecar_docs(memory_root)
    ensure_world_model(memory_root)
    idx = rebuild_index(memory_root)
    events_obj = idx.get("events", [])
    n = len(events_obj) if isinstance(events_obj, list) else 0
    _emit({"op": "index-rebuild", "events": n, "ts": _now_iso()})
    return 0


def _handle_emit_atom(
    memory_root: Path,
    atom_json: str | None,
    atom_file: Path | None,
) -> int:
    """Take an atom dict from Module B (source connector), build an Event and
    route it through the Module A event_router. The connector doesn't need to
    know about timeline/entity/index plumbing — that all happens here.

    Required atom keys (raise if missing): ``ts``, ``source``, ``actor``,
    ``kind``, ``body``. Optional: ``id`` (computed from sha256 if absent),
    ``actors``, ``refs``, ``status``, ``lifecycle``, ``sample``, plus all 8
    Stage 2 AGI fields (defaults injected by validate_atom).
    """
    raw = _load_atom_payload(atom_json, atom_file)
    if not isinstance(raw, dict):
        print("error: atom payload must be a JSON object", file=sys.stderr)
        return 2
    try:
        ev = _build_event_from_payload(raw)
    except (KeyError, TypeError, ValueError) as e:
        print(f"error: emit-atom invalid payload: {e}", file=sys.stderr)
        return 2
    res = route_emit(memory_root, [ev])
    _emit(
        {
            "op": "emit-atom",
            "id": ev.id,
            "events": len(res.events),
            "skipped": res.skipped,
            "timeline_files": len(set(res.timeline_writes)),
            "entity_files": len(set(res.entity_writes)),
        }
    )
    return 0


def _load_atom_payload(
    atom_json: str | None, atom_file: Path | None
) -> object:
    if atom_json:
        return json.loads(atom_json)
    if atom_file is not None:
        return json.loads(atom_file.read_text(encoding="utf-8"))
    # Stdin — for atoms that exceed the OS command-line length limit.
    data = sys.stdin.read()
    if not data.strip():
        raise ValueError("no atom payload (provide --atom-json, --atom-file, or stdin)")
    return json.loads(data)


def _build_event_from_payload(raw: dict[str, object]) -> Event:
    """Coerce a Module-B atom dict into a Module-A Event. Validates required
    fields, computes the canonical id from sha256(source|kind|source_id|ts)
    if not provided (Module A wins per source-connector contract).
    """
    # Inject Stage 2 AGI defaults so every emitted atom has the 8 future
    # fields, even when a source connector is unaware of them.
    validate_atom(raw)

    ts = str(_require(raw, "ts"))
    source = str(_require(raw, "source"))
    actor = str(_require(raw, "actor"))
    kind = str(_require(raw, "kind"))
    body = str(raw.get("body") or "")

    # Compute id Module-A way if the connector didn't already supply one.
    # source_id falls back to the connector's id (if non-empty) so atoms
    # always end up at deterministic, source-stable hashes.
    source_id = str(raw.get("source_id") or raw.get("id") or f"{actor}:{ts}:{kind}")
    eid = str(raw.get("id") or make_event_id(source, kind, source_id, ts))

    actors_raw = raw.get("actors") or [actor]
    if isinstance(actors_raw, list):
        actors = [str(a) for a in actors_raw]
    else:
        actors = [actor]

    refs = _build_refs(raw.get("refs"))
    lifecycle = _build_lifecycle(raw.get("lifecycle"))

    return Event(
        id=eid,
        ts=ts,
        source=source,
        actor=actor,
        actors=actors,
        kind=kind,
        refs=refs,
        body=body,
        status=str(raw.get("status") or "active"),
        lifecycle=lifecycle,
        sample=bool(raw.get("sample", False)),
        embedding=raw.get("embedding"),  # type: ignore[arg-type]
        concepts=list(raw.get("concepts") or []),  # type: ignore[arg-type]
        confidence=float(raw.get("confidence", 1.0)),
        alternatives=list(raw.get("alternatives") or []),  # type: ignore[arg-type]
        source_count=int(raw.get("source_count", 1)),
        reasoning_notes=raw.get("reasoning_notes"),  # type: ignore[arg-type]
        sentiment=raw.get("sentiment"),  # type: ignore[arg-type]
        importance=raw.get("importance"),  # type: ignore[arg-type]
    )


def _require(d: dict[str, object], key: str) -> object:
    if key not in d or d[key] in (None, ""):
        raise KeyError(f"missing required atom field: {key}")
    return d[key]


def _build_refs(raw: object) -> EventRefs:
    refs = EventRefs()
    if not isinstance(raw, dict):
        return refs
    meeting = raw.get("meeting")
    if isinstance(meeting, str) and meeting:
        refs.meeting = meeting
    for key in ("decisions", "people", "projects", "threads"):
        v = raw.get(key)
        if isinstance(v, list):
            getattr(refs, key).extend(str(x) for x in v if x)
    return refs


def _build_lifecycle(raw: object) -> EventLifecycle:
    if not isinstance(raw, dict):
        return EventLifecycle()
    return EventLifecycle(
        decided=_str_or_none(raw.get("decided")),
        review_by=_str_or_none(raw.get("review_by")),
        owner=_str_or_none(raw.get("owner")),
        due=_str_or_none(raw.get("due")),
        closed=_str_or_none(raw.get("closed")),
    )


def _str_or_none(v: object) -> str | None:
    if isinstance(v, str) and v:
        return v
    return None


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
        "emit-atom",
    ])
    parser.add_argument("--memory-root", type=Path, required=True)
    parser.add_argument("--date", type=str, default=None)
    parser.add_argument("--file", type=Path, default=None)
    parser.add_argument("--atom-json", type=str, default=None,
                        help="emit-atom: atom dict as a JSON string")
    parser.add_argument("--atom-file", type=Path, default=None,
                        help="emit-atom: read atom dict from file")
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
        if args.subcommand == "emit-atom":
            return _handle_emit_atom(memory_root, args.atom_json, args.atom_file)
    except Exception as e:  # noqa: BLE001 — daemon needs a non-zero exit code
        print(f"error: {args.subcommand} failed: {e}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
