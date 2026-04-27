# V2_5_SPEC — Decision Review + Paywall + Real Auth

> Tangerine v2.5: the "money + governance" release. v1.9 disciplined the suggestion surface. v2.0 made the OS visible. v2.5 turns it into a real product you can sign in to and pay for. Co-thinker proposals stop being one-shot writes — they become PRs the team votes on. Cloud paywall flips on. Stub auth dies. Settings collapse from 8 knobs to 2.

## 0. North Star

v2.5 ships **after** v2.0 final and gates the Cloud GA. By week 5-6 end, three things differ for a returning v2.0 user:

1. Co-thinker decision atoms don't auto-commit. A `/reviews` thread opens; teammates vote; 2/3 quorum auto-promotes to `team/decisions/`. Below quorum, banner reads "3 proposals waiting on you."
2. Cloud sign-up is real: email + password OR magic link OR Google/GitHub OAuth. 6-char stub mode (current `app/src/lib/auth.ts:95`) is dead. Trial timer says "14 days left, no card on file."
3. Settings → AGI shows two knobs: master toggle + sensitivity slider 0-100. Old volume/threshold/per-channel-mute is gone or buried.

**Ship target:** v2.5.0 final = v2.0 final + 4-6 weeks. Paywall live, waitlist drained, payments through Stripe.

**Non-goals:** NOT SSO/SAML (v3.5). NOT multi-region (v3.0+). NOT per-feature pricing — flat $5/team/month is the only v2.5 SKU. NOT a new product surface — same shell as v2.0.

## 1. Decision Review (PR-style workflow)

### 1.1 Why

v1.8 / v2.0 co-thinker writes decisions straight into `team/decisions/` via `canvas_writer.rs` after a confidence + propose-lock check. For solo users that's fine. For 2-10 person teams (ICP per BUSINESS_MODEL §3.3), AGI silently committing decisions loses trust the first time it gets one wrong.

v2.5 inserts a review step. Co-thinker proposes; humans vote; only quorum-passed proposals land in `team/decisions/`. Failed/timed-out proposals archived under `team/decisions/.rejected/{slug}.md` so the same drift doesn't get re-proposed next heartbeat.

### 1.2 Atom shape extension

Decision atoms get a new `review` block in frontmatter. Backward compat: atoms missing the block render as "approved" (legacy). Schema:

```yaml
---
title: API shape — REST vs gRPC
proposed_by: co-thinker
review:
  state: pending          # pending|approved|rejected|expired
  quorum_pct: 67          # default 2/3
  team_size_at_propose: 4
  votes:
    - { user: daizhe, vote: up,   ts: ..., comment: "" }
    - { user: hongyu, vote: down, ts: ..., comment: "Already chose REST 4/22" }
  expires_at: 2026-05-19T14:23:01Z   # 7d default
  promoted_at: null
source_refs: [meetings/2026-05-10-eng-sync.md#L42]
---
```

### 1.3 Backend module

New: `app/src-tauri/src/agi/review.rs`. Tauri commands:

| command | purpose |
|---|---|
| `review_propose` | called by `co_thinker.rs` instead of direct decision write; lands in `team/proposals/{slug}.md` |
| `review_vote` | mutates frontmatter; recomputes state |
| `review_list` | powers `/reviews` + sidebar badge |
| `review_set_quorum` | per-team config in `team/config/review.toml` |
| `review_promote` | auto-fires at quorum; also manual override |
| `review_reject` | manual or auto on `expires_at` |

State machine (`review.rs::recompute_state`):

```
pending --(up/team_size >= quorum_pct/100)--> approved → auto-promote
pending --(down/team_size > 1 - quorum_pct/100)--> rejected
pending --(now >= expires_at)--> expired (rejected, reason=timeout)
```

Approved → file moves `team/proposals/` → `team/decisions/` with `review.state: approved` + `promoted_at`. Rejected → `team/decisions/.rejected/`.

### 1.4 Frontend

New route `/reviews` at `app/src/routes/reviews.tsx`. Components in `app/src/components/review/`: `ReviewsList.tsx` (filters pending / mine / all), `ReviewThread.tsx` (body + vote bar + comment thread), `VoteButtons.tsx` (👍 / 👎 / 💬 + tally). `ReviewBadge.tsx` in `app/src/components/sidebar/` shows red dot when pending count > 0 for current user. Sidebar wires "Reviews" entry between "Memory" and "Co-thinker".

### 1.5 Suggestion engine integration

Extends v1.9 §4 table to **12 templates** (after v2.0 added #11 `personal_team_relevant`). New template #12: `proposal_awaiting_vote` — banner, confidence 0.95, fires when atom in `team/proposals/`, current user has not voted, age > 1h. Example: "3 proposals waiting on you". File: `app/src-tauri/src/agi/templates/proposal_awaiting_vote.rs`. CTA → `/reviews?filter=mine`.

### 1.6 Per-team voting threshold

Default 2/3 (67%). Tunable per team via `team/config/review.toml`:

```toml
[quorum]
approval_pct = 67          # promotion threshold
rejection_pct = 50         # early-reject threshold
expiry_days = 7            # auto-expire pending after N days
```

Setting in Settings → Team. Solo teams (size = 1) skip review entirely — quorum check short-circuits when `team_size <= 1`, identical to v2.0 behavior.

### 1.7 Acceptance gates

| # | check |
|---|---|
| R1 | Proposal lands in `team/proposals/`, NOT `team/decisions/` |
| R2 | 2/3 up-votes auto-promotes within 1 heartbeat |
| R3 | Expired proposal moves to `.rejected/` with `reason: timeout` |
| R4 | Solo team (size=1) skips review entirely |
| R5 | Sidebar badge updates within 10s of new proposal |
| R6 | `proposal_awaiting_vote` template fires only after 1h age |

## 2. Paywall Infrastructure

### 2.1 Pricing — locked

Per BUSINESS_MODEL §10 (ratified 2026-04-26): **$5/team/month flat**, no seat tiers, **30-day no-CC trial** (Plausible-style). Layer 2 inference (DeepSeek tokens) bills separately — same Stripe customer, additional usage record sub. v2.5 wires only the base subscription; Layer 2 lands in v2.5.1 patch.

### 2.2 Stripe Connect — architecture

Why Connect over standard Customer: future enterprise tier may need own-currency / VAT / region invoicing. v2.5 uses direct charges with `on_behalf_of=null` (equivalent to standard Customer), but the Connect abstraction is in place — no rework when enterprise unlocks.

| component | tech | file |
|---|---|---|
| Stripe SDK | `stripe-rust` v0.32 + `@stripe/stripe-js` v3 | `app/src-tauri/src/billing/mod.rs`, `app/src/lib/billing.ts` |
| Webhook handler | tide handler on existing daemon | `app/src-tauri/src/billing/webhook.rs` |
| Customer + subscription create | Tauri command | `app/src-tauri/src/billing/stripe.rs` |
| Trial timer state | `team/config/billing.toml` + Stripe `trial_end` | `app/src-tauri/src/billing/trial.rs` |
| Checkout UI | Stripe Checkout opened via `system_open_url` | `app/src/routes/upgrade.tsx` |

**Test mode + placeholder API key:** `.env.example` ships `STRIPE_API_KEY=sk_test_PLACEHOLDER`. v2.5.0-alpha.1 runs against Stripe test mode end-to-end. Live keys land at v2.5.0 final via `.env` (never committed). Webhook testing via `stripe listen --forward-to localhost:8080/webhook`.

### 2.3 Subscription model

`Team (1) ←→ (1) StripeCustomer`, `Team (1) ←→ (0..1) StripeSubscription`. Sub fields: `status: trialing|active|past_due|canceled`, `trial_end`, `current_period_end`, `price_id: price_5usd_team_month`. Every Team (in `app/src-tauri/src/auth/team.rs`) holds `stripe_customer_id` + optional `stripe_subscription_id`.

### 2.4 Trial timer + expiry enforcement

**Frontend:** `app/src/components/billing/TrialBanner.tsx` mounted in AppShell when `subscription.status === "trialing"`. Render: `🍊 14 days left in trial · No card needed · [Upgrade for $5/team/mo]`. `useTrialCountdown()` polls every 5min.

**Backend:** `app/src-tauri/src/billing/trial.rs::is_active(team_id) -> bool` returns `now < trial_end OR status == "active"`. Called by every Tauri command gating Cloud features (Layer 2 inference, cloud sync, marketplace).

**Expiry behavior:** trial-expired with no card → app stays usable for OSS-only features. Cloud features gate-fail with banner: "Trial expired · Upgrade to keep cloud sync running". Local OSS (memory tree, sources, suggestion engine on user's own Cursor Pro) keeps running. **No data loss** — matters for PIPL/trust posture.

### 2.5 Email verify + IP rate limit

**Email verify:** Supabase handles confirm tokens — wire `signup` and `email_change_confirm` flows in `app/src/lib/auth.ts`. v2.5 gates both `signIn` and `signUp` on `email_confirmed_at != null`.

**Provider:** **Postmark** over SendGrid. Better China inbox routing (most v2.5 seed wave is China dev/factory), lower spam-folder rate, simpler templating. $10/mo base.

| provider | base | per-email | China inbox | verdict |
|---|---|---|---|---|
| Postmark | $10/mo | $0.001 | strong | **choice** |
| SendGrid | $20/mo | $0.0008 | medium-weak | runner-up |
| AWS SES | $0 | $0.0001 | varies | rejected — too DIY |

**IP rate limit:** max 3 trial accounts per IP per 30d. `signup_trial` Tauri command hits a Cloudflare Worker fronting the daemon; Worker checks `cf-connecting-ip` against a Redis-backed counter. <$5/mo at v2.5 scale. Disposable-email blocklist (Mailinator, 10minutemail) via `disposable-email-domains` npm list — cuts drive-by abuse.

### 2.6 Stripe webhook handlers

| event | action |
|---|---|
| `customer.subscription.created` | persist `stripe_subscription_id`, flip team to `trialing` |
| `customer.subscription.updated` | refresh `trial_end`, `current_period_end`, status |
| `payment_intent.succeeded` | toast "Payment received — thanks" |
| `payment_intent.payment_failed` | banner "Card declined. Update payment to keep cloud sync running" |
| `customer.subscription.deleted` | set team `canceled`; gate Cloud features |
| `invoice.payment_action_required` | email user Stripe-hosted SCA link |

Signature verify via `stripe::Webhook::construct_event` with `STRIPE_WEBHOOK_SECRET`. Failed verify → 400 + alert. All handlers in `webhook.rs`.

### 2.7 Acceptance gates

| # | check |
|---|---|
| P1 | Sign-up creates Stripe customer + sub with `trial_end = now + 30d` |
| P2 | Webhook signature verification rejects forged events |
| P3 | Trial banner counts down within 1min drift |
| P4 | Cloud feature blocked when trial expired + no card |
| P5 | Email verification required before sign-in |
| P6 | IP rate limit blocks 4th trial signup from same IP |
| P7 | Webhook events update local team config within 10s |

## 3. Supabase Real Auth Migration

### 3.1 Current state

`app/src/lib/auth.ts:89-138` is **stub mode only** — any 6-char password works (`writeStubSession({ email, signedInAt: Date.now() })`). Supabase integration scaffolded in `supabase.ts` but only fires when env keys present; currently they aren't. v2.5 cuts the stub code path; stub survives only behind `TANGERINE_DEV_STUB_AUTH=1` for E2E fixtures.

### 3.2 Auth methods supported

| method | flow | priority |
|---|---|---|
| Email + password | Supabase `signInWithPassword` + email confirm | core |
| Email magic link | Supabase `signInWithOtp` | core |
| Google OAuth | Supabase `signInWithOAuth({ provider: "google" })` | core |
| GitHub OAuth | Supabase `signInWithOAuth({ provider: "github" })` | core |
| Apple SSO | deferred to v2.5.1 | nice-to-have |
| SSO SAML / OIDC | v3.5 enterprise | OUT |

### 3.3 Account model

`User` (uuid from Supabase auth.users, email, email_confirmed_at, default_team_id). `Team` (uuid, name, slug, created_by, stripe_customer_id, stripe_subscription_id, quorum_pct default 67 per §1.6). `TeamMember` (team_id, user_id, role: owner | member | viewer, joined_at). Stored in Supabase Postgres: `users` (auth schema, managed) + `teams` and `team_members` (public schema, ours). Migrations in `app/src-tauri/migrations/v2_5_*.sql`.

### 3.4 Session token in Tauri secure store

Stub puts session in `localStorage`. v2.5: JWT + refresh token via Tauri `keyring` plugin (`tauri-plugin-keyring = "0.1"` in `Cargo.toml`). macOS = Keychain, Windows = Credential Manager, Linux = Secret Service. Refresh token never leaves keyring; access token in memory only.

New: `app/src-tauri/src/auth/secure_store.rs` exposes `auth_store_session(jwt, refresh)` + `auth_load_session()`. Wires into `auth.ts` via new `useAuthStore` replacing current `useState({ loading, signedIn, email })`.

### 3.5 Migration from v1.x stub installs

Existing v1.8 / v1.9 / v2.0 users have stub sessions in `localStorage`. On v2.5 first launch:

1. Read stub session if present.
2. Modal: "We've upgraded auth. Confirm your email to keep your account."
3. User enters email → Supabase magic link → click → JWT issued → keyring stored → stub deleted.
4. Memory tree associated with new Supabase user_id. Team auto-created (`name = "{email_local_part}'s team"`, `role = owner`).
5. Subscription auto-created `trialing` with 30-day trial. Pre-v2.5 users get **6-month grandfather trial** per BUSINESS_MODEL §10.

Abort path: user closes modal → stub preserved, prompt re-shows next launch. Hard cut on v2.6 (3mo later).

### 3.6 Acceptance gates

| # | check |
|---|---|
| A1 | Email + password sign-up → email sent → confirm → signed in |
| A2 | Magic link sign-in works without password set |
| A3 | Google OAuth round-trip completes <5s |
| A4 | JWT in keyring, not localStorage |
| A5 | Refresh token rotation works on access expiry |
| A6 | v1.x stub session migrates via magic link |
| A7 | TANGERINE_DEV_STUB_AUTH=1 still works for E2E fixtures |

## 4. Settings Simplification (8 → 2)

### 4.1 Goal

v1.8 has 8 AGI controls (V2_0_SPEC §5). v2.0 alpha.3 already reduced to 2 visible knobs but the underlying store kept all 8 fields. v2.5 finalizes the cut: master toggle + sensitivity slider 0-100. Old fields become **derived getters**, not user-facing.

### 4.2 Mapping

| sensitivity (0-100) | volume (derived) | confidence_floor (derived) | AGI behavior |
|---|---|---|---|
| 0-30 | silent | 0.95 | Co-thinker observes only — no surfacing. Banner/toast/modal disabled. Brain doc still updates. |
| 30-60 | quiet | 0.85 | Chips only. Banner for cross-route awareness, no toasts. |
| 60-90 | chatty (default = 75) | 0.7 | Full v1.9 tier engine, all 12 templates active. |
| 90-100 | alerts only | 0.6 + force-tier=banner | Surfaces only high-severity / high-urgency, but at louder tier. Useful for "I want fewer interruptions but when AGI speaks I want to notice." |

The "alerts only" mode (90-100) is intentionally a **non-monotonic** tail of the slider — fewer surfacings, but louder. Alternative was a separate toggle, but per CEO feedback patterns (single-knob simplicity), we model it as the high-end of one slider.

Mapping logic in `app/src/lib/ambient.ts::sensitivityToConfig(n: number): { volume, confidence_floor, force_tier }`. Pure function, unit-testable.

### 4.3 Migration

Existing v1.x users auto-mapped on first v2.5 launch (`store.ts::migrateAgiSettings`):

```
silent → 15, quiet → 45, normal → 75, loud → 95
if confidenceThreshold > 0.8: sensitivity -= 10  // user preferred quieter
mutedAgiChannels preserved in storage, not exposed in UI
```

Idempotent. Sets `migrationVersion = "2.5.0"` flag.

### 4.4 UI

Modify `app/src/pages/settings/agi.tsx`. Two visible controls: master toggle + sensitivity slider (`Silent ──●── Alerts`, current value + label "Currently: chatty, all templates"). "Advanced" disclosure (collapsed by default) exposes per-channel mutes + raw confidence_threshold with warning "Advanced settings override the sensitivity slider."

### 4.5 Acceptance gates

| # | check |
|---|---|
| S1 | Settings page renders 2 controls + 1 disclosure |
| S2 | Sensitivity slider live-applies without restart |
| S3 | v1.x auto-migrate to sensitivity within ±10 of expected |
| S4 | Advanced disclosure overrides persist |
| S5 | sensitivity = 0 → no banner/toast/modal renders for 24h dogfood window |

## 5. Cloud Sync Infrastructure

### 5.1 Why now

v1.6 has git memory sync (`app/src/lib/git.ts`) — user configures their own remote (GitHub/GitLab/Gitea/self-host). Setup friction kills adoption for non-devs. v2.5 adds managed cloud sync: Tangerine hosts the git remote per team. **Sign in → memory syncs.**

### 5.2 Architecture

`~/.tangerine-memory/team/` ↔ `git push/pull` ↔ `git.tangerine.cloud/{team_slug}.git`. `~/.tangerine-memory/personal/{user}/` never synced (gitignored per V2_0_SPEC §3.3).

| component | file |
|---|---|
| Sync orchestrator (30s `git fetch; rebase --autostash` on heartbeat) | `app/src-tauri/src/sync/mod.rs` |
| Conflict resolver (local-first; emits `conflict_detected` toast) | `app/src-tauri/src/sync/conflict.rs` |
| Sidebar indicator (✓/↑↑/⚠ + last-sync hover) | `app/src/components/sidebar/SyncIndicator.tsx` |
| Auth (JWT-derived deploy key per team, rotated 90d) | `app/src-tauri/src/sync/auth.rs` |

### 5.3 Conflict resolution

**Local-first + git auto-merge with rebase --autostash.** Rationale: Tangerine atoms are markdown + frontmatter; git 3-way merge handles 95% of conflicts. The 5% that need manual resolution (same line edited twice) surface as toast: "Conflict on `decisions/api-shape.md` — open in editor". User picks a side; sync resumes.

AGI heartbeat writing during a sync rebase: `propose_lock.rs` already serializes writes; sync acquires the same lock for its rebase window.

Hard fallback: 3 consecutive rebase fails → sync pauses for that team, banner surfaces, user manually `git pull --rebase`. Pressure-release valve accepted vs building a complex resolver in v2.5.

### 5.4 Privacy

`team/` syncs (per team). `personal/{user}/` NEVER syncs — gitignored, enforced by template + integration test. `.tangerine/telemetry/` NEVER syncs — same rule. Cloud remote encrypted at rest (Cloudflare R2 SSE-S3), TLS in flight.

### 5.5 Sync indicator UI

Sidebar bottom strip — `↑↑ Syncing 2 atoms` (in-flight) / `✓ All synced · 14s ago` (idle) / `⚠ Conflict in decisions/api-shape.md` (needs attention) / `🌙 Sync paused (offline)`. Hover shows last 3 events; click opens `/sync-log` (30d history).

### 5.6 Acceptance gates

| # | check |
|---|---|
| C1 | First push creates remote at `git.tangerine.cloud/{team_slug}.git` |
| C2 | Local edit → 30s later visible on second machine |
| C3 | Same-line conflict surfaces toast within 30s |
| C4 | `personal/` NEVER appears on cloud remote |
| C5 | Sync pauses on `agiParticipation = false` |
| C6 | Trial-expired team sync gate-fails with banner |

## 6. Implementation Phasing (3 sub-phases over 4-6 weeks)

### v2.5.0-alpha.1 (week 1-2) — Stripe + Supabase + Trial

**Goal:** real signup, 30d trial, trial banner visible. Decision review NOT wired yet.

**Create:**
- `app/src-tauri/src/billing/{mod.rs, stripe.rs, webhook.rs, trial.rs}`
- `app/src-tauri/src/auth/{mod.rs, secure_store.rs, team.rs}`
- `app/src-tauri/migrations/v2_5_001_users_teams.sql`, `v2_5_002_team_members.sql`
- `app/src/lib/billing.ts`
- `app/src/components/billing/TrialBanner.tsx`
- `app/src/routes/upgrade.tsx`
- `app/src/components/auth/{SignUpForm.tsx, SignInForm.tsx}`

**Modify:**
- `app/src/lib/auth.ts` — kill stub-mode default; gate behind `TANGERINE_DEV_STUB_AUTH=1`
- `app/src/lib/supabase.ts` — wire real keys via `.env`
- `app/src/routes/auth.tsx` — render new SignIn/SignUp
- `app/src/lib/store.ts` — add `team`, `subscription` slices; replace `agiVolume` with `agiSensitivity`
- `app/src-tauri/Cargo.toml` — `stripe = "0.32"`, `tauri-plugin-keyring = "0.1"`

**Acceptance:** P1, P2, P3, P5, P6, P7, A1, A2, A4. End-to-end signup → email confirm → trial banner <60s.

### v2.5.0-alpha.2 (week 3-4) — Decision Review + Settings Simplification

**Goal:** proposals route through review queue. Settings collapses to 2 knobs. v1.x auto-migrates.

**Create:**
- `app/src-tauri/src/agi/review.rs`
- `app/src-tauri/src/agi/templates/proposal_awaiting_vote.rs`
- `app/src/routes/reviews.tsx`
- `app/src/components/review/{ReviewsList.tsx, ReviewThread.tsx, VoteButtons.tsx}`
- `app/src/components/sidebar/ReviewBadge.tsx`
- `app/src/pages/settings/team.tsx`

**Modify:**
- `app/src-tauri/src/agi/canvas_writer.rs` — divert decision writes to `team/proposals/` when team_size > 1
- `app/src-tauri/src/agi/templates/mod.rs` — register template #12
- `app/src-tauri/src/agi/co_thinker.rs` — call `review::propose` instead of direct `canvas_writer::write_decision`
- `app/src/components/layout/Sidebar.tsx` — Reviews entry + badge
- `app/src/pages/settings/agi.tsx` — 2 knobs + Advanced disclosure
- `app/src/lib/ambient.ts` — read `agiSensitivity`, derive volume + threshold + force_tier
- `app/src/lib/store.ts` — finalize sensitivity slider + migration

**Acceptance:** R1-R6, S1-S5. v1.9 templates 1-11 + v2.5 template 12 = 12 active total.

### v2.5.0 final (week 5-6) — Cloud Sync + Polish + Public Ship

**Goal:** managed cloud sync live. Public Cloud GA. Waitlist drained.

**Create:**
- `app/src-tauri/src/sync/{mod.rs, conflict.rs, auth.rs}`
- `app/src/components/sidebar/SyncIndicator.tsx`
- `app/src/routes/sync-log.tsx`
- `infra/cloudflare-worker-signup-rate-limit/{wrangler.toml, src/index.ts}`
- `docs/MIGRATION_v2.0_to_v2.5.md`

**Modify:**
- `app/src/components/layout/Sidebar.tsx` — mount SyncIndicator at bottom
- `app/src-tauri/src/agi/co_thinker.rs` — heartbeat tick triggers `sync::run_cycle` every 6th tick
- `README.md` — v2.5 narrative; drop "Cloud coming soon"; add pricing link
- `CHANGELOG.md` — v2.5.0 entry
- Public website — flip "Waitlist" CTA to "Start free trial"

**Acceptance:** C1-C6. Plus 48h dogfood: 3 internal teams (TII team + 2 design partners), no P0 issues.

**Ship:** `v2.5.0` git tag; auto-update fires for v2.0 users on 7-day rollout.

## 7. Per-phase Acceptance Gates

Concrete user actions that must work end-to-end at each phase.

### alpha.1
- Fresh install → email + password sign-up → confirm → signed in → trial banner with 30d countdown
- Trial-state user runs all v2.0 features without payment
- "Upgrade" → Stripe Checkout → card → redirected back → "active subscription" + next billing
- Card-declined webhook → declined banner within 10s
- Sign out → session cleared from keyring → re-sign-in works

### alpha.2
- Team-of-3 AGI proposes decision → atom in `team/proposals/`, NOT `team/decisions/`
- Two up-votes → 2/3 quorum → auto-promoted to `team/decisions/` within 1 heartbeat
- Third teammate sees sidebar badge "1 awaiting" → click → `/reviews?filter=mine` shows promoted proposal
- Solo install (size=1) → AGI writes direct, no review step
- Settings → AGI shows 2 knobs only; v1.x auto-migrated; sliding to 0 silences AGI real-time
- Advanced disclosure exposes per-channel mutes with override warning

### final
- Machine A edit `team/decisions/foo.md` → 30s later visible on machine B (same team)
- Same-line edit on both → conflict toast surfaces on second-to-sync; user resolves; sync resumes
- `personal/` never appears in `git.tangerine.cloud` remote (verified via remote `git log`)
- Trial expires (or clock-skew simulate) → cloud sync gates; payment unlocks <1min
- Public pricing page renders $5/team/month; Stripe Checkout works for new sign-ups
- CHANGELOG v2.5.0 entry; auto-update fires for v2.0 users

## 8. Dependencies + Coordination

### Hard prereqs (cannot start alpha.1)

| dependency | required for |
|---|---|
| v2.0 final shipped (tag `v2.0.0`) | layers on v2.0 surfaces (AgiStrip, graph home, personal/team split) |
| BUSINESS_MODEL §10 ratified (done 2026-04-26) | pricing, trial, license posture |
| Supabase project provisioned | §3 auth |
| Stripe account in test mode | §2 paywall |
| Postmark account | §2.5 email verify |
| Cloudflare Worker for IP rate limit live | §2.5 |
| AGPL+Commercial license cutover done | required for charging money |

### Soft prereqs (parallel-able, ship-blocking)

| dependency | required for |
|---|---|
| `git.tangerine.cloud` git server stack | §5 cloud sync |
| Stripe-Connect onboarding | §2.2 |
| SOC 2 Type II prep in flight | not v2.5 ship-blocking but must be running by ship |
| `infra/` repo for CF Workers + Supabase migrations | §2.5 |

### Cross-team coordination

| owner | deliverable | due |
|---|---|---|
| CTO Hongyu | v2.0 ship | v2.5 alpha.1 start |
| CEO Daizhe | Stripe account + DeepSeek wholesale legal closeout (BUSINESS_MODEL §9 Q1) | alpha.1 + 1wk |
| CEO | Postmark + Cloudflare Worker deploy | alpha.1 + 1wk |
| Compliance owner (TBD §11 Q3) | SOC 2 prep kickoff | alpha.1 (cannot wait) |
| Eng | License cutover Apache → AGPL+Commercial (1 wk, parallel with alpha.1) | before alpha.2 |

## 9. Out of Scope (push to v3.0+)

| item | new target | reason |
|---|---|---|
| SSO / SAML / SCIM | v3.5 enterprise | BUSINESS_MODEL §4.1 — Layer 4 deferred until inbound demand |
| Audit log | v3.5 | SOC 2 Type II covers first 6mo |
| Multi-region routing | v3.0+ | Day-1 China region (DeepSeek-driven) enough; US/EU when revenue justifies |
| Per-feature pricing | v3.0+ | Flat $5/mo starter; tier ladders only if ARPU forces it |
| Per-seat add-on | v3.5 | Anti-pattern per BUSINESS_MODEL §1 |
| Annual billing discount | v2.6 patch | Stripe-native; add post-ship |
| Marketplace launch | v3.5 | BUSINESS_MODEL §10 — needs 5k OSS installs first |
| Mobile read-only viewer | v3.0+ | Desktop dogfood not done |
| Apple SSO | v2.5.1 patch | Google + GitHub cover ICP |
| Nested review threads | v3.0 | Flat thread enough at v2.5 |
| Public team profiles | v3.0 | Privacy posture too aggressive at v2.5 |

## 10. Risks + Mitigations

| # | risk | L | I | mitigation |
|---|---|---|---|---|
| 1 | Stripe webhook drops events → sub state desync | M | H | Idempotent handlers (key on `event.id`); daily cron reconciles via `Subscription::list_for_customer`; `/billing/reconcile` Tauri command; alert on >5min webhook lag |
| 2 | Stub auth migration data loss — user closes mid-flow before JWT issued | M | H | NEVER delete stub until Supabase JWT validated; idempotent prompt re-shows every launch; v2.6 hard-cut announced 90d ahead |
| 3 | Quorum stuck (small team, 1 person OOO 2wk) | H | M | `expiry_days` (default 7) auto-rejects stale; manual `review_promote` override; banner "1 stuck proposal" after 5 days |
| 4 | Sync conflict thrash on same-line AGI+human edit → rebase loop | L | H | `propose_lock.rs` serializes AGI writes with rebase window; 3 consecutive fails → sync pauses + banner; AGI heartbeat blocked until resolved |
| 5 | Trial fraud — single user creates 100 trial accounts | M | M | IP rate limit 3/IP/30d (§2.5); disposable-email blocklist; Stripe `radar.fraud_score` on first paid conversion; manual review on >10 signups from one email-domain |

## 11. Open Questions for CEO (5 specific decisions)

1. **Stripe Connect or Customer-only Day-1.** Spec assumes Connect (`destination=null` v2.5, full Connect v3.5 enterprise) — adds ~3 days over Customer. Default if no answer: Connect with destination=null.

2. **Email provider Postmark vs SendGrid.** Postmark $10/mo + $0.001/email, better China inbox; SendGrid $20/mo + $0.0008/email but more spam-folder. Default if no answer: Postmark for v2.5, revisit at 1k MAU.

3. **SOC 2 ownership.** BUSINESS_MODEL §10 mandates SOC 2 Type II by month 6. (a) founder + Vanta, (b) hire compliance lead, (c) external audit firm. Cannot wait past alpha.1 — evidence collection starts day 1. Default: founder + Vanta ($14k/yr).

4. **Grandfather trial scope.** BUSINESS_MODEL §10 promised 6mo free Cloud to v1.8.1 / v1.9 OSS users. Does v2.0 also qualify? Default: 6mo for all pre-v2.5 users (~200 expected, low margin impact).

5. **License cutover timing.** Apache → AGPL+Commercial (~1wk) — (a) before alpha.1 (clean baseline), (b) parallel with alpha.1, (c) at alpha.2 ship. Default: (b) parallel, lock before alpha.2 gate.

---

*V2_5_SPEC v1.0 draft — 2026-04-26. Pending CEO approval. v2.0 final is hard prereq; do not begin v2.5.0-alpha.1 until that ships. v2.5 is the Cloud GA release — this is when the company starts charging money.*
