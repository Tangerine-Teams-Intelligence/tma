# OBSERVABILITY_SPEC

Cross-cutting observability spec for Tangerine Meeting. Covers error handling, crash reporting, logging, version migration, performance budgets, internationalization, accessibility, edge case catalog, and SOC 2 controls. Status: `draft`.

This spec is the source of truth for any non-feature concern that must be enforced *across* the v1.x → v3.5 roadmap. When a feature spec (V1_9_ACCEPTANCE, V2_0_SPEC, V2_5_SPEC, etc.) is silent on an observability concern, the rule below applies.

---

## §0 Why now

Real users hit errors during install. Today the handling is scattered: some commands swallow `io::Error` into a string, some panic with `unwrap`, frontend toasts surface only when a developer remembered to wire one in. The user experience after a failed source connect, a corrupted brain, or a network glitch is "the button stopped working." That is unacceptable for a product we're shipping to design partners.

Enterprise buyers (Aerospike Tier-1, post-v2.5 paid tier) require an audit trail and a baseline of SOC 2 controls. Per `BUSINESS_MODEL_SPEC.md` line 222: SOC 2 Type II by month 6 is `ratified`. China data region is day-1 (DeepSeek inference is Chinese — natural PIPL / 等保). ISO 27001 is deferred to v2.0+. We need engineering controls in place before the audit firm walks in, not retrofitted.

This spec exists so a feature PR doesn't have to reinvent error handling, log formatting, or migration shape every time. It tells the engineer: here is the lane, stay in it.

---

## §1 Error handling principles

Two kinds of error consumers — the user and the developer — want different things. The frontend resolves user-visible messages; the backend produces structured errors with full context for the log.

### Frontend (React)

Every IPC call goes through `try/catch`. On error:
- **User-visible**: push a toast via the existing toast bus (see `app/src/lib/toast.ts`). Message is i18n keyed (per §6) and human-readable. Never raw stack traces, never raw error strings from Rust.
- **Developer-visible**: `console.error("source.connect failed", err)` so the dev console shows what blew up.
- Component never renders a blank panel because its loader rejected. Render an empty state with a retry button, and toast the underlying reason.

### Backend (Rust)

Every command returns `Result<T, AppError>`. **No `panic!`, no `unwrap()`, no `expect()` reaches a frontend caller.** Tests are exempt. Daemon background work is exempt only via `record_error` — see `app/src-tauri/src/daemon.rs:125` (`record_error` writes to the bounded ring; the loop never dies).

The unified error shape is `AppError` (already imported across telemetry — see `app/src-tauri/src/agi/telemetry.rs:30`). Variants:

| Variant | When | Surface to user as |
|---|---|---|
| `internal_io` | Disk / fs operation failed | "Couldn't save. Disk may be full or permissions blocked." |
| `not_found` | Atom / source / config absent | "Couldn't find that. Try reloading." |
| `unauthorized` | OAuth expired / token invalid | "Reconnect needed." Banner in source page. |
| `network` | HTTP / git / IMAP timeout | "Network glitch. Retrying." Auto-retry once. |
| `parse` | JSON / frontmatter / config malformed | "File is corrupt. See log for details." |
| `config` | Required env var or path missing | "Setup incomplete." Link to settings. |

Every `AppError` carries a `where` string (the call site, e.g. `"mkdir_telemetry"`) and a `details` string (the underlying error). The `where` is logged but never shown to users; the user sees a localized template keyed off the variant.

### Don't catch and rethrow

If a function has nothing to add, propagate via `?`. Wrap only at boundary points where you can attach meaningful `where` context — e.g. `commands::source::connect` wraps a network error so the log says `source_connect:notion:network` rather than just `network`.

---

## §2 Crash reporting

### Panic hook

Tauri sets a default panic hook; we replace it in `main.rs::setup` to:
1. Log the panic to tracing at `error` level with full backtrace.
2. Write a crash dump to `~/.tangerine-memory/.tangerine/crashes/{ISO8601}.log`. The file contains: panic message, backtrace, Tangerine version, OS, last 50 telemetry events.
3. (v2.5+) If the user opted in, queue the crash for upload on next launch.

Verification: a smoke test in `app/src-tauri/tests/` triggers `std::panic::panic_any` from a non-async context and asserts the file landed.

### Local crash log

Path: `~/.tangerine-memory/.tangerine/crashes/{YYYY-MM-DDTHH-MM-SSZ}.log`. Mirrors the layout convention from telemetry (see `app/src-tauri/src/agi/telemetry.rs:54`). Retention: 90 days, pruned by the same scheduled task as telemetry.

### Cloud crash report (post-v2.5, opt-in)

Sentry vs Highlight.io vs self-host is open (§11 Q1). Until a destination is chosen, crashes stay local. Settings → Privacy → "Send crash reports?" is the user toggle. Default off. Toggle persists in `~/.tangerine-memory/.tangerine/settings.json`. China region installs do not get a remote endpoint — crash data stays in-country.

---

## §3 Logging strategy

Crate: `tracing` (already a dep) with `tracing_subscriber::EnvFilter`. Levels:

- `error` — user-visible problem AND log entry. Anything that surfaces a toast goes here.
- `warn` — log only. Recoverable degraded state (e.g. cross-device rename fallback in `migration.rs:138`).
- `info` — log only. Lifecycle events (boot, shutdown, daemon heartbeat success).
- `debug` — dev mode only. Per-call detail.
- `trace` — never enabled in shipped builds.

### Log file

Path: `~/.tangerine-memory/.tangerine/logs/{YYYY-MM-DD}.log`. Daily rotation via filename. 90-day retention, pruned at boot identically to telemetry's `prune_old` (see `app/src-tauri/src/agi/telemetry.rs:142`).

### Structured fields

Every span/event SHOULD carry as many of these as apply:

| Field | Type | Meaning |
|---|---|---|
| `request_id` | uuid | One IPC call from frontend to backend |
| `user` | string | Resolved current user (matches telemetry `user`) |
| `atom_path` | path | When the operation touches a memory atom |
| `source` | string | Source kind (`slack`, `notion`, `email`, etc.) |
| `latency_ms` | u64 | Time from span open to close |
| `where` | string | Mirror of `AppError::where` for failed ops |

Implementation: `tracing` macros take key=value pairs. Boot wires a JSON formatter so log lines parse cleanly when shipped.

### Privacy

Log files stay local. They are NOT synced to the team git mirror (the canonical `.gitignore` written by `migration.rs:239` already excludes `.tangerine/`, which contains both telemetry and logs). Atom contents do not enter the log; only paths do.

---

## §4 Migration spec

The v1.x → v2.0 layered-memory migration in `app/src-tauri/src/migration.rs` is the **reference pattern**. Future migrations follow the same shape: idempotent, atomic, runs at boot before any background work touches the affected dirs, degrades gracefully on partial failure.

### Version ladder

| Step | Trigger | Shape | Status |
|---|---|---|---|
| v1.x → v2.0-alpha.1 | Flat `<root>/{kind}/` → `<root>/team/{kind}/` | Move per-kind dirs into `team/`, seed `personal/<user>/`, write `.gitignore` | **Shipped** in `migration.rs` |
| v2.0 → v2.5 | Cloud sync opt-in enable | Add `team/.git/` (or migrate existing) and seed `cloud_sync.json` config | Spec only |
| v2.5 → v3.0 | Personal agent capture | Extend personal layout to `personal/{user}/threads/{agent-type}/` | Spec only |
| v3.0 → v3.5 | Marketplace template install path | Add `<root>/templates/installed/` registry | Spec only |

### General principles (apply to every migration)

1. **Boot-time, one-shot, idempotent.** A re-run on an already-migrated install is a no-op. The `migration.rs:86` `already_layered` short-circuit is the canonical pattern.
2. **Backward-compat reads** (union legacy paths) until the next major version. v2.0 still reads from a v1.x flat layout if (somehow) the migration was skipped, until v3.0 deletes the legacy path.
3. **Schema version frontmatter field.** Every atom carries `schema_version: N` (per DATA_MODEL_SPEC). Migrations bump this only when the data shape changes, not when the directory shape changes.
4. **Dry-run first**, user confirms before destructive moves. The v1.x→v2.0 migration is non-destructive (rename = atomic flip), so it auto-runs. Future migrations that *transform* atom contents prompt the user.
5. **Failure does not crash.** Per-kind move failure logs and continues. Worst case: half-migrated install where the next boot retries (see `migration.rs:130-154`).
6. **No half-state.** Either the kind dir moved entirely, or it didn't. `std::fs::rename` is atomic per inode; the cross-device fallback uses copy-then-remove (`migration.rs:142-150`) and only marks the kind as migrated after the copy succeeded.
7. **Sidecars never moved.** `.tangerine/`, `agi/`, `timeline/`, `canvas/` are owned by other systems. The migration touches user atoms only.

### Test contract

Every migration ships with at least: (a) fresh-install test, (b) v1.x-layout test, (c) idempotent second-run test, (d) cross-user skeleton seed test. See `migration.rs:286-377` for the template.

---

## §5 Performance budget

Each phase has a budget. CI fails when a benchmark regresses by more than 20% or breaches the budget.

### v1.9

| Operation | Budget | Notes |
|---|---|---|
| Cold start (window paint to interactive) | < 2s | First paint to first IPC response. Lazy-load source modules. |
| Sidebar render | < 100ms | After memory tree fetched. |
| Memory tree, 1000 atoms | < 500ms | Initial load + first render. |
| Co-thinker heartbeat | < 30s p95 | Per `daemon.rs:471` cadence-gated path. Excludes LLM call. |
| Telemetry write | < 5ms p95 | Per `agi/telemetry.rs:65`. Append-only, no fsync. |
| Suggestion bus push → render | < 100ms | From `pushSuggestion` to chip visible. |

### v2.0

| Operation | Budget | Notes |
|---|---|---|
| Workflow graph 5000 nodes render | < 1s | Initial layout + first paint. |
| Pan / zoom | 60fps maintained | RAF-driven, no layout thrash. |
| Co-thinker home strip mount | < 50ms | Memoize the proposal list. |

### v2.5

| Operation | Budget | Notes |
|---|---|---|
| Stripe webhook handle | < 200ms | Excludes external calls; just our path. |
| Auth flow round trip | < 3s | Login → token → first authed IPC. |

### v3.0

| Operation | Budget | Notes |
|---|---|---|
| Personal agent capture file watcher reaction | < 100ms | From fs event to atom write started. |
| External world fetch | Async, non-blocking | Never blocks UI thread. |

### v3.5

| Operation | Budget | Notes |
|---|---|---|
| Marketplace browse | < 2s | Initial template list paint. |
| Template install | < 30s | End to end, including dependency fetch. |

### Measurement

Bench harness lives in `app/src-tauri/benches/` (criterion). Frontend uses `performance.measure` keyed by op name. CI aggregates per-PR and posts a delta comment.

---

## §6 Internationalization (i18n)

### Scope

- 中文 + English are day-1 priority. Daizhe is a Chinese founder; design partners include Chinese factories.
- Other languages: post-v3.5 if community demand justifies.

### Implementation

- Library: `i18next` + `react-i18next` with ICU MessageFormat. Picked over `react-intl` because i18next has better runtime locale switching and a smaller bundle.
- Translation files: `app/src/locales/{lang}/{namespace}.json`. Namespaces: `common`, `errors`, `sources`, `agi`, `settings`.
- Component usage: `const { t } = useTranslation('namespace'); t('key', { vars })`. No string literals in JSX outside a `t()` wrapper. ESLint rule enforces.
- Default detection: if `navigator.language` matches `zh-*`, default to `zh`. Otherwise `en`. User can override in Settings → Language.

### Backend strings

Backend errors (`AppError::details`, log messages, the `where` string) are developer-facing — English only. The frontend maps `AppError.variant` to a user-visible localized template, never echoes `details` raw.

### Atom content

User-typed atom content is **never** translated. Memory is the user's voice. Any UI that displays atom content shows it verbatim regardless of locale.

### Date / number formatting

Use `Intl.DateTimeFormat` and `Intl.NumberFormat` keyed off the active i18next locale. No hand-rolled "April 26, 2026" strings.

---

## §7 Accessibility

WCAG 2.1 AA is mandatory. v1.9 P3-C already shipped partial coverage (aria-label, role, focus ring on suggestion chips). The rest of the inventory must reach AA before v2.5 paid tier.

### Inventory

- **Buttons + interactive controls**: every one has `aria-label` (or visible text), visible focus ring, keyboard activatable (Enter / Space).
- **Modals**: `role="dialog"`, `aria-modal="true"`, focus trap on open, focus restored to trigger on close.
- **Banners** (errors, reconnect prompts): `role="alert"` so screen readers announce immediately.
- **Tab order**: logical reading order. No `tabIndex` greater than 0.
- **Animations**: respect `prefers-reduced-motion`. Co-thinker chip slide-in collapses to fade-only.
- **Color contrast**: 4.5:1 minimum for body text, 3:1 for large text. The orange `#CC5500` brand on white is 4.7:1 — passes. On dark navy `#1A1A2E` it is 3.2:1 — fails AA for body, only acceptable for large text or non-text indicators.
- **Forms**: every input has a `<label>` association. Errors announced via `aria-describedby`.

### Test matrix

Every release tests against:
- NVDA on Windows (primary — most enterprise screen readers)
- JAWS on Windows (Tier 1 enterprise)
- VoiceOver on macOS

Automated via `axe-core` in CI. Manual screen reader pass once per minor version.

---

## §8 Edge cases catalog

The list below is the canonical set of "things that go wrong in the wild." Every item has a defined response. New edge cases caught during user testing are added to this section, not buried in feature specs.

| Edge case | Response |
|---|---|
| Network offline | Graceful degrade. Queue writes locally, retry with exponential backoff. Visible "offline" indicator in status bar. |
| Source auth expires | Silent reconnect attempt first. On failure, banner at top of source page: "Reconnect needed." Telemetry event `source_auth_expired`. |
| Co-thinker brain corrupt (parse error on `brain.md`) | Backup the corrupt file to `.tangerine/quarantine/{ts}.md`. Regenerate from observation log. User sees toast: "Co-thinker brain refreshed." |
| Canvas conflict (two users edit same sticky concurrently) | Last-write-wins. Loser's content preserved as a sibling sticky with `[conflict]` prefix. User resolves manually. |
| Git conflict on team memory pull | Daemon abandons that pull cycle, surfaces banner with "Manual merge needed" + button to open Git surface. Heartbeat continues; index does not advance until resolved. |
| DeepSeek network outage | Fallback chain: DeepSeek → Ollama (if local model installed) → static stub response with "AI unavailable" notice. Never block the UI. |
| Disk full | Halt new writes. Banner: "Disk full. Free space to continue." Reads still work. Daemon enters paused state. |
| Clock skew (system clock far in past or future) | Telemetry timestamps still ISO RFC 3339 — they reflect system time. Migration's `chrono::Utc::now` is the same. We do not correct, but the daemon refuses to write a brief dated more than 24h in the future. |
| Memory root on read-only volume | Detected at boot; user sees a hard-fail dialog with "Choose another folder." App doesn't proceed. |
| Two app instances running concurrently | File lock on `~/.tangerine-memory/.tangerine/.lock`. Second instance shows "Already running" dialog and exits. |

---

## §9 SOC 2 controls

Per `BUSINESS_MODEL_SPEC.md` §10 (line 222): Type II audit by month 6. Engineering owns the technical controls. The audit firm + paperwork is owned by the CEO (per same doc, line 251).

### Engineering deliverables

| Control area | What we build | Status |
|---|---|---|
| Access control | Role-based: team admin / member / readonly. Stored in `team/.tangerine/roles.json`. UI gates writes against role. | v2.5 |
| Audit log | Every privileged action (role change, source connect, billing change) emitted to a separate immutable stream at `~/.tangerine-memory/.tangerine/audit/{YYYY-MM-DD}.jsonl`. Append-only, retention controlled by §11 Q4. | v2.5 |
| Encryption at rest | Tangerine memory files unencrypted on disk by default (user owns the disk). Cloud sync mirror encrypted via the user's git provider's at-rest encryption (GitHub / GitLab / self-host). | v2.5 |
| Encryption in transit | All cloud calls over TLS 1.2+. Cert pinning for Stripe and auth provider. | v2.5 |
| Backup | Cloud sync = automatic git mirror. Default ON for paid tier (post §11 Q3). | v2.5 |
| Monitoring | Uptime + error rate dashboard for cloud-side services (auth, billing webhook). Internal-only Grafana initially. | v2.5 |
| Incident response | Documented runbook in `docs/runbook.md`. On-call rotation post-funding. | v2.5 |
| Vulnerability scan | `cargo audit` and `npm audit` in CI; block PR on high severity. | v1.9 |

### Telemetry vs audit log distinction

Telemetry (`agi/telemetry.rs`) is best-effort observational, swallows write errors, retention 90 days. Audit log MUST NOT swallow errors — a failed audit append surfaces a hard error. Retention is 1 year minimum (open question §11 Q4). The two streams never share a file.

### China region

Day-1 separate cloud config. The build flag `TANGERINE_REGION=cn` selects DeepSeek + ICP-licensed cloud sync host + China-resident telemetry endpoint. No data flows out of the region. Audit log too.

---

## §10 Out of scope

- **Real-time observability dashboard** for end users (post v3.5). Today's path is "log file + telemetry jsonl"; that's enough for support tickets.
- **APM tools** (Datadog, New Relic, Honeycomb). Overkill for an OSS desktop app. The cloud side post-v2.5 may adopt one if cost / complexity justifies; default is self-host Grafana.
- **Distributed tracing** across machines. Single-process tracing is enough for the desktop app; the cloud side gets request_id propagation but no cross-service trace context until volume warrants.
- **In-app crash recovery UI** beyond the banner. Power users can dig in `.tangerine/crashes/`.

---

## §11 Open questions for CEO

1. **Crash report destination** post-v2.5: Sentry (mature, expensive at scale) vs Highlight.io (newer, integrated session replay) vs self-host (most work, full control)? Recommendation: Highlight.io — session replay is genuinely useful for repro and the per-seat pricing fits where we'll be at month 6.
2. **i18n default locale**: Auto-detect (`zh-*` → 中文, else English) vs always English first with manual switch? Recommendation: auto-detect — Daizhe wants Chinese installs to feel native day-1.
3. **Cloud git mirror default**: ON for all paid teams vs opt-in? Recommendation: ON. Backup is a SOC 2 control; making it opt-in invites trouble.
4. **Audit log retention**: 90 days (matches telemetry) vs 1 year (matches typical SOC 2 expectation) vs 7 years (matches finance / SOX)? Recommendation: 1 year for v2.5; 7 years post-Series A when we have enterprise customers asking.
5. **SOC 2 audit firm**: Vanta self-serve (~$20k all-in) vs traditional firm (Schellman, A-LIGN, ~$40k+)? Recommendation: Vanta for first audit. Switch to traditional firm if a Tier-1 enterprise customer demands a known auditor name on the report.

---

## Status

`draft` — pending review by CEO + CTO. After ratification, every feature spec must reference this doc rather than redefine cross-cutting concerns.
