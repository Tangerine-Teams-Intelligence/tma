// === v1.14.6 round-7 ===
/**
 * v1.14 R7 — In-app version changelog.
 *
 * Why: R10 self-assessment scored Discoverability 8/10 with the gap
 * "no in-app changelog beyond WhatsNewBanner". WhatsNewBanner is the
 * "new ATOMS since you last looked" surface, not the "new APP VERSION
 * features" surface. This route is the latter — a flat-render of the
 * rolled-up CHANGELOG entries for v1.13 + v1.14 so users opening the
 * app for the first time after upgrade see what shipped.
 *
 * The content is inlined as a module-scoped constant (one string
 * concatenation per release block) rather than read from the on-disk
 * CHANGELOG.md so the bundled app doesn't need a static-asset fetch.
 * When v1.15+ ships, append the new block at top — no other changes.
 *
 * Pairs with `useStore.ui.lastSeenAppVersion` for the one-shot
 * upgrade-toast firing in `AppShell`.
 */

import ReactMarkdown from "react-markdown";
import { useEffect } from "react";
import { useStore } from "@/lib/store";

/** Bumped on every release. Drives the `lastSeenAppVersion` upgrade toast.
 *
 *  v1.15.2 fix #4: was hardcoded ("1.14.6") which fell out of sync with the
 *  shipped Tauri build and caused a stale "Tangerine v1.14 is here" toast
 *  to appear on v1.15 cold installs. Now sourced from `__APP_VERSION__`
 *  (injected by vite.config.ts at build time from package.json), so this
 *  constant tracks the bundle automatically. */
export const APP_VERSION: string = __APP_VERSION__;

/** Roll-up changelog rendered into the route. Keep entries terse and
 *  user-visible — this is the "what changed for me" view, not the
 *  engineering log. */
const CHANGELOG_MARKDOWN = `
# What's new in this version

## v1.16.0 — 2026-04-29

Wave 1 — smart layer砍.

- **Onboarding chat / SetupWizard / WelcomeOverlay砍.** The chat-mode
  onboarding required a live LLM the fresh install hadn't wired yet
  (chicken-and-egg deadlock); the form-wizard variant doubled the maze
  without paying its keep. The whole layer is gone — Tangerine now opens
  straight to /today on first launch. Wave 2/3 will reintroduce a single
  capture-only first-run surface.
- **Co-thinker / Canvas / Solo Cloud routes砍.** The smart-layer surfaces
  (canvas board, co-thinker brain edit, Solo Cloud upgrade prompt, demo
  tour overlay) followed the chat flow out the door. Old bookmarks
  redirect to /today.
- **AI tool per-tool setup pages砍.** Personal AI tool capture is now
  configured inline from Settings → Personal Agents.
- **Cmd+K palette pruned.** Palette open / select telemetry stays; the
  setup-llm-channel / test-llm-channel / init-co-thinker / per-tool
  ai-tools entries are gone.

## v1.15.2 — 2026-04-28

Wave 1.15 hotfix #4 — kill the stale upgrade toast.

- **Dynamic version in the upgrade toast.** Bottom-right "Tangerine
  v1.14 is here" toast was hardcoded to v1.14 and persisted into
  v1.15 cold installs. Now sourced from the build-time bundle so it
  always matches the running app.

## v1.14.6 — 2026-04-28

Round 7 closes the v1.14 arc.

- **Burst debounce on multi-teammate presence updates.** A 4+ teammate
  standup now coalesces to ≤ 2 list reads per fan-out window instead of
  one read per emit.
- **In-app version changelog.** This page. First launch after upgrade
  fires a toast pointing at it; future versions append to the top.
- **Honest presence write errors.** Hard FS errors (permission denied,
  read-only filesystem, disk full) now surface as a one-shot signal
  instead of being silently swallowed.

## v1.14.5 — 2026-04-27

Round 6 — AI capture moat polish.

- Tagged-enum status surface for personal agents (Cursor / Claude Code
  / Codex / Windsurf). Settings → Personal Agents now distinguishes
  "Not detected" / "Detection in progress" / "Detected, capture armed"
  / "Detected, capture off" instead of one boolean.

## v1.14.0 → v1.14.4 — 2026-04-25 → 2026-04-26

Rounds 1-5: closing v1.13 carryovers.

- 2-user team-invite cold-start E2E pin on Solo+Team funnel.
- JSON duplicate-key lint as part of CI.
- \`tauri-plugin-opener\` migration drops the only remaining cargo
  deprecation warning.
- Markdown-native backlinks LinkCache — opening a heavily-backlinked
  atom no longer drops a frame.
- Sample-detection on memory tree walk now mtime-cached.
- External-comm capture parity sweep (slack / email / calendar).

## v1.13.x — 2026-04-15 → 2026-04-22

Wave 1.13 — Local-first dual-layer capture, real-time team presence,
extracted-mention pipeline, sample-data tagging, identity layer.

- **Real-time team presence.** PresenceProvider mounted at AppShell-
  level, 10 s heartbeat + on-route emit, multi-window instant refresh.
- **Identity / team roster.** UserProfile, TeamMember, team_roster
  module land. WelcomeOverlay deep-links to the privacy panel.
- **Privacy panel.** First-class default tab — one click to confirm
  what stays local.
- **AIExtractedMentionCard** wired into /inbox renderer.
- **\`@mention\` preview** — typing @username in a comment shows
  "Will notify @X, @Y" before Post.
- **Privacy panel honest-on-failure.** No more fake green checks on
  Rust failure — replaced with an honest red error card.
- **Duplicate JSON-key fix.** Recovered ~110 i18n entries that were
  silently dropped pre-v1.13.10.

---

For the engineering changelog (PR-level detail) see \`CHANGELOG.md\`
at the repo root.
`.trim();

export default function WhatsNewAppRoute() {
  const setLastSeenAppVersion = useStore((s) => s.ui.setLastSeenAppVersion);

  // Visiting this route counts as "I've seen the upgrade notes" — clear
  // any pending upgrade toast by stamping the version forward.
  useEffect(() => {
    setLastSeenAppVersion(APP_VERSION);
  }, [setLastSeenAppVersion]);

  return (
    <div
      className="mx-auto h-full max-w-3xl overflow-auto p-8"
      data-testid="whats-new-app"
    >
      <article className="prose prose-stone dark:prose-invert max-w-none">
        <ReactMarkdown>{CHANGELOG_MARKDOWN}</ReactMarkdown>
      </article>
    </div>
  );
}
// === end v1.14.6 round-7 ===
