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

/** Bumped on every release. Drives the `lastSeenAppVersion` upgrade toast. */
export const APP_VERSION = "1.14.6";

/** Roll-up changelog rendered into the route. Keep entries terse and
 *  user-visible — this is the "what changed for me" view, not the
 *  engineering log. */
const CHANGELOG_MARKDOWN = `
# What's new in this version

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
