# V1.9 ACCEPTANCE GRID

> CEO sign-off gates for the v1.9 Suggestion Engine. Each gate maps to a
> concrete user action and the file/test that proves it. A v1.9 PR is
> mergeable when every gate in the phase it claims to satisfy is green.
>
> Spec ref: `SUGGESTION_ENGINE_SPEC.md` §1 (disciplines) and §7 (CI grid).

## Phase 1 — Foundation (v1.9.0-beta.1)

Telemetry + 4 visual tiers + bus + tier engine + dismiss memory.

| # | Gate | Concrete user action → expected outcome | Mechanism |
|---|------|-----------------------------------------|-----------|
| P1.1 | `logEvent("navigate_route", …)` writes one JSON line to `~/.tangerine-memory/.tangerine/telemetry/{YYYY-MM-DD}.jsonl` | User navigates `/today` → `/memory`. Open the day's JSONL file → exactly one event with `from: "/today"`, `to: "/memory"`. | `app/src-tauri/src/agi/telemetry.rs::test_append_event_creates_jsonl_file` |
| P1.2 | Telemetry retention pruning keeps the dir small | Boot the app after backdating a JSONL file by 100 days. App start triggers `prune_old`; backdated file is deleted. | `agi::telemetry::test_prune_old_deletes_stale_files` |
| P1.3 | Concurrent writers don't corrupt the JSONL | 10 parallel `append_event` calls → 10 valid JSON lines, no torn writes. | `agi::telemetry::test_concurrent_appends_no_corruption` |
| P1.4 | Chip tier renders at the input cursor | Type into Cmd+K palette → `<InlineReaction/>` portal anchors next to the input. | `app/src/components/ambient/InlineReaction.tsx` (visual regression covered by routes smoke test) |
| P1.5 | Banner tier renders at the AppShell strip | Push a banner via the bus → strip appears below WhatsNewBanner with brand-orange left border, dismiss × on right. | `app/tests/suggestion-bus.test.tsx::"<Banner/> component"` |
| P1.6 | Toast tier renders at bottom-right with 🍊 dot | `pushToast({ kind: "suggestion", … })` → toast with 🍊 prefix and optional CTA. Auto-dismiss at `durationMs` (default 4000ms). | `suggestion-bus.test.tsx::"pushToast — v1.9 rich form"` |
| P1.7 | Modal tier blocks Esc / backdrop except confirm | `pushSuggestion({ is_irreversible: true, … })` → backdrop click + Esc → onCancel; only Confirm button → onConfirm. | `suggestion-bus.test.tsx::"<Modal/> component"` |
| P1.8 | Modal budget — second modal demotes to banner | Push two irreversible suggestions in one session → first renders as modal, second appears in `bannerStack`. | `suggestion-bus.test.tsx::"modal budget"` |
| P1.9 | Discipline 1: max 1 active banner | Push two banners with priorities 9 and 1 → only the priority-9 banner is rendered. Dismiss it → the priority-1 banner appears. | `suggestion-bus.test.tsx::"bannerStack — Discipline 1"` |
| P1.10 | Discipline 2: confidence floor enforced | Push at confidence 0.65 (below MIN_CONFIDENCE=0.7) → bus drops, telemetry logs `suggestion_dropped` with `reason: below_confidence_floor`. | `suggestion-bus.test.tsx::"respects confidence floor"` |
| P1.11 | Discipline 6: master off-switch silences ALL tiers | Toggle `agiParticipation` to false. Push a chip / banner / toast / modal request — every queue stays empty. | `suggestion-bus.test.tsx::"respects agiParticipation off"` |
| P1.12 | Tier selector is a pure deterministic function | `selectTier({ is_irreversible: true })` → `"modal"`; `selectTier({ is_completion_signal: true })` → `"toast"`; etc. | `app/tests/suggestion-tier.test.ts` (existing) |

## Phase 2 — Templates (v1.9.0-beta.2)

7 rule-based templates + registry + heartbeat integration + frontend listener.

### 2.0 Registry / dispatch

| # | Gate | Concrete user action → expected outcome | Mechanism |
|---|------|-----------------------------------------|-----------|
| P2.0.1 | Registry lists all 7 templates | `cargo test agi::templates::registry::test_registry_has_7_templates` — `all_templates().len() == 7`. | `app/src-tauri/src/agi/templates/registry.rs` |
| P2.0.2 | Every template has a unique stable id | Names match the 7 ids in spec §4 with no duplicates. | `registry::test_registry_template_names_are_unique_and_complete` |
| P2.0.3 | `MAX_PER_HEARTBEAT = 3` truncates emit list | Stage a memory dir where 4+ templates fire → `evaluate_all` returns ≤ 3 matches; top 3 by priority desc. | `registry::test_evaluate_all_caps_at_max` |
| P2.0.4 | Stable sort — ties keep registration order | Equal-priority matches retain `all_templates()` order so test assertions are deterministic. | `registry::test_evaluate_all_returns_top_priority_first` |
| P2.0.5 | Heartbeat dispatches via registry on every path | Skip-path / dispatch-error path / main path each call `evaluate_templates` once — no per-template glue lives in `co_thinker.rs`. | `agi/co_thinker.rs` marker block search: `"=== v1.9 P2"` (3 occurrences, one per path) |
| P2.0.6 | Frontend listener is single-instance + consolidated | Only one `listen<TemplateMatchPayload>("template_match", …)` in `AppShell.tsx`. | `grep -c 'listen.*template_match' app/src/components/layout/AppShell.tsx` → 1 |

### 2.1 Per-template gates

Each template fires when its trigger condition is met AND the resulting
`pushSuggestion(...)` produces the right tier on the frontend.

| # | Template | Concrete user action → expected outcome | Mechanism |
|---|----------|-----------------------------------------|-----------|
| P2.T1 | `deadline_approaching` (P2-A) | Open a meeting/decision atom with frontmatter `due_at: <36h from now>` → toast "Meeting in 36h" appears within next heartbeat. Priority maps: <12h → 8, 12-24h → 6, 24-48h → 4. Confidence pinned at 0.95. | `agi::templates::deadline::test_deadline_*` |
| P2.T2 | `pattern_recurrence` (P2-A) | Search for "pricing" 6× in the last 7d → chip "You mentioned 'pricing' 6 times" anchors at the most-recently-touched pricing atom. Below 5 mentions → silent. Stopwords ("the", "and", …) never count. | `agi::templates::pattern_recurrence::test_pattern_recurrence_*` |
| P2.T3 | `conflict_detection` (P2-A) | Two decision atoms with semantically-opposing keywords on the same project → banner "Decision X conflicts with decision Y". Confidence ≥ 0.85. | `agi::templates::conflict::test_conflict_*` |
| P2.T4 | `decision_drift` (P2-B) | Decision A on `tangerine-pricing` says $20/seat; B written ≥ 1 day later says $10/seat → banner "Decision drift on tangerine-pricing: $20 → $10. Lock?". Priority 9. Confidence 0.78. | `agi::templates::decision_drift::*` |
| P2.T5 | `long_thread` (P2-B) | Thread atom (any source) with ≥ 10 messages and no `summary:` frontmatter → toast "Pricing thread has 12 messages. I summarized — _threads/pricing.md_". Confidence 0.85. Priority 4. Once `summary:` exists → silent. | `agi::templates::long_thread::*` |
| P2.T6 | `catchup_hint` (P2-B) | App boot after ≥ 24h offline + ≥ 1 atom mtime > last `navigate_route` ts → banner "**N things changed since you were last here.** D decisions locked. Click for catchup." Priority 10. Confidence 0.9. Empty telemetry → silent. | `agi::templates::catchup_hint::*` |
| P2.T7 | `newcomer_onboarding` (P2-C) | Fresh install — `~/.tangerine-memory/` has < 5 user atoms AND no telemetry events older than 24h → toast "Welcome 🍊. Connect a source so Tangerine can see your team's actual workflow. Discord works in 2 minutes." Priority 10. Confidence 1.0. CTA "Connect Discord" → `/sources/discord`. Fires once per install lifetime via `newcomerOnboardingShown` latch. | `agi::templates::newcomer_onboarding::*` + `app/tests/template-listener.test.tsx` |

### 2.2 Discipline gates (cross-template)

| # | Gate | Concrete user action → expected outcome | Mechanism |
|---|------|-----------------------------------------|-----------|
| P2.D.1 | Newcomer fires only once per install | Open a fresh install — toast appears. Dismiss it. Restart the app, force a heartbeat — no toast. | `template-listener.test.tsx::"newcomer flag stops re-fire"` |
| P2.D.2 | Other templates not gated by newcomer latch | After dismissing newcomer toast, deadline / drift / catchup_hint still fire normally. | `template-listener.test.tsx::"latch is per-template"` |
| P2.D.3 | Off-switch silences template emits at the bus | Toggle `agiParticipation` off, fire any template — bus drops with telemetry `suggestion_dropped reason=agi_participation_off`. | `suggestion-bus.test.tsx` (existing P1 test covers all sources) |
| P2.D.4 | Confidence < user threshold drops at the bus | Set `agiConfidenceThreshold` to 0.95, fire `decision_drift` (confidence 0.78) → drops silently with `reason: below_confidence_floor`. | `suggestion-bus.test.tsx::"respects confidence floor"` |
| P2.D.5 | Frontend listener forwards every signal flag | Synthetic event with `is_irreversible: true` → bus routes to modal queue. With `is_completion_signal: true` → toast. | `template-listener.test.tsx::"forwards every signal flag"` |
| P2.D.6 | Telemetry per-emit observability | Every emitted match logs `template_matches_emitted: N` to the heartbeat observation log. | `agi/observations/{date}.md` line shape `templates=N` |

## Phase 3 — Suppression + modal confirms + polish (v1.9.0-beta.3)

Three workstreams land together in beta.3:

- **P3-A** — telemetry-driven dismiss-to-suppression backend
- **P3-B** — modal confirms for the two irreversible canvas / Slack actions
- **P3-C** — dark-mode polish + a11y + suggestion routing edge cases

Each workstream owns its gates below; the bus + tier components are shared.

### Gate P3.1 — Suppression mechanism (P3-A)

- [ ] Telemetry-driven: dismiss `deadline_approaching` for atom A 3 times within 7 days → entry in `~/.tangerine-memory/.tangerine/suppression.json` with `suppressed_until = now + 30d`, `count = 3`, telemetry log `dismiss_promoted_to_suppressed`.
- [ ] After suppression: same `{template, scope}` no longer triggers (`pushSuggestion` returns with `reason: suppressed`).
- [ ] Different scope (atom B, or `surface_id` swap) still triggers — suppression is per-scope, not global.
- [ ] Suppression expires after 30d (test via mocked `now` 31d in the future → entry purged on next read).
- [ ] Settings → AGI tab shows suppressed list (`st-agi-suppression-{template}`); Clear button (`st-agi-clear-suppression`) wipes the file + clears the in-memory snapshot.
- [ ] Bus consults suppression via `suppressionCheckImpl` seam — tests can stub for determinism.

### Gate P3.2 — Modal confirm for irreversible actions (P3-B)

- [ ] Canvas "Propose as decision" → modal "Lock this as a decision?" first; Cancel does not write the atom.
- [ ] Modal Confirm → decision atom appears at `/memory/decisions/canvas-{topic}-{stickyid}.md` with frontmatter `is_decision: true`.
- [ ] Modal Cancel → no decision atom written, no telemetry `decision_locked` event.
- [ ] First Slack writeback toggle → modal "Tangerine wants to publish to #channel — confirm?" before publishing; second toggle in the same session skips modal (session-scoped opt-in stored in zustand `slackPublishConfirmed`).
- [ ] Modal budget per spec §3.4: ≤ 1 modal per session. The 4th proactive `pushSuggestion` with `is_irreversible: true` demotes to a banner + logs `modal_budget_exceeded` (the bus already enforces this; the modal-confirm UI inherits the cap).
- [ ] Programmatic confirms (canvas / Slack) are exempt from the budget — they are user-initiated, not AGI-proactive.

### Gate P3.3 — Polish coherence (P3-C)

- [ ] Dark mode token coherence: Banner / Modal card / Toast (suggestion variant) all respect `--ti-bg-elevated`; backdrop alpha is 40% in light, 60% in dark; 🍊 dot stays `#CC5500` in both modes (no filter).
- [ ] Modal Esc → cancel still works (P1-B regression check).
- [ ] Banner × button is dismissable via Tab + Enter (default `<button>` semantics) and has `focus-visible:ring` so keyboard users see focus.
- [ ] Banner has `role="alert"` aria attribute; Modal has `role="dialog"` + `aria-modal="true"` + `aria-labelledby` pointing at the title.
- [ ] Suggestion accept (chip CTA / Banner CTA / Modal Confirm) → 200ms green flash via `.ti-accept-flash` keyframe before the host pops the entry off the queue.
- [ ] Silent volume + irreversible exception: `agiVolume === "silent"` drops banner / toast / chip with `reason: agi_volume_silent`, but STILL shows modal when `is_irreversible === true` (Polish 3 — covered by `suggestion-bus.test.tsx::"silent volume STILL shows an irreversible modal"`).

### Gate P3.4 — 6 disciplines re-check

| Discipline | Test |
|---|---|
| 1. Max 1 active suggestion per tier | open route, push 2 banners → only highest-priority renders (`bannerStack — Discipline 1`) |
| 2. Confidence > 0.7 floor | `pushSuggestion` w/ confidence 0.5 → dropped (`respects confidence floor`) |
| 3. Dismiss × 3 → 30d | covered by P3.1 |
| 4. 4 visual tiers | manual Storybook test — chip / banner / toast / modal each render distinctly (P5.3 automates this) |
| 5. Rule-based < 10ms | `agi::templates::registry::test_evaluate_all_caps_at_max` proves dispatch is sync; benchmark in P5.1 verifies p95 |
| 6. Off switch | `agiParticipation === false` → all surfaces silent. **Modal exempt only when `is_irreversible === true`** per Polish 3 (silent ≠ off; off blocks everything including modal). |

## Phase 4 — LLM hook (v1.9.0 final, planned)

Stubs for the next phase — gates not yet enforceable in CI. v1.9.0 final ships when these land plus any remaining Phase-3 polish bugs.

| # | Gate | Concrete user action → expected outcome | Mechanism |
|---|------|-----------------------------------------|-----------|
| P4.1 | `agi_suggest_async` Tauri command exists | Cmd+K → "What should I be paying attention to?" → command fires, LLM dispatch runs in tokio task, result lands on the WS event the daemon already runs. | TBD — new command `commands::agi_suggest_async` |
| P4.2 | LLM sentinel parser accepts well-formed `SUGGEST:` lines | Mock LLM response: `SUGGEST: tier=banner template=llm_priority body=… confidence=0.88` → enqueues a banner with the same shape as rule-based templates. | TBD — `agi::suggestion_parser::parse_sentinel` |
| P4.3 | LLM hallucination protection | Sentinel without `template=llm_<slug>` prefix OR confidence < 0.85 → silent drop, no fallback rendering. | TBD — parser unit tests |
| P4.4 | LLM cost rate limit | Max 1 LLM-suggest per 30 min globally; subsequent invocations reuse the cached suggestion until window elapses. | TBD — token bucket in `agi_suggest_async` |
| P4.5 | LLM call never blocks UI | Mock LLM with 5s delay → input field stays responsive throughout. | TBD — integration test |
| P4.6 | Final polish bug-bash | Any P3-C polish bugs surfaced during beta.3 dogfooding (focus-trap edge cases, dark-mode contrast, token drift) close before GA tag. | TBD — bug list in this file's "P4 punchlist" subsection |

## Phase 5 — v2.0 visualization pillar (planned)

Phase 5 is no longer "v1.9 GA polish" — that work merged forward into Phase 4
once beta.3 closed the polish gap. Phase 5 is now the **v2.0 visualization
pillar** (real-time graph view of the AGI's grounding, see `V2_0_SPEC.md`).

| # | Gate | Concrete user action → expected outcome | Mechanism |
|---|------|-----------------------------------------|-----------|
| P5.1 | Each rule-based template detector < 1ms p95 | `cargo bench --bench templates` — 7-template eval on a 1k-atom memory dir < 7ms p95. | TBD — `app/src-tauri/benches/templates.rs` |
| P5.2 | Cloud-sync telemetry opt-in default OFF | Fresh install: `agi.cloud_sync_telemetry` is false; only event/template/tier sync, never atom content. | TBD — Settings → AGI tab |
| P5.3 | Visual regression for 4 tiers | Storybook stories pass screenshot diff for chip / banner / toast / modal in light + dark themes. | TBD — `app/.storybook/` + Chromatic |
| P5.4 | Acceptance grid runs in CI on every PR | GitHub Actions runs `cargo test --all` + `npm test` + storybook visual diff; PR cannot merge with any phase-claimed gate failing. | TBD — `.github/workflows/v1_9_acceptance.yml` |
| P5.5 | Live grounding graph | `/co-thinker` route renders a force-directed graph of the last 50 heartbeats × the atoms they grounded against; suggestion sources are colour-coded by tier. | TBD — `V2_0_SPEC.md` §2 |
| P5.6 | "Why this suggestion?" inspector | Click any active chip / banner / toast / modal → side panel shows template, confidence, atoms used, prior suppressions. | TBD — `V2_0_SPEC.md` §3 |

## Sign-off

| Phase | Status | Sign-off |
|-------|--------|----------|
| Phase 1 — beta.1 | All gates green | 2026-04-26 |
| Phase 2 — beta.2 | All gates green | 2026-04-26 |
| Phase 3 — beta.3 | P3-A + P3-B + P3-C gates listed; gates close as each workstream merges | 2026-04-26 (this PR — P3-C polish landed) |
| Phase 4 — final  | LLM hook + final polish bug-bash; stubs only | — |
| Phase 5 — v2.0   | Visualization pillar (`V2_0_SPEC.md`); stubs only | — |
