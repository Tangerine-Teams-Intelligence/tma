---
sample: true
date: 2026-04-25
title: Stage agent-orchestration v3 behind a 10% flag
status: decided
attendees: [alex, sam]
source: meeting
source_id: sample-2026-04-25-rollout
references:
  - timeline/2026-04-25.md
---

## Decision

Roll out **agent-orchestration v3** behind a feature flag at **10% of
trial accounts** starting 2026-04-25 14:00 UTC. Auto-promote to 100%
on 2026-04-29 if no regressions surface.

## Rationale

- v3 changes the dispatch path enough that we don't trust a flat cutover.
- 10% gives us ~400 trial accounts of signal — enough to spot a >2%
  error-rate delta within 24h.
- Rollback is one config flip; no schema change blocks reverting.

## Guardrails

- Auto-revert if 5xx rate on `/api/v2/orchestrator` exceeds 0.5% over a
  10-minute rolling window.
- Manual revert if any single trial team hits > 10 failed requests in 1h.

## Action items

- [ ] Alex: wire the feature flag at the dispatch layer (PR #1842).
- [ ] Sam: dashboard for the 5xx watch is up; alert in #ops.
- [ ] Promote to 100% on 2026-04-29 (calendar-blocked).
