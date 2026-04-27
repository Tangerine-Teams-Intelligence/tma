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

## Phase 3 — Modal + dismiss-suppression (v1.9.0-beta.3, planned)

Stubs for the next phase — gates not yet enforceable in CI.

| # | Gate | Concrete user action → expected outcome | Mechanism |
|---|------|-----------------------------------------|-----------|
| P3.1 | Dismiss × 3 → 30d suppression of `{template}:{atom}` | Dismiss the same `decision_drift:{atom}` 3× within 7d → 4th heartbeat that would fire it drops with telemetry `dismiss_promoted_to_suppressed`. | TBD — extend `lib/ambient.ts` with `dismissCounts` slice |
| P3.2 | Suppression auto-prune | Entries older than 30d are removed on every write to `dismissCounts`. | TBD — `pruneSuppressed` mirror of existing `pruneDismissed` |
| P3.3 | Modal renders only when user is at-keyboard | Modal tier checks `lastInputFocusEvent < 5s` before rendering; otherwise queues for next keystroke. | TBD — `<ModalHost/>` extension |

## Phase 4 — LLM hook (v1.9.0 final, planned)

| # | Gate | Concrete user action → expected outcome | Mechanism |
|---|------|-----------------------------------------|-----------|
| P4.1 | `agi_suggest_async` Tauri command exists | Cmd+K → "What should I be paying attention to?" → command fires, LLM dispatch runs in tokio task, result lands on the WS event the daemon already runs. | TBD — new command `commands::agi_suggest_async` |
| P4.2 | LLM sentinel parser accepts well-formed `SUGGEST:` lines | Mock LLM response: `SUGGEST: tier=banner template=llm_priority body=… confidence=0.88` → enqueues a banner with the same shape as rule-based templates. | TBD — `agi::suggestion_parser::parse_sentinel` |
| P4.3 | LLM hallucination protection | Sentinel without `template=llm_<slug>` prefix OR confidence < 0.85 → silent drop, no fallback rendering. | TBD — parser unit tests |
| P4.4 | LLM cost rate limit | Max 1 LLM-suggest per 30 min globally; subsequent invocations reuse the cached suggestion until window elapses. | TBD — token bucket in `agi_suggest_async` |
| P4.5 | LLM call never blocks UI | Mock LLM with 5s delay → input field stays responsive throughout. | TBD — integration test |

## Phase 5 — Polish + CI grid (v1.9.0 GA, planned)

| # | Gate | Concrete user action → expected outcome | Mechanism |
|---|------|-----------------------------------------|-----------|
| P5.1 | Each template detector < 1ms p95 | `cargo bench --bench templates` — 7-template eval on a 1k-atom memory dir < 7ms p95. | TBD — `app/src-tauri/benches/templates.rs` |
| P5.2 | Cloud-sync telemetry opt-in default OFF | Fresh install: `agi.cloud_sync_telemetry` is false; only event/template/tier sync, never atom content. | TBD — Settings → AGI tab |
| P5.3 | Visual regression for 4 tiers | Storybook stories pass screenshot diff for chip / banner / toast / modal in light + dark themes. | TBD — `app/.storybook/` + Chromatic |
| P5.4 | Acceptance grid runs in CI on every PR | GitHub Actions runs `cargo test --all` + `npm test` + storybook visual diff; PR cannot merge with any phase-claimed gate failing. | TBD — `.github/workflows/v1_9_acceptance.yml` |

## Sign-off

| Phase | Status | Sign-off |
|-------|--------|----------|
| Phase 1 — beta.1 | All gates green | 2026-04-26 |
| Phase 2 — beta.2 | All gates green (this PR) | 2026-04-26 |
| Phase 3 — beta.3 | Stubs only — not yet implemented | — |
| Phase 4 — final  | Stubs only — not yet implemented | — |
| Phase 5 — GA     | Stubs only — not yet implemented | — |
