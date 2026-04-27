# SOC 2 Incident Response Runbook

Status: `draft` — wave 3 cross-cut scaffold per `OBSERVABILITY_SPEC.md` §9.
Owner: Engineering (this repo) + CEO (audit firm + paperwork). Audit firm
recommendation per spec §11 Q5: Vanta self-serve for v1 (`~$20k all-in`).

This runbook is the on-call playbook for any incident affecting Tangerine
Meeting users. The audit firm reads this; the on-call engineer follows
this; the CEO signs off the post-mortem against this.

## Severity tiers

| Tier | Definition | Response time | Escalation |
|------|------------|---------------|------------|
| SEV-1 | Total outage of cloud sync OR data loss confirmed for any user | 15 min | Page CEO + CTO |
| SEV-2 | Single feature broken (auth, billing webhook, daemon hang) for > 10% of users | 1 hour | Notify CTO |
| SEV-3 | Single feature degraded (> 1× perf budget) OR < 10% user impact | 4 hours | Slack #incidents |
| SEV-4 | Cosmetic / observed-but-tolerable | Next business day | Track in Linear |

Telemetry triggers (per `agi/telemetry.rs`):
- Error rate > 5% over 1h → auto-page SEV-2 (once monitoring backend lights up).
- Cold start p95 > 4s sustained 1h → SEV-3.
- Heartbeat counter flatlines for > 30m on > 5 installs → SEV-2 (daemon dead).
- Stripe webhook 4xx/5xx burst > 10/min → SEV-2.

## On-call response — first 15 minutes

1. **Acknowledge.** PagerDuty / equivalent. Stop the timer.
2. **Snapshot.** Pull `~/.tangerine-memory/.tangerine/logs/{today}.log` from
   the affected install if reachable. Pull last 100 telemetry events from
   `~/.tangerine-memory/.tangerine/telemetry/{today}.jsonl`.
3. **Severity.** Match against the table above. If unsure, escalate up.
4. **Communicate.** Post in `#incidents` with: tier, scope, suspected
   cause, ETA. Keep updates every 15m until mitigated.
5. **Halt the bleed.** If a deploy started the bleed, roll back. If a
   feature flag started it, flip it off. If a third-party (Stripe /
   Supabase / DeepSeek) is the cause, flip the user-visible "service
   degraded" banner via the `feature_flags.json` knob (post v2.5 cut).

## Mitigations by edge case

Per `OBSERVABILITY_SPEC.md` §8 — each row is a documented mitigation, not a
wish list. The on-call uses these as recipes, in order, before improvising.

| Edge case | First action | Validation |
|-----------|--------------|------------|
| Network offline (user-side) | None — the `ConnectionBanner` already lights up + the IPC layer queues writes. | Telemetry shows `navigate_route` events resume after reconnect. |
| Source auth expired | Settings → Sources → reconnect. Banner instructs user. | Source status flips green within 60s. |
| Co-thinker brain corrupt | Daemon auto-recovers via `CoThinkerEngine::recover_from_corrupt`. Quarantine lands at `~/.tangerine-memory/.tangerine/quarantine/co-thinker-{ts}.md`. | Next heartbeat writes a fresh `agi/co-thinker.md`; toast surfaces. |
| Disk full | Banner lights up; daemon enters paused state. | User frees space; daemon resumes on next tick. |
| Stripe webhook outage | Reconcile tick (daemon poll, per BILLING spec) heals. | `billing_status` returns to expected within 1h. |
| DeepSeek outage | Falls through to Ollama if installed; else "AI unavailable" toast. | Heartbeat continues; `channel_used="none"` in telemetry. |
| Two app instances launched | Single-instance plugin focuses the existing window. | New process exits cleanly. |
| Memory root on read-only volume | Hard-fail dialog; user picks another folder. | Boot succeeds with new path. |
| Clock skew | Daemon refuses briefs dated > 24h in the future. | No corrupt observations in `agi/observations/{date}.md`. |
| Git conflict on team pull | Daemon abandons cycle; surfaces "Manual merge needed" banner. | User runs `git mergetool` from the Git surface. |

## Post-incident (within 5 business days)

1. **Root cause** in writing — at least 3 "why?" levels deep.
2. **Mitigation review** — was the runbook followed? Where did it fail? File
   PRs against `OBSERVABILITY_SPEC.md` §8 (catalog) or this runbook for any
   gap that delayed mitigation.
3. **User notification** — if any user-visible failure, send a one-paragraph
   post-mortem email. SOC 2 expects evidence the customer was informed.
4. **Audit trail** — every privileged action taken during the incident is
   already in `~/.tangerine-memory/.tangerine/audit/{date}.jsonl` (per
   `audit_log.rs`). Attach a copy to the incident ticket.
5. **Action items** — file Linear tickets for each prevention item with a
   2-week SLA on the SEV-1 follow-ups, 6-week SLA on SEV-2.

## Backups

Per `OBSERVABILITY_SPEC.md` §9 + `V2_5_SPEC.md`:
- Cloud sync = automatic git mirror to GitHub / GitLab / self-host. Default
  ON for paid teams (per spec §11 Q3).
- Local memory dir `~/.tangerine-memory/` is the source of truth; backups
  are best-effort copies, never the canonical store.
- Restore drill: every quarter, an engineer wipes `~/.tangerine-memory/`,
  pulls the team mirror, and confirms the daemon resumes within 5 min.

## Encryption

- At rest: user-owned disk; we do not encrypt the memory dir by default.
  Cloud sync mirrors are encrypted by the git provider's at-rest scheme.
- In transit: TLS 1.2+ for every cloud call. Cert pinning for Stripe + the
  auth provider once `auth.rs` exits stub mode.

## China region

- Build flag `TANGERINE_REGION=cn` selects DeepSeek + ICP-licensed cloud
  sync host + China-resident telemetry endpoint.
- Audit log + crash log + telemetry stay in-region.
- Incidents affecting China-region installs only escalate within the
  China-resident on-call set.

## Vulnerability handling

- `cargo audit` + `npm audit` run in CI per `OBSERVABILITY_SPEC.md` §9.
- High severity blocks merge; medium triggers a 7-day SLA on a fix PR;
  low gets a tracking ticket.
- External report → `security@tangerineintelligence.ai` → CTO triages
  within 24h business.

## Review cadence

This runbook is reviewed:
- After every SEV-1 (mandatory).
- Quarterly otherwise.
- Before each SOC 2 audit cycle.

Last reviewed: wave 3 cross-cut, see `OBSERVABILITY_SPEC.md` for the
upstream spec changes.
