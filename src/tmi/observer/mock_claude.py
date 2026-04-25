"""Mock claude subprocess. Reads stdin envelope, prints canned fenced JSON to stdout.

Used by `tmi prep --mock-claude`, tests, and the spec's TMI_CLAUDE_MODE=stub hook.
Run via: `python -m tmi.observer.mock_claude <mode>`.
"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone, timedelta

# Force UTF-8 on std streams so middot (·) and Chinese survive on Windows.
for _stream_name in ("stdout", "stdin", "stderr"):
    _s = getattr(sys, _stream_name, None)
    if _s is not None and hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

SHA = timezone(timedelta(hours=8))


def _now() -> str:
    return datetime.now(tz=SHA).isoformat(timespec="seconds")


def prep() -> None:
    # Read first line (envelope)
    first = sys.stdin.readline()
    try:
        env = json.loads(first)
    except Exception:
        env = {"alias": "tester"}
    alias = env.get("alias", "tester")
    sys.stderr.write(f"[mock-claude prep] envelope received, alias={alias}\n")

    # Echo prompts; consume rest of stdin until EOF
    turn = 0
    sys.stdout.write(f"[mock] hi {alias}, what's the meeting about?\n")
    sys.stdout.flush()
    for line in sys.stdin:
        turn += 1
        sys.stdout.write(f"[mock] noted (turn {turn}): {line.rstrip()}\n")
        sys.stdout.flush()

    # Final fenced JSON block
    body = (
        "## Topics\n\n"
        "### Topic 1: mock topic\n"
        "- **Type**: sync\n"
        "- **Goal**: validate the mock pipeline end-to-end\n"
    )
    fm = (
        f"---\n"
        f"schema_version: 1\n"
        f"author: {alias}\n"
        f"created_at: {_now()}\n"
        f"locked: true\n"
        f"locked_at: {_now()}\n"
        f"turn_count: {turn}\n"
        f"---\n\n"
    )
    intent_md = fm + body
    sys.stdout.write("```json\n")
    sys.stdout.write(json.dumps({"intent_markdown": intent_md}, ensure_ascii=False))
    sys.stdout.write("\n```\n")
    sys.stdout.flush()


def observe() -> None:
    # Read one envelope per "tick", emit empty flags. Keep reading until EOF.
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        sys.stdout.write("```json\n")
        sys.stdout.write(json.dumps({"flags": []}))
        sys.stdout.write("\n```\n")
        sys.stdout.flush()


def wrap() -> None:
    raw = sys.stdin.read()
    try:
        env = json.loads(raw.strip().splitlines()[0])
    except Exception:
        env = {}
    meeting = env.get("meeting", {}) or {}
    mid = meeting.get("id", "unknown")
    title = meeting.get("title", "untitled")
    parts = [p.get("alias") for p in meeting.get("participants", []) if p.get("alias")]

    summary = (
        f"---\n"
        f"schema_version: 1\n"
        f"generated_at: {_now()}\n"
        f"meeting_id: {mid}\n"
        f"participants: {parts}\n"
        f"duration_minutes: 0\n"
        f"---\n\n"
        f"# {title}\n\n"
        f"## Topics covered\n\n"
        f"### Topic 1: mock topic\n"
        f"- **Outcome**: mock\n"
        f"- **Decided by**: mock\n"
        f"- **Stance changes**: none\n"
        f"- **Transcript refs**: L1\n\n"
        f"## Topics raised but not resolved\n- (none)\n\n"
        f"## Topics in intents but not raised\n- (none)\n\n"
        f"## Action items\n- (none)\n\n"
        f"## New facts surfaced\n- (none)\n"
    )
    diff = (
        f"<!-- TMA knowledge-diff schema_version=1 meeting_id={mid} -->\n\n"
        f"## Block 1 · append · knowledge/session-state.md\n"
        f"**Reason**: mock wrap output for {mid}\n"
        f"**Transcript refs**: L1\n"
        f"**Block-ID**: 1\n\n"
        f"```diff\n"
        f"+ ### {datetime.now(tz=SHA).date().isoformat()} — {title}\n"
        f"+ - mock entry\n"
        f"```\n"
    )
    sys.stdout.write("```json\n")
    sys.stdout.write(json.dumps({"summary_markdown": summary}, ensure_ascii=False))
    sys.stdout.write("\n```\n")
    sys.stdout.write("```json\n")
    sys.stdout.write(json.dumps({"diff_markdown": diff}, ensure_ascii=False))
    sys.stdout.write("\n```\n")
    sys.stdout.flush()


def main() -> None:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: mock_claude.py <prep|observe|wrap>\n")
        sys.exit(2)
    mode = sys.argv[1]
    if mode == "prep":
        prep()
    elif mode == "observe":
        observe()
    elif mode == "wrap":
        wrap()
    else:
        sys.stderr.write(f"unknown mode: {mode}\n")
        sys.exit(2)


if __name__ == "__main__":
    main()
