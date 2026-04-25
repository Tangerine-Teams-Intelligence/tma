# Demo — TMA bootstrap meeting

This is a real-shaped sample meeting. The premise is meta: we used TMA to plan TMA's own kickoff.

You can browse these files to understand what TMA produces end to end without running anything yourself.

## Files

| Path | What it is |
|---|---|
| [`2026-04-22-david-tma-kickoff/meeting.yaml`](2026-04-22-david-tma-kickoff/meeting.yaml) | Meeting metadata (id, participants, target repo) |
| [`2026-04-22-david-tma-kickoff/intents/daizhe.md`](2026-04-22-david-tma-kickoff/intents/daizhe.md) | DZ's pre-meeting intent — structured fields for outcome type, goal, expected disagreement, current stance |
| [`2026-04-22-david-tma-kickoff/intents/hongyu.md`](2026-04-22-david-tma-kickoff/intents/hongyu.md) | Hongyu's intent (verify dual-stream feasibility) |
| [`2026-04-22-david-tma-kickoff/intents/advisor.md`](2026-04-22-david-tma-kickoff/intents/advisor.md) | Advisor's intent (sync legal RFP timeline) |
| [`2026-04-22-david-tma-kickoff/transcript.md`](2026-04-22-david-tma-kickoff/transcript.md) | Live transcript with speaker labels and timestamps |
| [`2026-04-22-david-tma-kickoff/observations.md`](2026-04-22-david-tma-kickoff/observations.md) | Observer flags written silently during the meeting (ground-truth contradictions, agenda drift, stance changes) |
| [`2026-04-22-david-tma-kickoff/summary.md`](2026-04-22-david-tma-kickoff/summary.md) | Post-meeting synthesis grouped by topic with intent → outcome → action |
| [`2026-04-22-david-tma-kickoff/knowledge-diff.md`](2026-04-22-david-tma-kickoff/knowledge-diff.md) | Proposed changes to the target knowledge repo, in PR-style blocks |
| [`2026-04-22-david-tma-kickoff/status.yaml`](2026-04-22-david-tma-kickoff/status.yaml) | Final state machine snapshot (state: merged) |
| [`target-knowledge-repo-snapshot/`](target-knowledge-repo-snapshot/) | What the target Claude Code repo's `CLAUDE.md` and `knowledge/session-state.md` looked like AFTER `tmi apply` ran |

## How this was generated

In production, TMA generates these via `tmi prep / start / wrap / review / apply`. For the demo, the content is hand-shaped to look like a typical run while staying short enough to read in 10 minutes.

To produce something like this for your own meeting, follow [SETUP.md](../SETUP.md) and run a real session. The smoke test at [`tests/smoke_e2e.py`](../tests/smoke_e2e.py) proves the pipeline works end to end with mocks; this demo shows what it produces with a real meeting.
