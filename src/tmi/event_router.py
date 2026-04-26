"""A1 — Event Router. The fan-out backbone of the Records Management System.

When ANY source writes a memory file (today: ``tmi wrap``; future: source
connectors for Linear/GitHub/Slack/Cal), the router takes that file, extracts
*atomic events* from it, and:

  1. Appends each event to ``<root>/memory/timeline/<YYYY-MM-DD>.md``
     (append-only, sentinel-fenced).
  2. Updates ``<root>/.tangerine/timeline.json`` index for fast queries.
  3. For every ref the event mentions (people / projects / threads), appends
     a "Mentions" block to that entity file using the existing v1.6 sentinel
     scheme so re-running on the same input is idempotent.

Idempotency rule (load-bearing): re-running the router on the same source file
MUST produce byte-identical timeline entries and a byte-identical index. We
hash the event ``id`` derived from ``(source, source_id, kind, ts)``, so
re-extraction collides on insert and the existing block wins.

The router is the only thing in the codebase that knows how to translate
memory-layer artefacts into the timeline. Module B (source connectors) will
emit memory files in the same shape — meeting files, decision files,
``threads/`` blocks, etc. — so they all flow through ``process()`` without
each connector needing its own fan-out path.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterable, Literal

import yaml

from .utils import SHANGHAI, atomic_write_text

logger = logging.getLogger(__name__)

# ----------------------------------------------------------------------
# Atom schema
#
# An "atom" is one indivisible work event. Every captured signal — a meeting
# chunk, a PR comment, a Linear ticket transition, a calendar block — flattens
# into the same shape so timeline + cursors + briefs operate on a uniform
# stream regardless of source.
#
# Field summary (also documented in .tangerine/SCHEMA.md):
#   id            stable, content-derived; format ``evt-<YYYY-MM-DD>-<10-char-hex>``
#   ts            RFC 3339 timestamp in Asia/Shanghai (or source TZ if known)
#   source        discord | linear | github | slack | calendar | system | meeting
#   actor         primary alias responsible for the event ("daizhe", "eric")
#   actors        all participants (deduped, sorted)
#   kind          meeting_chunk | decision | pr_event | comment | ticket_event |
#                 brief | summary | calendar_event
#   refs          graph edges → {meeting?, decisions?, people?, projects?, threads?}
#   status        active | superseded_by:<id> | closed
#   lifecycle     {decided?, review_by?, owner?, due?}
#   sample        bool — true means seeded fixture, never participates in
#                 alignment metrics or brief generation.
#   body          markdown body of the event (newline-stripped on write)

EventKind = Literal[
    "meeting_chunk",
    "decision",
    "pr_event",
    "comment",
    "ticket_event",
    "brief",
    "summary",
    "calendar_event",
]
EventSource = Literal[
    "discord",
    "linear",
    "github",
    "slack",
    "calendar",
    "system",
    "meeting",
]


@dataclass
class EventLifecycle:
    decided: str | None = None
    review_by: str | None = None
    owner: str | None = None
    due: str | None = None
    closed: str | None = None

    def to_dict(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for k in ("decided", "review_by", "owner", "due", "closed"):
            v = getattr(self, k)
            if v:
                out[k] = v
        return out


@dataclass
class EventRefs:
    meeting: str | None = None
    decisions: list[str] = field(default_factory=list)
    people: list[str] = field(default_factory=list)
    projects: list[str] = field(default_factory=list)
    threads: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, list[str] | str]:
        out: dict[str, list[str] | str] = {}
        if self.meeting:
            out["meeting"] = self.meeting
        for key in ("decisions", "people", "projects", "threads"):
            vals = getattr(self, key)
            if vals:
                # dedupe + sort for stable serialization (idempotency relies on this)
                out[key] = sorted(set(vals))
        return out


@dataclass
class Event:
    id: str
    ts: str
    source: str
    actor: str
    actors: list[str]
    kind: str
    refs: EventRefs
    body: str
    status: str = "active"
    lifecycle: EventLifecycle = field(default_factory=EventLifecycle)
    sample: bool = False

    def to_index_record(self, file: Path, line: int) -> dict[str, object]:
        rec: dict[str, object] = {
            "id": self.id,
            "ts": self.ts,
            "source": self.source,
            "actor": self.actor,
            "actors": sorted(set(self.actors)) or [self.actor],
            "kind": self.kind,
            "refs": self.refs.to_dict(),
            "status": self.status,
            "file": _relative(file),
            "line": line,
        }
        # Body headline (first stripped line, capped) — kept in the index so
        # downstream consumers (briefs, alerts, /today view) don't need to
        # re-walk timeline files for previews. Not the full body.
        if self.body:
            head = self.body.strip().splitlines()[0] if self.body.strip() else ""
            if head:
                rec["body"] = head[:200]
        lc = self.lifecycle.to_dict()
        if lc:
            rec["lifecycle"] = lc
        if self.sample:
            rec["sample"] = True
        return rec


def _relative(p: Path) -> str:
    return str(p).replace("\\", "/")


# ----------------------------------------------------------------------
# Atom ID
#
# We derive the ID from (source, kind, source_id, ts) so an event extracted
# from the same source file always lands on the same id. Two unrelated
# sources can share an id space safely because source is part of the hash.

_ID_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def make_event_id(source: str, kind: str, source_id: str, ts: str) -> str:
    """Stable ULID-like id — date-prefixed for human scanability + 10 hex chars
    of content hash. Same inputs → same id forever.
    """
    date = ts[:10] if _ID_DATE_RE.match(ts[:10] or "") else _today_iso()
    digest = hashlib.sha256(f"{source}|{kind}|{source_id}|{ts}".encode("utf-8")).hexdigest()
    return f"evt-{date}-{digest[:10]}"


def _today_iso() -> str:
    return datetime.now(tz=SHANGHAI).date().isoformat()


def _now_iso() -> str:
    return datetime.now(tz=SHANGHAI).isoformat(timespec="seconds")


# ----------------------------------------------------------------------
# Sidecar paths

def sidecar_dir(memory_root: Path) -> Path:
    p = memory_root.parent / ".tangerine"
    p.mkdir(parents=True, exist_ok=True)
    return p


SIDECAR_README = """# .tangerine/

This directory is the **operational sidecar** for the v1.7 Records Management
System. Everything in here is _computed_ from `memory/`, never hand-edited.
You can safely delete the entire folder — the daemon rebuilds it on the next
heartbeat.

Files:

| Path                    | Owner / writer            | Purpose                                                     |
|-------------------------|---------------------------|-------------------------------------------------------------|
| `timeline.json`         | event_router + daemon     | Index of every atom (id, ts, source, refs, file pointer).   |
| `cursors/<user>.json`   | UI / cursors API          | Per-user view/ack/defer state. One file per user.           |
| `alignment.json`        | daemon (alignment-snapshot) | Same-screen-rate history (last 200 snapshots).            |
| `briefs/<YYYY-MM-DD>.md`| daemon (brief-today)      | Daily brief, generated once per day after 8 AM local.       |
| `briefs/pending.md`     | daemon (alerts-refresh)   | Pending alerts queue (overdue, stale, review-soon).         |
| `daemon-status.json`    | daemon                    | Last heartbeat / pull / brief / errors. Read by UI.         |
| `daemon.log`            | daemon                    | Human-readable log (rotated by app shell).                  |
| `SCHEMA.md`             | event_router              | Atom + timeline + cursor + alignment formal definitions.    |

**git: ignored by default.** None of this is source-of-truth — `memory/` is.
The repo's `.gitignore` should include `.tangerine/`. The team_repo bootstrap
scripts add it automatically.
"""

SIDECAR_SCHEMA = """# RMS v1.7 — Schema reference

Internal documentation for the Tangerine Records Management System.
Authoritative — Module B (source connectors) and Module C (UX views) MUST
write/read in these shapes.

## Atom

The atomic unit of work. Every captured signal — a meeting transcript chunk,
a PR comment, a Linear ticket transition, a calendar block — flattens into:

```yaml
---
id: evt-2026-04-26-aBc12dEf   # ULID-like; date-prefixed + 10 hex of content hash. Stable.
ts: 2026-04-26T14:32:11+08:00 # RFC 3339 in source TZ; daemon canonicalises to +08:00 if missing.
source: discord | linear | github | slack | calendar | system | meeting
actor: daizhe                  # primary alias responsible for the event.
actors: [daizhe, david]        # all participants (deduped, sorted).
kind: meeting_chunk | decision | pr_event | comment | ticket_event | brief | summary | calendar_event
refs:                          # graph edges — every entry creates a fan-out write.
  meeting: 2026-04-26-david-sync
  decisions: [pricing-20-seat]
  people: [daizhe, david]
  projects: [v1-launch]
  threads: [pricing-debate]
status: active                 # active | superseded_by:<id> | closed
lifecycle:
  decided: 2026-04-26
  review_by: 2026-06-07
  due: 2026-05-01
  owner: daizhe
sample: false                  # true → seeded fixture; never participates in alignment / briefs.
---
<markdown body — first non-empty line surfaces as headline>
```

## Timeline file (`memory/timeline/<YYYY-MM-DD>.md`)

Append-only. Each event wrapped in HTML sentinel comments so dedupe doesn't
require markdown parsing.

```markdown
---
date: 2026-04-26
day_summary: null
---

<!-- evt:evt-2026-04-26-aBc12dEf -->
## 09:30 · eric · merged PR #47
- source: github
- actors: eric, daizhe
- kind: pr_event
- refs:
  - people: daizhe, eric
  - projects: v1-launch
- body: |
    postgres-migration → main
- ref:: github/evt-2026-04-26-aBc12dEf
<!-- /evt:evt-2026-04-26-aBc12dEf -->
```

## Index (`.tangerine/timeline.json`)

```json
{
  "version": 1,
  "events": [
    {
      "id": "evt-...",
      "ts": "2026-04-26T09:30:00+08:00",
      "source": "github",
      "actor": "eric",
      "actors": ["daizhe", "eric"],
      "kind": "pr_event",
      "refs": { "projects": ["v1-launch"], "people": ["daizhe", "eric"] },
      "status": "active",
      "file": "memory/timeline/2026-04-26.md",
      "line": 5,
      "body": "merged PR #47"
    }
  ],
  "rebuilt_at": "2026-04-26T09:31:00+08:00"
}
```

Sorted by `(ts, id)` ascending. The daemon rebuilds this on every heartbeat.
Performance target: 10K events rebuild in < 2s.

## Cursors (`.tangerine/cursors/<user>.json`)

```json
{
  "user": "daizhe",
  "last_opened_at": "2026-04-26T08:55:00+08:00",
  "atoms_viewed": { "evt-...aBc": "2026-04-26T09:00:00+08:00" },
  "atoms_acked": { "evt-...xYz": "2026-04-26T09:01:30+08:00" },
  "atoms_deferred": { "evt-...123": "2026-04-27T00:00:00+08:00" },
  "thread_cursor": { "pricing-debate": "evt-...last-read" }
}
```

One file per user so git merges stay sane.

## Alignment metric (`.tangerine/alignment.json`)

```
rate = atoms_viewed_by_every_user / total_non_sample_atoms
```

Snapshot ring-buffered to last 200 entries::

```json
{
  "version": 1,
  "history": [...snapshots...],
  "latest": {
    "computed_at": "...",
    "users": ["daizhe", "eric"],
    "total_atoms": 124,
    "shared_viewed": 87,
    "rate": 0.7016,
    "per_user_seen": {"daizhe": 102, "eric": 95}
  }
}
```

## Pending alerts (`.tangerine/briefs/pending.md`)

Markdown — UI reads it directly. Sections (only present if non-empty):

- **Decisions up for review** — `lifecycle.review_by ≤ today + 3d`
- **Overdue items** — `lifecycle.due < today` and not closed
- **Stale threads** — newest event > 14d ago AND body mentions an open question
- **Members behind** — last_opened > 48h ago AND ≥ 1 unseen atom

Refreshed by the daemon every heartbeat.

## Daily brief (`.tangerine/briefs/<YYYY-MM-DD>.md`)

Markdown. Generated once per day on the first heartbeat ≥ 8 AM local. Covers
yesterday's events, grouped by `kind`, plus a per-user "what you missed".
"""


def write_sidecar_docs(memory_root: Path) -> tuple[Path, Path]:
    """Materialise README.md + SCHEMA.md inside ``.tangerine/``. Idempotent —
    overwrites in place so docstring updates ship cleanly with new releases.
    Returns the two paths written.
    """
    sd = sidecar_dir(memory_root)
    readme = sd / "README.md"
    schema = sd / "SCHEMA.md"
    atomic_write_text(readme, SIDECAR_README)
    atomic_write_text(schema, SIDECAR_SCHEMA)
    return readme, schema


def timeline_dir(memory_root: Path) -> Path:
    p = memory_root / "timeline"
    p.mkdir(parents=True, exist_ok=True)
    return p


def timeline_file_path(memory_root: Path, date_iso: str) -> Path:
    return timeline_dir(memory_root) / f"{date_iso}.md"


def timeline_index_path(memory_root: Path) -> Path:
    return sidecar_dir(memory_root) / "timeline.json"


# ----------------------------------------------------------------------
# Timeline file format
#
# Each daily file is human-readable Markdown. Entries are wrapped with HTML
# sentinel comments so the router can detect duplicates without parsing
# Markdown. Format::
#
#     ---
#     date: 2026-04-26
#     ---
#
#     <!-- evt:evt-2026-04-26-aBc12dEf -->
#     ## 09:30 · eric · merged PR #47
#     - source: github
#     - actors: eric, daizhe
#     - refs:
#       - project: v1-launch
#       - thread: pr-47
#     - body: |
#         postgres-migration → main
#     [→ memory/threads/pr-47.md]
#     <!-- /evt:evt-2026-04-26-aBc12dEf -->

_EVT_SENTINEL_RE = re.compile(
    r"<!--\s*evt:(?P<id>evt-\d{4}-\d{2}-\d{2}-[a-f0-9]+)\s*-->"
    r"(?P<body>.*?)"
    r"<!--\s*/evt:(?P=id)\s*-->",
    re.DOTALL,
)


def _render_event_block(ev: Event) -> str:
    time_part = ev.ts[11:16] if len(ev.ts) >= 16 else "??:??"
    refs = ev.refs.to_dict()
    parts: list[str] = []
    parts.append(f"<!-- evt:{ev.id} -->")
    headline = ev.body.strip().splitlines()[0] if ev.body.strip() else f"{ev.kind}"
    # Trim headline to a single line, max 120 chars
    headline = headline.strip("# -").strip()[:120] or ev.kind
    parts.append(f"## {time_part} · {ev.actor} · {headline}")
    parts.append(f"- source: {ev.source}")
    if ev.actors:
        parts.append(f"- actors: {', '.join(sorted(set(ev.actors)))}")
    parts.append(f"- kind: {ev.kind}")
    if refs:
        parts.append("- refs:")
        for k in ("meeting", "people", "projects", "threads", "decisions"):
            v = refs.get(k)
            if not v:
                continue
            if isinstance(v, list):
                parts.append(f"  - {k}: {', '.join(v)}")
            else:
                parts.append(f"  - {k}: {v}")
    if ev.lifecycle.to_dict():
        parts.append("- lifecycle:")
        for k, v in ev.lifecycle.to_dict().items():
            parts.append(f"  - {k}: {v}")
    if ev.body.strip():
        parts.append("- body: |")
        for line in ev.body.strip().splitlines():
            parts.append(f"    {line}")
    parts.append(f"- ref:: {ev.source}/{ev.id}")
    parts.append(f"<!-- /evt:{ev.id} -->")
    parts.append("")
    return "\n".join(parts)


def _ensure_day_header(date_iso: str) -> str:
    return (
        "---\n"
        f"date: {date_iso}\n"
        "day_summary: null\n"
        "---\n\n"
    )


def _read_day_file(path: Path) -> str:
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def _existing_event_ids(text: str) -> set[str]:
    return {m.group("id") for m in _EVT_SENTINEL_RE.finditer(text)}


def _append_event_to_day(path: Path, ev: Event) -> int | None:
    """Append the event block to the day file. Returns the 1-based line number
    where the sentinel comment was written, or ``None`` if the event id was
    already present (idempotent no-op).
    """
    existing = _read_day_file(path)
    if not existing:
        existing = _ensure_day_header(ev.ts[:10])
    else:
        if not existing.startswith("---\n"):
            existing = _ensure_day_header(ev.ts[:10]) + existing
    if ev.id in _existing_event_ids(existing):
        return None
    block = _render_event_block(ev)
    if not existing.endswith("\n"):
        existing += "\n"
    new_text = existing + block + "\n"
    atomic_write_text(path, new_text)
    # Compute the line number of the sentinel comment we just wrote.
    # Line numbering matches Read() output (1-based).
    line = existing.count("\n") + 1
    return line


# ----------------------------------------------------------------------
# Index (.tangerine/timeline.json)


def load_index(memory_root: Path) -> dict[str, object]:
    p = timeline_index_path(memory_root)
    if not p.exists():
        return {"version": 1, "events": []}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "events": []}


def save_index(memory_root: Path, index: dict[str, object]) -> None:
    p = timeline_index_path(memory_root)
    text = json.dumps(index, ensure_ascii=False, indent=2, sort_keys=False)
    atomic_write_text(p, text)


def _upsert_index_entry(index: dict[str, object], rec: dict[str, object]) -> None:
    events = index.setdefault("events", [])  # type: ignore[assignment]
    assert isinstance(events, list)
    for i, existing in enumerate(events):
        if isinstance(existing, dict) and existing.get("id") == rec["id"]:
            events[i] = rec
            return
    events.append(rec)


def rebuild_index(memory_root: Path) -> dict[str, object]:
    """Walk ``timeline/*.md`` and rebuild the index from scratch. Used by the
    daemon heartbeat. Stable order — events sorted by (ts, id) ascending.
    """
    events: list[dict[str, object]] = []
    tdir = timeline_dir(memory_root)
    for day_file in sorted(tdir.glob("*.md")):
        if not day_file.is_file():
            continue
        text = _read_day_file(day_file)
        if not text:
            continue
        # Build a line-number lookup once per file
        lines = text.splitlines()
        sentinel_lines: dict[str, int] = {}
        for i, line in enumerate(lines, start=1):
            m = re.match(r"<!--\s*evt:(evt-\d{4}-\d{2}-\d{2}-[a-f0-9]+)\s*-->", line.strip())
            if m:
                sentinel_lines[m.group(1)] = i
        for m in _EVT_SENTINEL_RE.finditer(text):
            ev_id = m.group("id")
            block_text = m.group("body")
            rec = _parse_block_to_index_record(
                ev_id=ev_id,
                block=block_text,
                file=day_file,
                line=sentinel_lines.get(ev_id, 1),
            )
            if rec is not None:
                events.append(rec)
    events.sort(key=lambda r: (str(r.get("ts", "")), str(r.get("id", ""))))
    index = {"version": 1, "events": events, "rebuilt_at": _now_iso()}
    save_index(memory_root, index)
    return index


def _parse_block_to_index_record(
    *, ev_id: str, block: str, file: Path, line: int
) -> dict[str, object] | None:
    """Best-effort: pull source/actor/kind/ts/refs from the rendered block back
    into a record. Mirrors ``_render_event_block`` so the index is self-healing.
    """
    record: dict[str, object] = {"id": ev_id, "file": _relative(file), "line": line}
    refs: dict[str, object] = {}
    in_refs = False
    in_lifecycle = False
    in_body = False
    body_lines: list[str] = []
    lifecycle: dict[str, str] = {}
    for raw in block.splitlines():
        line_text = raw.rstrip()
        if line_text.startswith("## "):
            # Pull HH:MM out of "## HH:MM · actor · headline"
            parts = line_text[3:].split(" · ", 2)
            if len(parts) >= 1 and re.match(r"^\d{2}:\d{2}$", parts[0]):
                # Rebuild a date-aware ts from the file name (YYYY-MM-DD.md)
                day = file.stem
                record["ts"] = f"{day}T{parts[0]}:00+08:00"
            if len(parts) >= 2:
                record["actor"] = parts[1].strip()
            continue
        if line_text.startswith("- source: "):
            record["source"] = line_text[len("- source: ") :].strip()
            continue
        if line_text.startswith("- actors: "):
            actors = [a.strip() for a in line_text[len("- actors: ") :].split(",") if a.strip()]
            record["actors"] = actors
            continue
        if line_text.startswith("- kind: "):
            record["kind"] = line_text[len("- kind: ") :].strip()
            continue
        if line_text == "- refs:":
            in_refs = True
            in_lifecycle = False
            continue
        if line_text == "- lifecycle:":
            in_refs = False
            in_lifecycle = True
            continue
        if in_refs and line_text.startswith("  - "):
            kv = line_text[4:].split(": ", 1)
            if len(kv) == 2:
                key, val = kv
                if key in {"people", "projects", "threads", "decisions"}:
                    refs[key] = [v.strip() for v in val.split(",") if v.strip()]
                else:
                    refs[key] = val.strip()
            continue
        if in_lifecycle and line_text.startswith("  - "):
            kv = line_text[4:].split(": ", 1)
            if len(kv) == 2:
                lifecycle[kv[0]] = kv[1].strip()
            continue
        if line_text == "- body: |":
            in_body = True
            in_refs = False
            in_lifecycle = False
            continue
        if in_body and line_text.startswith("    "):
            body_lines.append(line_text[4:])
            continue
        if line_text.startswith("- "):
            in_refs = False
            in_lifecycle = False
            in_body = False
    if body_lines:
        head = body_lines[0].strip()
        if head:
            record["body"] = head[:200]
    if "ts" not in record:
        # Couldn't recover ts; skip this block from the rebuilt index.
        return None
    if refs:
        record["refs"] = refs
    if lifecycle:
        record["lifecycle"] = lifecycle
    record.setdefault("status", "active")
    record.setdefault("source", "unknown")
    record.setdefault("kind", "comment")
    record.setdefault("actor", "unknown")
    record.setdefault("actors", [str(record.get("actor", "unknown"))])
    return record


# ----------------------------------------------------------------------
# Entity fan-out
#
# For every ref the event mentions, append a one-line "Mentions" entry to that
# entity file under a sentinel-fenced "Timeline mentions" section. We reuse
# the v1.6 ``<!-- mention:<id> -->`` scheme for compatibility — but distinct
# from the meeting-mention blocks (which the AI extractor writes), so the two
# coexist without stomping each other.

_TIMELINE_HEADER = "## Timeline mentions"


def _entity_path(memory_root: Path, kind: str, slug: str) -> Path:
    sub = {
        "people": "people",
        "projects": "projects",
        "threads": "threads",
        "decisions": "decisions",
    }[kind]
    safe = re.sub(r"[^a-z0-9-]+", "-", slug.lower()).strip("-") or "untitled"
    p = memory_root / sub / f"{safe}.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _append_entity_mention(path: Path, ev: Event) -> bool:
    """Add a sentinel-fenced one-liner referencing this event id under
    ``## Timeline mentions``. Returns True if file was changed.
    """
    sentinel = f"<!-- timeline-evt:{ev.id} -->"
    if path.exists():
        existing = path.read_text(encoding="utf-8")
    else:
        existing = (
            f"---\nautocreated: true\n---\n\n# {path.stem}\n\n"
        )
    if sentinel in existing:
        return False
    if _TIMELINE_HEADER not in existing:
        if not existing.endswith("\n"):
            existing += "\n"
        existing += f"\n{_TIMELINE_HEADER}\n\n"
    snippet = (ev.body or ev.kind).strip().splitlines()[0] if ev.body else ev.kind
    snippet = snippet[:140]
    line = (
        f"{sentinel}\n"
        f"- {ev.ts[:10]} · {ev.actor} · {ev.kind} · {snippet}"
        f"  ([→ timeline](../timeline/{ev.ts[:10]}.md))\n"
    )
    if not existing.endswith("\n"):
        existing += "\n"
    new_text = existing + line
    atomic_write_text(path, new_text)
    return True


def _fan_out_entities(memory_root: Path, ev: Event) -> list[Path]:
    written: list[Path] = []
    for kind, slugs in (
        ("people", ev.refs.people),
        ("projects", ev.refs.projects),
        ("threads", ev.refs.threads),
        ("decisions", ev.refs.decisions),
    ):
        for slug in slugs:
            p = _entity_path(memory_root, kind, slug)
            if _append_entity_mention(p, ev):
                written.append(p)
    return written


# ----------------------------------------------------------------------
# Public entry points


@dataclass
class RouteResult:
    events: list[Event] = field(default_factory=list)
    timeline_writes: list[Path] = field(default_factory=list)
    entity_writes: list[Path] = field(default_factory=list)
    skipped: int = 0

    def summary(self) -> dict[str, int]:
        return {
            "events": len(self.events),
            "timeline_files": len(set(self.timeline_writes)),
            "entity_files": len(set(self.entity_writes)),
            "skipped_existing": self.skipped,
        }


def emit(memory_root: Path, events: Iterable[Event]) -> RouteResult:
    """Low-level fan-out: take a list of events already constructed, write
    them to timeline + entity files + index. Idempotent.
    """
    result = RouteResult()
    index = load_index(memory_root)
    for ev in events:
        result.events.append(ev)
        day = ev.ts[:10]
        if not _ID_DATE_RE.match(day):
            day = _today_iso()
        path = timeline_file_path(memory_root, day)
        line = _append_event_to_day(path, ev)
        if line is None:
            result.skipped += 1
            # still upsert in index so a stale index becomes consistent
            existing_text = _read_day_file(path)
            for i, ln in enumerate(existing_text.splitlines(), start=1):
                if ln.strip() == f"<!-- evt:{ev.id} -->":
                    line = i
                    break
        if line is not None:
            result.timeline_writes.append(path)
            rec = ev.to_index_record(path, line)
            _upsert_index_entry(index, rec)
        result.entity_writes.extend(_fan_out_entities(memory_root, ev))
    # Stable order in index.
    events_list = index.get("events")
    if isinstance(events_list, list):
        events_list.sort(key=lambda r: (str(r.get("ts", "")), str(r.get("id", ""))))
    save_index(memory_root, index)
    return result


def process(memory_root: Path, source_path: Path) -> RouteResult:
    """High-level: extract events from a memory artefact (meeting file,
    decision file, etc.) and route them. Returns a ``RouteResult`` summarising
    what changed. Safe to call repeatedly on the same path.
    """
    if not source_path.exists():
        logger.warning("event_router: source missing %s", source_path)
        return RouteResult()
    text = source_path.read_text(encoding="utf-8")
    rel = source_path.relative_to(memory_root) if _is_under(source_path, memory_root) else source_path
    rel_str = str(rel).replace("\\", "/")
    if rel_str.startswith("meetings/"):
        events = _extract_from_meeting_file(memory_root, source_path, text)
    elif rel_str.startswith("decisions/"):
        events = _extract_from_decision_file(memory_root, source_path, text)
    elif rel_str.startswith("threads/"):
        events = _extract_from_thread_file(memory_root, source_path, text)
    else:
        events = _extract_generic(memory_root, source_path, text)
    return emit(memory_root, events)


def _is_under(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


# ----------------------------------------------------------------------
# Extractors per source kind
#
# These are intentionally regex/heuristic — they parse the markdown shapes
# emitted by tmi.memory writers. Module B connectors will produce memory
# files in the same shape so the same extractors apply uniformly.


def _split_frontmatter(text: str) -> tuple[dict[str, object], str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    raw = text[4:end]
    body = text[end + 5 :].lstrip("\n")
    try:
        loaded = yaml.safe_load(raw) or {}
    except yaml.YAMLError:
        return {}, text
    if not isinstance(loaded, dict):
        return {}, body
    return loaded, body


def _ts_from_meeting(fm: dict[str, object], default_time: str = "09:00:00") -> str:
    date = fm.get("date")
    if isinstance(date, str) and _ID_DATE_RE.match(date):
        return f"{date}T{default_time}+08:00"
    return _now_iso()


_TRANSCRIPT_LINE_RE = re.compile(
    r"^\[(?P<hms>\d{2}:\d{2}:\d{2})\]\s+(?P<actor>[a-z][a-z0-9_]*)\s*:\s*(?P<msg>.+)$"
)
_DECISION_HEAD_RE = re.compile(r"^### Topic\s+\d+:\s*(?P<title>.+?)\s*$", re.MULTILINE)


def _extract_from_meeting_file(
    memory_root: Path, source_path: Path, text: str
) -> list[Event]:
    fm, body = _split_frontmatter(text)
    title = str(fm.get("title", source_path.stem))
    meeting_id = str(fm.get("meeting_id") or source_path.stem)
    date = str(fm.get("date") or source_path.stem[:10])
    participants_raw = fm.get("participants")
    if isinstance(participants_raw, list):
        participants = [str(p) for p in participants_raw]
    else:
        participants = []

    events: list[Event] = []

    # 1. One ``meeting_chunk`` per transcript turn (capped) so the timeline
    #    shows real activity, not just one giant blob. We chunk to at most 30
    #    events per meeting to keep indexes lean.
    transcript_lines: list[tuple[str, str, str]] = []
    in_transcript = False
    for raw in body.splitlines():
        if raw.strip() == "## Transcript":
            in_transcript = True
            continue
        if in_transcript and raw.startswith("## "):
            in_transcript = False
        if not in_transcript:
            continue
        m = _TRANSCRIPT_LINE_RE.match(raw)
        if m:
            transcript_lines.append((m.group("hms"), m.group("actor"), m.group("msg")))

    chunks = _chunk_transcript(transcript_lines, max_chunks=30)
    for hms, actor, msg in chunks:
        ts = f"{date}T{hms}+08:00"
        ev_id = make_event_id("meeting", "meeting_chunk", f"{meeting_id}@{hms}", ts)
        refs = EventRefs(
            meeting=meeting_id,
            people=sorted(set(participants) | {actor}),
        )
        events.append(
            Event(
                id=ev_id,
                ts=ts,
                source="meeting",
                actor=actor,
                actors=sorted(set(participants) | {actor}),
                kind="meeting_chunk",
                refs=refs,
                body=msg,
            )
        )

    # 2. One ``summary`` event for the meeting itself, anchored at the date.
    summary_ts = _ts_from_meeting(fm, "09:00:00")
    summary_id = make_event_id("meeting", "summary", meeting_id, summary_ts)
    events.append(
        Event(
            id=summary_id,
            ts=summary_ts,
            source="meeting",
            actor=participants[0] if participants else "system",
            actors=participants or ["system"],
            kind="summary",
            refs=EventRefs(meeting=meeting_id, people=list(participants)),
            body=f"Meeting: {title} ({len(transcript_lines)} turns)",
        )
    )

    # 3. Decisions referenced in the embedded ## Decisions section get a
    #    pointer event each (the actual decision detail lives in
    #    decisions/<slug>.md and is processed separately).
    decisions_section = _section_after(body, "## Decisions")
    if decisions_section:
        for line in decisions_section.splitlines():
            m = re.match(r"^\s*-\s*\[.+?\]\(\.\./decisions/(?P<slug>[a-z0-9-]+)\.md\)", line)
            if not m:
                continue
            slug = m.group("slug")
            ts = _ts_from_meeting(fm, "10:00:00")
            ev_id = make_event_id("meeting", "decision", f"{meeting_id}::{slug}", ts)
            events.append(
                Event(
                    id=ev_id,
                    ts=ts,
                    source="meeting",
                    actor=participants[0] if participants else "system",
                    actors=participants or ["system"],
                    kind="decision",
                    refs=EventRefs(
                        meeting=meeting_id,
                        decisions=[slug],
                        people=list(participants),
                    ),
                    body=f"Decision recorded: {slug.replace('-', ' ')}",
                )
            )
    return events


def _chunk_transcript(
    lines: list[tuple[str, str, str]], *, max_chunks: int
) -> list[tuple[str, str, str]]:
    """If the transcript is short, return one event per line. Otherwise pick
    evenly spaced samples so the timeline scales with attention budget.
    """
    if len(lines) <= max_chunks:
        return lines
    step = len(lines) / max_chunks
    sampled: list[tuple[str, str, str]] = []
    seen_idx: set[int] = set()
    for i in range(max_chunks):
        idx = int(i * step)
        if idx in seen_idx or idx >= len(lines):
            continue
        seen_idx.add(idx)
        sampled.append(lines[idx])
    return sampled


def _section_after(body: str, heading: str) -> str:
    idx = body.find(heading)
    if idx == -1:
        return ""
    rest = body[idx + len(heading) :]
    next_h = re.search(r"^##\s+", rest, re.MULTILINE)
    return rest[: next_h.start()] if next_h else rest


def _extract_from_decision_file(
    memory_root: Path, source_path: Path, text: str
) -> list[Event]:
    fm, body = _split_frontmatter(text)
    title = str(fm.get("title", source_path.stem))
    slug = source_path.stem
    date = str(fm.get("date") or _today_iso())
    source_meeting = fm.get("source_id")
    decided_by_match = re.search(r"\*\*Decided by\*\*:\s*(?P<who>[^\n]+)", body)
    decided_by = decided_by_match.group("who").strip() if decided_by_match else "system"
    actor = decided_by.split(",")[0].strip().lower() or "system"

    ts = f"{date}T11:00:00+08:00"
    ev_id = make_event_id("meeting", "decision", slug, ts)
    refs = EventRefs(
        decisions=[slug],
        meeting=str(source_meeting) if source_meeting else None,
        people=[a.strip().lower() for a in decided_by.split(",") if a.strip()],
    )
    lifecycle = EventLifecycle(decided=date)
    return [
        Event(
            id=ev_id,
            ts=ts,
            source="meeting",
            actor=actor,
            actors=refs.people or [actor],
            kind="decision",
            refs=refs,
            body=f"{title}",
            lifecycle=lifecycle,
        )
    ]


def _extract_from_thread_file(
    memory_root: Path, source_path: Path, text: str
) -> list[Event]:
    fm, _body = _split_frontmatter(text)
    topic = str(fm.get("topic") or source_path.stem)
    title = str(fm.get("title") or topic)
    ts = _now_iso()
    ev_id = make_event_id("system", "comment", f"thread:{topic}", ts)
    return [
        Event(
            id=ev_id,
            ts=ts,
            source="system",
            actor="system",
            actors=["system"],
            kind="comment",
            refs=EventRefs(threads=[topic]),
            body=f"Thread updated: {title}",
        )
    ]


def _extract_generic(
    memory_root: Path, source_path: Path, text: str
) -> list[Event]:
    """Catch-all: emit one ``comment`` event referencing the file. Lets a
    Module B connector that writes to ``memory/<connector>/...`` still surface
    on the timeline without bespoke code.
    """
    fm, _body = _split_frontmatter(text)
    actor = str(fm.get("actor") or "system")
    ts = str(fm.get("ts") or _now_iso())
    ev_id = make_event_id("system", "comment", str(source_path), ts)
    return [
        Event(
            id=ev_id,
            ts=ts,
            source="system",
            actor=actor,
            actors=[actor],
            kind="comment",
            refs=EventRefs(),
            body=f"Touched: {source_path.name}",
        )
    ]


__all__ = [
    "Event",
    "EventRefs",
    "EventLifecycle",
    "RouteResult",
    "make_event_id",
    "process",
    "emit",
    "rebuild_index",
    "load_index",
    "save_index",
    "timeline_dir",
    "timeline_file_path",
    "timeline_index_path",
    "sidecar_dir",
]
