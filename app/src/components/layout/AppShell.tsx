/**
 * v1.19.0 Round 1 — AppShell (Single-canvas + Cmd+K-everything).
 *
 * The 5-tab sidebar architecture was the wrong shape for an Obsidian-grade
 * tool. v1.19's redesign:
 *   1. AppShell renders the route Outlet + Spotlight + footer hint. That's it.
 *   2. Sidebar hidden by default (gated on `ui.sidebarVisible`). Round-1
 *      default = false. Cmd+B toggles (wired in v1.19.3). The Sidebar
 *      component stays on disk for power users.
 *   3. No banner stack. No StatusBar. No MagicMoment. No WhatsNewBanner.
 *      The components stay on disk; they're just unmounted in Round 1.
 *   4. Cmd+K → Spotlight (the new everything-overlay). T/H/P/R single keys
 *      cycle the canvas view (time / heatmap / people / replay) when no
 *      input is focused.
 *   5. Welcomed flag flipped to true permanently for everyone — onboarding
 *      obliteration. Existing v1.18 effects (sample seed, route logging,
 *      template_match listeners, focus tick) preserved because they're
 *      load-bearing for the data pipeline; Daizhe will tell us in Round 2
 *      if any of them feel like noise.
 *
 * Honesty preserved: empty state in feed.tsx says "No captures yet.
 * Tangerine is watching." (R6 — never a fake green "all clear"). Settings
 * → Connect surface is untouched.
 */

import { useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Spotlight } from "@/components/spotlight/Spotlight";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AmbientInputObserver } from "@/components/ambient/AmbientInputObserver";
import { BannerHost } from "@/components/suggestions/BannerHost";
import { ModalHost } from "@/components/suggestions/ModalHost";
import { UpdaterCheck } from "@/components/UpdaterCheck";
import { useStore } from "@/lib/store";
import { markUserOpened, readTimelineRecent } from "@/lib/views";
import { userFacingFoldersEmpty } from "@/lib/memory";
import {
  initMemoryWithSamples,
  resolveMemoryRoot,
  personalAgentsGetSettings,
} from "@/lib/tauri";
import { logEvent } from "@/lib/telemetry";
import { pushSuggestion } from "@/lib/suggestion-bus";

/** Custom DOM event name dispatched after a successful sample-seed so the
 *  sidebar tree can refresh in-place without a route nav. Kept for
 *  v1.19 because the data pipeline still emits + reads it. */
export const MEMORY_REFRESHED_EVENT = "tangerine:memory-refreshed";

/**
 * v1.15.2 fix #4 — pure helper that computes the upgrade-toast plan.
 * Kept exported because tests import it. Returns null in v1.19 since
 * the upgrade toast is itself dead in Round 1, but the math stays
 * here in case Round 2 wants to reuse it from the Spotlight :about
 * command.
 */
export function computeUpgradeToast(
  appVersion: string,
  lastSeenAppVersion: string | null,
): { msg: string; firstInstall: boolean } | null {
  if (lastSeenAppVersion === appVersion) return null;
  const majorMinor = appVersion.split(".").slice(0, 2).join(".");
  if (lastSeenAppVersion === null) {
    return {
      msg: `Tangerine v${majorMinor} is here — see what shipped`,
      firstInstall: true,
    };
  }
  return {
    msg: `Updated to v${appVersion} — see what's new`,
    firstInstall: false,
  };
}

/**
 * v1.9.0-beta.2 P2-A — payload shape of a `template_match` Tauri event.
 * Mirrors the Rust struct `agi::templates::common::TemplateMatch`.
 */
interface TemplateMatchPayload {
  match_id: string;
  template: string;
  body: string;
  confidence: number;
  atom_refs: string[];
  surface_id: string | null;
  priority: number;
  is_irreversible: boolean;
  is_completion_signal: boolean;
  is_cross_route: boolean;
}

export function AppShell() {
  const sidebarVisible = useStore((s) => s.ui.sidebarVisible);
  const setSpotlightOpen = useStore((s) => s.ui.setSpotlightOpen);
  const spotlightOpen = useStore((s) => s.ui.spotlightOpen);
  const canvasView = useStore((s) => s.ui.canvasView);
  const setCanvasView = useStore((s) => s.ui.setCanvasView);
  const shortcutHintShown = useStore((s) => s.ui.shortcutHintShown);
  const bumpShortcutHintShown = useStore((s) => s.ui.bumpShortcutHintShown);
  const welcomed = useStore((s) => s.ui.welcomed);
  const setWelcomed = useStore((s) => s.ui.setWelcomed);
  const currentUser = useStore((s) => s.ui.currentUser);
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  const setMemoryRoot = useStore((s) => s.ui.setMemoryRoot);
  const samplesSeeded = useStore((s) => s.ui.samplesSeeded);
  const setSamplesSeeded = useStore((s) => s.ui.setSamplesSeeded);
  const memoryConfigMode = useStore((s) => s.ui.memoryConfig.mode);
  // === v1.19.2 Round 3 Fix 2 — first-launch auto-replay ===
  // Gated on `welcomedReplayDone === false` plus a real corpus check
  // (readTimelineRecent returns events.length > 0). See effect below.
  const welcomedReplayDone = useStore((s) => s.ui.welcomedReplayDone);
  const setWelcomedReplayDone = useStore((s) => s.ui.setWelcomedReplayDone);
  // === v1.19.3 R6 fix — sync personalAgentsEnabled from Rust on mount ===
  // Without this hydration, the feed empty state branched on a default-
  // all-false `personalAgentsEnabled` even when the Rust side had
  // `claude_code = true` persisted. Daizhe installed v1.19.2 over v1.18
  // (which had Claude Code Connected) and saw "No sources connected"
  // — the UI was lying, not the Rust state. Now AppShell mirrors the
  // Rust persisted settings into the React store on first mount, so
  // every surface that reads `personalAgentsEnabled` (feed empty state,
  // Spotlight :sources, etc.) sees reality. Settings page still reads
  // `personal_agents_get_settings` independently — both call sites
  // converge on the same Rust source of truth.
  const setPersonalAgentsEnabled = useStore(
    (s) => s.ui.setPersonalAgentsEnabled,
  );

  // === v1.19.0 onboarding obliteration ===
  // Permanently flip welcomed=true on first AppShell mount. The
  // MagicMoment 4-step modal and FirstRunTour are no longer mounted;
  // returning users see the time-density list immediately.
  useEffect(() => {
    if (!welcomed) setWelcomed(true);
  }, [welcomed, setWelcomed]);

  // === v1.19.3 R6 fix — hydrate personalAgentsEnabled from Rust ===
  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const s = await personalAgentsGetSettings();
        if (cancel) return;
        setPersonalAgentsEnabled({
          cursor: !!s.cursor,
          claude_code: !!s.claude_code,
          codex: !!s.codex,
          windsurf: !!s.windsurf,
          devin: !!s.devin,
          replit: !!s.replit,
          apple_intelligence: !!s.apple_intelligence,
          ms_copilot: !!s.ms_copilot,
        });
      } catch {
        // Tauri call failed (browser dev / vitest / Rust panic). Leave
        // the React store at its default-all-false. The empty state
        // will say "No sources connected" — honest under the failure
        // mode (we genuinely don't know).
      }
    })();
    return () => {
      cancel = true;
    };
  }, [setPersonalAgentsEnabled]);

  // === v1.19.2 Round 3 Fix 2 — auto-replay real corpus gate ===
  // v1.19.1 R2 F gated on `samplesSeeded`, which is a "did we copy any
  // sample files to disk" proxy — it can lie if the corpus is empty for
  // some other reason (path resolution race, write permissions, etc.).
  // R3 replaces the proxy with the real check: call readTimelineRecent
  // ourselves, observe the actual event count, and only flip to replay
  // when there is genuinely something to play back.
  //
  // Trigger once when:
  //   1. welcomedReplayDone === false (one-shot latch, persists)
  //   2. readTimelineRecent resolves with events.length > 0
  //
  // The autoReplayFiredRef latch makes the effect safe against
  // re-renders that change the dep array.
  const autoReplayFiredRef = useRef(false);
  useEffect(() => {
    if (autoReplayFiredRef.current) return;
    if (welcomedReplayDone) return;
    autoReplayFiredRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const r = await readTimelineRecent(500);
        if (cancelled) return;
        if (r.events.length === 0) {
          // Empty corpus — don't fake a replay. Reset the latch so the
          // effect can re-fire on a future render once the corpus
          // actually has events.
          autoReplayFiredRef.current = false;
          return;
        }
        setCanvasView("replay");
        setWelcomedReplayDone(true);
      } catch {
        // If the corpus call fails (Tauri backend not up, jsdom mock
        // missing), don't fake a replay; let the user see the time view.
        autoReplayFiredRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [welcomedReplayDone, setCanvasView, setWelcomedReplayDone]);

  // === v1.19.0 footer hint counter bump ===
  // One bump per app boot. The hint becomes invisible at >= 5.
  const hintBumpedRef = useRef(false);
  useEffect(() => {
    if (hintBumpedRef.current) return;
    hintBumpedRef.current = true;
    bumpShortcutHintShown();
  }, [bumpShortcutHintShown]);

  // First-launch + self-healing sample seed. Preserved from v1.18 — it's
  // independent of the chrome rip-out. Without this a fresh user lands on
  // the time-density list with empty user-facing folders forever.
  useEffect(() => {
    if (memoryConfigMode === undefined) return;
    let cancel = false;
    void (async () => {
      const info = await resolveMemoryRoot();
      if (cancel) return;
      if (info.path && info.path !== memoryRoot && !info.path.startsWith("~")) {
        setMemoryRoot(info.path);
      }
      const root = info.path && !info.path.startsWith("~") ? info.path : memoryRoot;
      const empty = await userFacingFoldersEmpty(root);
      if (cancel) return;
      if (!empty) {
        if (!samplesSeeded) setSamplesSeeded(true);
        return;
      }
      if (samplesSeeded) setSamplesSeeded(false);
      const r = await initMemoryWithSamples();
      if (cancel) return;
      if (r.path && !r.path.startsWith("~")) {
        setMemoryRoot(r.path);
      }
      if (r.seeded || r.copied > 0) {
        setSamplesSeeded(true);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event(MEMORY_REFRESHED_EVENT));
        }
      }
    })();
    return () => {
      cancel = true;
    };
  }, [memoryConfigMode, memoryRoot, samplesSeeded, setMemoryRoot, setSamplesSeeded]);

  // === v1.19 Cmd+K + single-key view switchers ===
  // - Cmd/Ctrl+K toggles Spotlight.
  // - Cmd/Ctrl+, jumps to Settings (preserved muscle memory).
  // - Cmd/Ctrl+B toggles the sidebar (v1.19.3 — Round 1 specced this
  //   shortcut but never wired the keybind; the store action existed
  //   alone. Now flipping is reachable without opening Spotlight or
  //   Settings).
  // - T/H/P/R cycle canvasView when no input is focused AND Spotlight
  //   is closed.
  useEffect(() => {
    function isTypingTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (t.isContentEditable) return true;
      return false;
    }
    function onKey(e: KeyboardEvent) {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isCmdK) {
        e.preventDefault();
        setSpotlightOpen(!useStore.getState().ui.spotlightOpen);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        if (typeof window !== "undefined") {
          window.history.pushState({}, "", "/settings");
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        const cur = useStore.getState().ui.sidebarVisible;
        useStore.getState().ui.setSidebarVisible(!cur);
        return;
      }
      // Single-key view switchers — gated.
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (useStore.getState().ui.spotlightOpen) return;
      if (isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "t") {
        e.preventDefault();
        setCanvasView("time");
        return;
      }
      if (k === "h") {
        e.preventDefault();
        setCanvasView("heatmap");
        return;
      }
      if (k === "p") {
        e.preventDefault();
        setCanvasView("people");
        return;
      }
      if (k === "r") {
        e.preventDefault();
        setCanvasView("replay");
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSpotlightOpen, setCanvasView]);

  // Route logging (telemetry). Preserved from v1.9 — the suggestion engine
  // reads navigate_route events for pattern detection.
  const location = useLocation();
  const prevPathRef = useRef<string>("");
  useEffect(() => {
    const to = location.pathname;
    const from = prevPathRef.current;
    if (from === to) return;
    prevPathRef.current = to;
    void logEvent("navigate_route", { from, to });
  }, [location.pathname]);

  // Template-match listener (suggestion bus pipeline). Preserved.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        unlistenFn = await listen<TemplateMatchPayload>(
          "template_match",
          (e) => {
            const p = e.payload;
            if (p.template === "newcomer_onboarding") {
              const ui = useStore.getState().ui;
              if (ui.newcomerOnboardingShown) return;
              ui.setNewcomerOnboardingShown(true);
            }
            void pushSuggestion({
              template: p.template,
              body: p.body,
              confidence: p.confidence,
              is_irreversible: p.is_irreversible,
              is_completion_signal: p.is_completion_signal,
              is_cross_route: p.is_cross_route,
              surface_id: p.surface_id ?? undefined,
              atom_refs: p.atom_refs,
              priority: p.priority,
              match_id: p.match_id,
            });
          },
        );
      } catch {
        // Browser dev / vitest where `@tauri-apps/api/event` isn't available.
      }
    })();
    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
    };
  }, []);

  // Mark "user opened" on focus. Preserved.
  useEffect(() => {
    let cancel = false;
    const tick = () => {
      if (cancel) return;
      void markUserOpened(currentUser);
    };
    tick();
    const onFocus = () => tick();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
    }
    return () => {
      cancel = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
      }
    };
  }, [currentUser]);

  return (
    <AmbientInputObserver>
      <div
        data-testid="app-shell-root"
        data-canvas-view={canvasView}
        data-spotlight-open={spotlightOpen ? "true" : "false"}
        className="flex h-full w-full bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100"
      >
        {sidebarVisible && <Sidebar />}
        <div className="flex min-w-0 flex-1 flex-col">
          <BannerHost />
          <main className="relative flex-1 overflow-auto bg-stone-50 dark:bg-stone-950">
            <Outlet />
            <FooterHint
              visible={shortcutHintShown < 5}
              activeView={canvasView}
            />
          </main>
        </div>
        <Spotlight />
        <ModalHost />
        <ErrorBoundary label="UpdaterCheck">
          <UpdaterCheck />
        </ErrorBoundary>
      </div>
    </AmbientInputObserver>
  );
}

/**
 * Single-line shortcut hint pinned to the bottom of the viewport. Hides
 * itself once the user has booted ≥ 5 times (assume they have memorized
 * the shortcut row by then). Round-1 ships always-visible since fresh
 * installs start at 0; the hint disappears on the 6th boot.
 *
 * v1.19.1 Round 2 B — the active view's label is bolded + accent-colored
 * so the user sees which mode T/H/P/R is currently in. Inactive labels
 * stay at the existing stone tone.
 */
type CanvasView = "time" | "heatmap" | "people" | "replay";

interface FooterHintLabel {
  key: CanvasView;
  text: string;
}

const FOOTER_HINT_LABELS: FooterHintLabel[] = [
  { key: "time", text: "T time" },
  { key: "heatmap", text: "H heat" },
  { key: "people", text: "P people" },
  { key: "replay", text: "R replay" },
];

function FooterHint({
  visible,
  activeView,
}: {
  visible: boolean;
  activeView: CanvasView;
}) {
  if (!visible) return null;
  // v1.19.2 Round 3 Fix 4 — responsive collapse.
  // Below 1280px (Tailwind `xl:` breakpoint) the long row wrapped on
  // narrow laptops; we now show only `⌘K · v…` there. The full row
  // (T/H/P/R + ⌘K + version) shows from 1280px up. Both rows render so
  // the version chip is always visible regardless of viewport.
  return (
    <div
      data-testid="footer-hint"
      className="pointer-events-none fixed bottom-2 left-1/2 z-30 -translate-x-1/2 select-none whitespace-nowrap font-mono text-[10px] text-stone-400 dark:text-stone-600"
    >
      {/* Wide row — visible at xl: and above (1280px+) */}
      <span
        data-testid="footer-hint-wide"
        className="hidden xl:inline"
      >
        {FOOTER_HINT_LABELS.map((l, i) => {
          const active = l.key === activeView;
          return (
            <span key={l.key}>
              <span
                data-testid={`footer-hint-label-${l.key}`}
                data-active={active ? "true" : "false"}
                className={
                  active
                    ? "font-semibold text-[var(--ti-orange-500)]"
                    : undefined
                }
              >
                {l.text}
              </span>
              {i < FOOTER_HINT_LABELS.length - 1 ? " · " : ""}
            </span>
          );
        })}
        {" · "}
        <span data-testid="footer-hint-label-spotlight">⌘K all else</span>
      </span>
      {/* Narrow row — visible below xl: (under 1280px) */}
      <span
        data-testid="footer-hint-narrow"
        className="inline xl:hidden"
      >
        <span data-testid="footer-hint-label-spotlight-narrow">⌘K</span>
      </span>
      <span className="ml-3 opacity-60">v{__APP_VERSION__}</span>
    </div>
  );
}
