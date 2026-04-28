# app/tests — Vitest unit + integration suite

The bulk of the React component coverage lives here. Vitest is configured in
`vite.config.ts::test` (jsdom, `setupFiles: ["./tests/setup.ts"]`).

## Run

```bash
cd app
npm test -- --run    # one-shot CI mode
npm test             # watch mode
```

Cross-platform: Vitest on jsdom runs identically on Windows / macOS / Linux.
The Tauri-bridge (`@tauri-apps/api`, plugin shims) is lazy-imported and try/
catch'd in the components themselves so test runs never hit a real Tauri host.

## Cross-platform validation strategy (wave 25)

Same staged plan as `e2e/README.md` — see that file for the canonical
description. tl;dr: locally we run on Windows; the GitHub Actions matrix
covers macOS + Linux compile + smoke; outside testers run the
`dogfood-prep/CHECKLIST.md` flow on their native OS for end-to-end
validation.

The wave-25 auto-updater specifically is platform-agnostic on the React
side (`UpdaterCheck.tsx` only touches `@tauri-apps/plugin-updater`, which
the plugin itself handles per-OS via `tauri-plugin-updater`). The
component swallows missing-bridge errors so vitest jsdom runs never
require a Tauri host.

## File naming convention

* `<feature>.test.tsx` — React component test
* `<feature>.test.ts` — pure-TS lib test (no DOM)
* `wave<N>-<feature>.test.tsx` — wave-scoped regression tests added during
  a specific wave (e.g. `wave10-1-black-screen-regression.test.tsx`)

The wave-prefixed tests are intentionally never deleted even after the
wave ships — they serve as the canonical regression catalog. New waves
should follow the same pattern.

## Adding a new test

1. Create `tests/<your-feature>.test.tsx`.
2. Mirror the imports from `tests/connection-banner.test.tsx` (the
   minimal-surface example).
3. Mock Tauri commands via `vi.spyOn(...)` against the lib module that
   exports them (e.g. `vi.spyOn(views, "readWhatsNew").mockResolvedValueOnce`).
4. Run `npm test -- --run -t '<your test name>'` to iterate.
