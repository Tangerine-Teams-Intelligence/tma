/**
 * v1.19.0 Round 1 — AppShell (Single-canvas + Cmd+K-everything).
 *
 * The 5-tab sidebar architecture was the wrong shape for an Obsidian-grade
 * tool. v1.19's redesign:
 *   1. AppShell renders the route Outlet + Spotlight + footer hint. That's it.
 *   2. Sidebar hidden by default (gated on `ui.sidebarVisible`). Round-1
 *      default = false. Cmd+B will eventually toggle. The Sidebar component
 *      stays on disk for power users.
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
import { markUserOpened } from "@/lib/views";
import { userFacingFoldersEmpty } from "@/lib/memory";
import {
  initMemoryWithSamples,
  resolveMemoryRoot,
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

  // === v1.19.0 onboarding obliteration ===
  // Permanently flip welcomed=true on first AppShell mount. The
  // MagicMoment 4-step modal and FirstRunTour are no longer mounted;
  // returning users see the time-density list immediately.
  useEffect(() => {
    if (!welcomed) setWelcomed(true);
  }, [welcomed, setWelcomed]);

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
            <FooterHint visible={shortcutHintShown < 5} />
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
 */
function FooterHint({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div
      data-testid="footer-hint"
      className="pointer-events-none fixed bottom-2 left-1/2 z-30 -translate-x-1/2 select-none whitespace-nowrap font-mono text-[10px] text-stone-400 dark:text-stone-600"
    >
      T time · H heat · P people · R replay · ⌘K all else
      <span className="ml-3 opacity-60">v{__APP_VERSION__}</span>
    </div>
  );
}
