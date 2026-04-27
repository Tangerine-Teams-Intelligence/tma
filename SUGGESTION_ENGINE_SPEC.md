# SUGGESTION_ENGINE — v1.9 Master Spec

> Tangerine's proactive suggestion layer. v1.8 built the infrastructure (ambient observer + chip + co-thinker brain + volume control). v1.9 adds discipline + 4-tier visual hierarchy + 8-10 rule-based templates + Stage 2 LLM hook.

## 0. North Star

Tangerine surfaces proactive suggestions where the user already is — in the input field, in the route they just opened, in the meeting they just finished. No chatbot tab. No "ask me anything" prompt. The suggestion engine is the AGI's only outward-facing surface.

**Non-goals:** NOT a chatbot. NOT replacing route-level views (Canvas / Memory / /today render their own data; suggestions sit on top). NOT a notification firehose — the 6 disciplines below are the test for shipping any new template.

## 1. The 6 Anti-Clippy Disciplines (immutable)

| # | Discipline | v1.8 status | v1.9 work |
|---|------------|-------------|-----------|
| 1 | Max 1 active suggestion (no chip-stacking) | Partial — observer caps 3 stacked; not policy-enforced | Single tier-engine queue; new high-priority replaces, lower-priority queues |
| 2 | Confidence > 0.7 floor | Done — `MIN_CONFIDENCE = 0.7` in `lib/ambient.ts:64` | None (carry forward) |
| 3 | Dismiss × 3 → suppress 30 days | Missing — only 24h throttle exists (`THROTTLE_24H_MS`) | Add `dismissCounts` slice + 30d suppression promotion |
| 4 | 4 visual tiers (chip < banner < toast < modal) | Only chip exists (`InlineReaction.tsx`) | Build banner + toast + modal + tier-selection engine |
| 5 | Rule-based < 10ms / LLM async never blocking | Mixed — observer awaits LLM dispatch | Rule templates fire on Rust event bus < 10ms; LLM runs in background queue |
| 6 | Anti-Clippy off switch | Done — `ui.agiParticipation` boolean (`store.ts:141`) | Document + ensure off-switch gates ALL 4 tiers, not just chip |

**Lock:** any v1.9 PR that violates one of these gets bounced. CI test grid in §7.

## 2. Action Telemetry (foundation)

The tier engine + dismiss-suppression need a single source of truth for "what did the user just do." We log every suggestion-relevant action to a local append-only JSONL file. v1.8 had no telemetry — every dismiss disappeared into the void.

### 2.1 What we log

| event | trigger | payload schema | retention |
|-------|---------|----------------|-----------|
| `navigate_route` | React Router transition | `{ from, to, ts }` | 30 days |
| `edit_atom` | memory file write (Rust `canvas_writer` / `memory.ts`) | `{ rel_path, op: "create"\|"update"\|"delete", ts }` | 90 days |
| `surface_shown` | tier engine renders any tier | `{ surface_id, tier, template_id, confidence, ts }` | 90 days |
| `dismiss_chip` | InlineReaction × clicked, Esc, or click-outside | `{ surface_id, template_id, ts }` | 90 days |
| `accept_suggestion` | user clicks the suggestion's primary CTA | `{ surface_id, template_id, action_taken, ts }` | 90 days |
| `mute_channel` | user toggles `mutedAgiChannels` | `{ channel, muted: bool, ts }` | 90 days |
| `dismiss_promoted_to_suppressed` | 3rd dismiss of same `topic_key` within 7d | `{ topic_key, ts, until_ts }` | 365 days |

Topic key = `{template_id}:{primary_atom_path}` — distinct from surface id (which is DOM-level). Surface dismisses 24h-throttle a single visual location; topic dismisses 30d-suppress a semantic class.

### 2.2 Storage

- Path: `~/.tangerine-memory/.tangerine/telemetry/{YYYY-MM-DD}.jsonl`
- Format: one JSON object per line. Append-only.
- Rotation: file per day, 90-day retention swept on app boot (config: `telemetry.retention_days`).
- Writer: new Rust module `app/src-tauri/src/agi/telemetry.rs` exposed via Tauri command `telemetry_log`.

### 2.3 Privacy

Local-only by default. No cloud sync. Cloud sync is opt-in via Settings → AGI → "Send anonymized telemetry to Tangerine" (default OFF). When opt-in: only `event` + `template_id` + `tier` + bucketed timestamps cross the wire. Atom paths and content NEVER leave the device. This matches the same Sources principle: `local-first, cloud opt-in`.

## 3. 4 Visual Tiers

Each tier has one component, one mounting policy, one dismiss model. Tier escalation is unidirectional — a banner can be re-rendered as a toast on user accept; a toast cannot become a modal mid-flight.

### 3.1 Chip (lightest)

Exists. `app/src/components/ambient/InlineReaction.tsx` — 280px portal card with 🍊 dot, anchored to input element, fade-in 200ms, dismiss × / Esc / click-outside.

- **Use case:** contextual hint while typing. Decision-latent reword. Pattern recurrence callout.
- **Lifetime:** until dismiss or anchor unmount.
- **Mute key:** per-channel via `mutedAgiChannels`.
- **No new work** v1.9 — wire it into the tier engine.

### 3.2 Banner (new v1.9)

New component: `app/src/components/ambient/SuggestionBanner.tsx`. Mounted at AppShell layer. Single banner slot at top of route content.

- **Use case:** cross-route awareness — "3 unresolved decisions", "Decision drift detected: pricing", "5 things changed since you were last here".
- **Persistence:** until user dismisses OR underlying condition resolves (banner re-checks its own condition every 60s; auto-clears when false).
- **Visual:** full-width, 48px tall, brand orange #CC5500 left border, ink-700 text, dismiss × on right.
- **Mute key:** per-template via dismiss memory.

### 3.3 Toast (new v1.9)

New component: `app/src/components/ambient/SuggestionToast.tsx`. Reuse the existing `ui.toasts` array in `store.ts:160` — already has `pushToast` / `dismissToast` plumbing for system messages. Add `kind: "suggestion"` discriminant.

- **Use case:** action completion / one-time notice — "Decision draft created", "3 action items have no assignee", "Tangerine summarized this 17-msg thread".
- **Lifetime:** auto-dismiss 4s, or until user clicks.
- **Stack:** max 1 visible suggestion-toast at a time; queue overflow drops oldest.
- **Mute key:** per-template; system toasts (errors / network) are NOT mutable.

### 3.4 Modal (new v1.9, RARE)

New component: `app/src/components/ambient/SuggestionModal.tsx`. The escape hatch tier for confirm-required actions.

- **Use case:** hard-stop confirmation when AGI is about to take an irreversible action — "Tangerine wants to publish this decision to #engineering — confirm?", "Auto-merge brain doc with edit conflict — pick a side?".
- **Lifetime:** blocking — modal renders only when user is at-keyboard (input focus event in last 5s) so we don't ambush an idle user.
- **Limit:** max 1 modal per session. A second modal-tier suggestion in the same session demotes itself to a banner with the same content.
- **Mute key:** modals are NOT user-muteable; only the master `agiParticipation` switch silences them.

### 3.5 Tier selection rules

| signal | severity | tier | rationale |
|--------|----------|------|-----------|
| Inline / per-input contextual | low | chip | Doesn't claim screen real estate beyond the surface |
| Cross-route, condition-bound | medium | banner | Persistent until resolved — survives route changes |
| One-shot completion notice | low | toast | Self-clearing; not worth dismissing |
| Irreversible action confirm | high | modal | Hard-stop; demotes to banner if budget consumed |
| Confidence < 0.85 + cross-route | medium | banner (NOT modal) | Modal reserved for confidence ≥ 0.85 + irreversibility |

Decision logic in new module: `app/src/lib/suggestion-engine.ts::selectTier(template, ctx) → Tier`. Pure function, unit-testable. Fed by the rule template's declared `severity` + `urgency` + `irreversible` flags.

## 4. Rule-Based Templates (10)

Each fires on a deterministic Rust-side event with sub-10ms detection. LLM is NOT in the path. Templates live in `app/src-tauri/src/agi/templates/{template_id}.rs`. A new dispatcher `agi/templates/mod.rs::evaluate_all(event)` runs every registered template against a single incoming event.

| # | name | trigger | tier | confidence_floor | example payload |
|---|------|---------|------|------------------|-----------------|
| 1 | `stale_rfc` | RFC atom mtime > 4d AND zero comments | banner | 0.9 | "Sarah's 4/22 RFC has 0 comments — bump or close?" |
| 2 | `decision_drift` | 2+ atoms touch same `topic_key` with conflicting decision keywords | banner | 0.85 | "Pricing drift: $20/seat (4/22) ↔ Vercel-style (4/26)" |
| 3 | `deadline_approaching` | atom frontmatter `due_at` within 48h, status != done | toast | 0.95 | "Patent P0 attorney RFP — 4/30 (2 days)" |
| 4 | `pattern_recurrence` | same topic mentioned 5+ times in 7d window | chip | 0.8 | "You mentioned 'pricing' 7× this week — lock?" |
| 5 | `decision_latent` | meeting transcript line matches `^(should|do we|are we) .* \?$` | chip | 0.75 | "This sounds unresolved: 'should we use Postgres?'" |
| 6 | `newcomer_onboarding` | first launch, sources count = 0 | toast | 1.0 | "Connect a source to start the feed" |
| 7 | `conflict_detection` | atom embedding cosine > 0.85 with semantically-opposing atom | banner | 0.85 | "This decision contradicts decisions/api-shape-20260418.md" |
| 8 | `action_item_escape` | meeting summary atom has unassigned action-item bullet | chip | 0.8 | "3 action items have no assignee" |
| 9 | `long_thread` | thread atom with msg count ≥ 10 | toast | 0.9 | "Tangerine summarized this 17-msg thread" |
| 10 | `catchup_hint` | app boot, last_opened_at > 24h ago, atom delta ≥ 3 | banner | 1.0 | "5 things changed since you were last here" |

**Performance budget:** each template's detector runs synchronously on the heartbeat event bus. Total budget across 10 templates: < 10ms p95. Embedding-based templates (#7) use a precomputed nearest-neighbor index (FAISS-rs or fallback flat) refreshed once per heartbeat — the suggestion path itself reads the index, not the model.

**Confidence:** the floor in the table is what the template emits. The user's `agiConfidenceThreshold` (0.5–0.95 slider) is a global gate ON TOP of the floor — Math.max wins, same as v1.8.

## 5. LLM Hook (Stage 2)

Rule-based templates handle 80% of useful suggestions. LLM-driven suggestions cover the long tail: novel topics the rule grammar doesn't predict.

### 5.1 When LLM is invoked

- After every heartbeat: dispatch one LLM call with the brain doc + last 10 telemetry events. Prompt = "are there any suggestions you'd surface that the rule templates wouldn't?"
- On user explicit ask via Cmd+K: "what should I be paying attention to?"
- Never on input keystroke (that's the chip path, already in v1.8).
- Never blocking the UI thread — all calls go through a tokio task spawned off the heartbeat tick.

### 5.2 Dispatch path

Reuse v1.8's `session_borrower::dispatch` (`app/src-tauri/src/agi/session_borrower.rs`). Cursor Pro / Claude Pro / Ollama / browser-ext. No API key. New endpoint: `agi_suggest_async` Tauri command — fires-and-returns; result lands on the websocket the daemon already runs (`ws_server.rs`).

### 5.3 Promotion to suggestion

LLM output parsed for sentinel pattern: `SUGGEST: tier=<chip|banner|toast|modal> template=llm_<slug> body=<…> confidence=<0..1>`. Parser in new module `app/src-tauri/src/agi/suggestion_parser.rs`. Successful parse → enqueued with the same shape as rule-template output. Tier engine doesn't distinguish source.

If parse fails or confidence < threshold, drop silently — no fallback rendering. Same contract as the existing co-thinker grounding rule (`co_thinker.rs:608` `validate_and_ground`).

## 6. Implementation Phasing

### v1.9.0-beta.1 (week 1-2) — foundation

- Action telemetry: new module `app/src-tauri/src/agi/telemetry.rs`, Tauri command `telemetry_log`, JSONL writer with rotation.
- Tier components: `SuggestionBanner.tsx`, `SuggestionToast.tsx` (no modal yet).
- Tier engine: `app/src/lib/suggestion-engine.ts` with `selectTier()`, `enqueueSuggestion()`, single-active-queue policy.
- Wire into AppShell mounting points.

### v1.9.0-beta.2 (week 2-3) — first 5 templates

- `stale_rfc`, `decision_drift`, `deadline_approaching`, `pattern_recurrence`, `decision_latent`.
- New module: `app/src-tauri/src/agi/templates/mod.rs` + 5 template files.
- Heartbeat dispatcher integration in `co_thinker.rs::heartbeat()`.

### v1.9.0-beta.3 (week 3-4) — modal + remaining 5 templates + suppression

- `SuggestionModal.tsx`.
- 5 more templates: `newcomer_onboarding`, `conflict_detection`, `action_item_escape`, `long_thread`, `catchup_hint`.
- Dismiss × 3 → 30d suppression: extend `lib/ambient.ts` with `dismissCounts: Record<topic_key, { count, last_ts }>` slice.

### v1.9.0 final (week 4-5) — LLM hook

- `agi_suggest_async` command + WS event push.
- LLM sentinel parser.
- Acceptance grid CI integration.
- Polish + perf pass (each template under 1ms detection budget verified in benchmark suite).

## 7. Acceptance Grid (CEO 验收)

| # | check | mechanism |
|---|-------|-----------|
| 1 | Each tier renders correctly in isolation | 4 storybook stories, 1 per tier |
| 2 | Tier-selection deterministic for all 10 templates | unit test grid: 10 templates × 4 expected tiers |
| 3 | Discipline 1: Max 1 active suggestion across tiers | integration test: enqueue 3 → assert 1 visible, 2 queued |
| 4 | Discipline 2: confidence < 0.7 → never shown | property test on shouldShowReaction (existing v1.8 test extended) |
| 5 | Discipline 3: 3 dismisses → 30d suppression | unit test on dismissCounts state machine |
| 6 | Discipline 4: 4 tiers exist + render | visual regression test |
| 7 | Discipline 5: rule template detect < 10ms p95 | criterion benchmark in `app/src-tauri/benches/templates.rs` |
| 8 | Discipline 5: LLM call never blocks UI thread | integration test: spawn LLM mock with 5s delay, assert UI input remains responsive |
| 9 | Discipline 6: agiParticipation=false → all tiers silent | integration test toggling the master switch + sending an event of each template type |
| 10 | Telemetry append-only + survives daily rotation | integration test writing across day boundary |
| 11 | Privacy: cloud-sync opt-in default OFF | check default state in store hydrate |

## 8. Out of Scope (push to v2.0)

- Cross-team suggestion learning (privacy: needs federated approach, not v1.9 scope).
- Suggestion ranking via user-feedback ML (need 3+ months of telemetry first).
- Custom AGI personas / per-user tone tuning.
- Mobile rendering (desktop-only this release).
- Multi-language suggestion templates (English only v1.9; Chinese in v2.0).
- Voice-driven suggestion delivery.
- Suggestion → action automation (e.g., auto-create RFC). v1.9 only suggests; user always decides.

## 9. Risks + Mitigations

| risk | likelihood | impact | mitigation |
|------|-----------|--------|------------|
| Noise overwhelm — 10 templates fire simultaneously | high | high | Single-active-queue + tier priority; templates compete for the slot, lose silently |
| Privacy leak via telemetry cloud sync | low | critical | Opt-in default OFF; only event/template/tier sync, never atom content; documented in §2.3 |
| LLM cost spike from `agi_suggest_async` running every heartbeat | medium | medium | Reuse session_borrower (no API key, free tier). Add rate limit: max 1 LLM-suggest per 30 min. |
| LLM hallucination produces fake suggestion (e.g., "RFC due tomorrow" when no such RFC) | medium | high | Sentinel parser requires `template=llm_<slug>` AND confidence ≥ 0.85; rule-based templates handle the 80% safe path |
| Off-switch (agiParticipation) regression — modal slips through | low | critical | Acceptance test #9 in CI; gate ALL 4 tier components on the master switch at the engine layer, not per-component |
| Embedding index cost balloon on memory tree > 10k atoms | medium | medium | Lazy-load index, page-faulted; only #7 conflict-detection depends on it; if cost too high, gate template #7 behind feature flag |
| Dismiss-counts state grows unbounded | low | low | Auto-prune entries older than 30d on every write; same pattern as `pruneDismissed` in v1.8 |

## 10. Open Questions for CEO

1. **Tier 4 budget** — modal limited to 1 per session. Is "session" = app launch, or rolling 24h? Spec assumes app launch — confirm.
2. **Suppression scope** — 3 dismisses of `template=stale_rfc, atom=decisions/foo.md` suppresses just that atom for 30d, or the entire `stale_rfc` template across all atoms? Spec assumes per-`{template_id}:{atom_path}` (narrow). Wider could be useful for power-users who hate one template entirely.
3. **LLM-hook autonomy** — should LLM-emitted suggestions surface at the same priority as rule-based, or always one tier lower? (e.g., LLM never escalates to modal.) Spec gives them parity.
4. **Confidence display** — show the user the confidence number (e.g., "82% match")? Risk = looks gimmicky / fake-precise. Reward = teaches user to trust the system. Spec assumes hide.
5. **Catchup hint (template #10)** — 24h offline threshold or shorter? For the always-on power-user, even a 4h gap might warrant the banner. Spec defaults to 24h but worth tuning by feedback.
