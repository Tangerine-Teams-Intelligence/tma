import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "@/components/CommandPalette";
// === wave 19 ===
// AppShell no longer mounts ActivityFeed at the right rail. Wave 20 will
// re-add the activity widget INSIDE /today's dashboard, so the activity
// signal still reaches the user — just not as a global right rail that
// steals horizontal space on every route. /memory, /brain, /canvas, etc.
// now get the full content width they need for file-tree, brain-viz, and
// sticky-board surfaces.
//
// The ActivityFeed component itself is intentionally not deleted — Wave
// 20 will import it directly and embed inside the today dashboard. The
// wave-16 ActivityFeed test still drives the component standalone.
// === end wave 19 ===
import { WhatsNewBanner } from "@/components/WhatsNewBanner";
import { LicenseTransitionBanner } from "@/components/LicenseTransitionBanner";
// === wave 5-β ===
// Discoverability primitives: floating help button + global shortcuts
// overlay. Mounted at AppShell level so they exist on every route. The
// `?` key listener that toggles the overlay also lives here — see the
// effect block in the body below.
import { HelpButton } from "@/components/HelpButton";
import { KeyboardShortcutsOverlay } from "@/components/KeyboardShortcutsOverlay";
// === end wave 5-β ===
// === wave 22 ===
// Wave 22 — coachmark / first-run guided tour / "try this" floating
// button. Mounted at AppShell so they wrap every route. The provider is
// the topmost wrapper so any route component can consume `useCoachmark`
// for ad-hoc tooltips. The FirstRunTour + TryThisFAB self-mount inside
// the provider; both are no-ops when their persisted gate flags say so.
import { CoachmarkProvider } from "@/components/coachmark/CoachmarkProvider";
import { FirstRunTour } from "@/components/coachmark/FirstRunTour";
import { TryThisFAB } from "@/components/coachmark/TryThisFAB";
// === end wave 22 ===
// === wave 1.13-D ===
// v1.13 — team presence layer. Provider wraps the AppShell so every
// route shares one heartbeat + reader pair (no duplicate intervals
// across route mounts). The TeammatesPill renders in the system-banner
// strip when ≥ 1 teammate is active.
import { PresenceProvider } from "@/components/presence/PresenceProvider";
import { TeammatesPill } from "@/components/presence/TeammatesPill";
// === end wave 1.13-D ===
// === wave 25 === — auto-update banner. Sits in top-right notification slot,
// fires once on mount after WelcomeOverlay closes. Self-suppresses if the
// updater bridge isn't available (browser dev / vitest), if the running
// build is already latest, or if the user dismissed.
import { UpdaterCheck } from "@/components/UpdaterCheck";
// === end wave 25 ===
// Wave 4-C — first-run welcome tour. Mounted inside AppShell so it
// covers every route the user might land on (default is /today). The
// overlay self-hides once `ui.welcomed` flips, so re-renders after the
// first cold launch are zero-cost.
import { WelcomeOverlay } from "@/components/WelcomeOverlay";
// === wave 11 === — first-run LLM channel setup wizard + banner.
// Boot flow: WelcomeOverlay (~30s) → SetupWizard (~60s) → /today.
// The wizard auto-opens once after the welcome overlay closes for fresh
// installs that haven't already verified an LLM channel; the banner
// stays visible across cold launches until the user finishes the wizard
// or flips `setupWizardSkipped` to true via the in-wizard Skip link.
import { SetupWizard } from "@/components/SetupWizard";
import { SetupWizardBanner } from "@/components/SetupWizardBanner";
// === end wave 11 ===
// Wave 3 — offline indicator (OBSERVABILITY_SPEC §8 edge case catalog)
import { ConnectionBanner } from "@/components/ConnectionBanner";
// === wave 13 ===
// Wave 13 — populated-app demo mode banner. Renders only when
// `ui.demoMode === true`; shown across every route between the
// connection-state strip and the WhatsNewBanner so the user knows the
// data they're browsing is sample content. Self-hides on dismiss; the
// AppShell first-launch effect flips `demoMode = true` after a fresh
// `demo_seed_install` so the banner appears the moment populated data
// lands on disk.
import { DemoModeBanner } from "@/components/DemoModeBanner";
// === end wave 13 ===
// === wave 10 === — v1.10 git-init wizard banner. Mounts in the system
// banner stack, only renders while `gitMode === "unknown"`.
import { GitInitBannerContainer } from "@/components/GitInitBannerContainer";
// === end wave 10 ===
// === wave 10.1 hotfix === — defensive boundary around the wave-10 mounts.
// v1.10.0 went out with a black-screen regression because a render-time
// throw inside one of the new git-sync mounts crashed the whole React
// tree (no boundary anywhere in the app). This boundary catches + logs
// + renders null so a busted indicator/banner never blanks the shell.
import { ErrorBoundary } from "@/components/ErrorBoundary";
// === end wave 10.1 hotfix ===
import { AmbientInputObserver } from "@/components/ambient/AmbientInputObserver";
// v1.9.0-beta.1 — banner + modal hosts. The bus pushes into bannerStack /
// modalQueue and these hosts read the top entry. The hosts MUST live
// inside the AppShell (not inside the Outlet) so they survive route
// changes — banners are explicitly cross-route.
import { BannerHost } from "@/components/suggestions/BannerHost";
import { ModalHost } from "@/components/suggestions/ModalHost";
// === v2.0-beta.3 co-thinker home strip ===
// Persistent 1-line strip mounted above the route content on every
// route. Makes the AGI's presence visible all the time so the user
// doesn't have to navigate to /co-thinker to know whether the brain is
// alive. Hides itself when agiParticipation is off (master kill switch).
import { HomeStrip } from "@/components/co-thinker/HomeStrip";
// === end v2.0-beta.3 co-thinker home strip ===
import { useStore } from "@/lib/store";
import { markUserOpened } from "@/lib/views";
import { userFacingFoldersEmpty } from "@/lib/memory";
import {
  initMemoryWithSamples,
  resolveMemoryRoot,
  // === v2.5 trial gate ===
  billingStatus as fetchBillingStatus,
  // === end v2.5 trial gate ===
  // === wave 13 ===
  demoSeedInstall,
  // === end wave 13 ===
} from "@/lib/tauri";
// v1.9.0-beta.1 P1-A — log every route transition so the suggestion engine
// (P1-B + v1.9.0-beta.2) can detect navigation patterns ("you bounced
// /memory ↔ /canvas 5×", "you haven't seen /today in 3 days"). Fire-and-
// forget; never blocks UI.
import { logEvent } from "@/lib/telemetry";
// v1.9.0-beta.2 P2-A — bus + tier types for the rule-based template match
// listener. Each Tauri `template_match` event payload deserialises into
// `TemplateMatchPayload` (mirrors the Rust `TemplateMatch` struct in
// `app/src-tauri/src/agi/templates/common.rs`) and is forwarded to
// `pushSuggestion(...)` so the bus can apply the disciplines + tier
// selection across all 7 P2 templates uniformly.
import { pushSuggestion } from "@/lib/suggestion-bus";
// === wave 1.13-A ===
// Wave 1.13-A — collab inbox event listener. Subscribes to the
// `inbox:event_created` Tauri event emitted by `commands::inbox_store::
// inbox_emit` and pushes a toast + system notification when the event
// targets the current user. Identity hook resolves the alias once on mount.
import {
  identityGetCurrentUser,
  type InboxEvent as CollabInboxEvent,
} from "@/lib/identity";
import { systemNotify } from "@/lib/tauri";
// === end wave 1.13-A ===

/** Custom DOM event name dispatched after a successful sample-seed so the
 *  sidebar tree + /today timeline can refresh in-place without a route nav. */
export const MEMORY_REFRESHED_EVENT = "tangerine:memory-refreshed";

/**
 * v1.9.0-beta.2 P2-A — payload shape of a `template_match` Tauri event.
 *
 * Mirrors the Rust struct `agi::templates::common::TemplateMatch`. We
 * intentionally redeclare the shape here rather than importing it from
 * the suggestion-bus or backend types — the listener belongs to the
 * AppShell layer and a flat local type keeps the bus + AppShell
 * decoupled (the bus exports `SuggestionRequest`, which is a strict
 * superset of this payload).
 *
 * v1.9.0 P4-A added `match_id` (UUID v4 stamped on the Rust side at
 * `evaluate_all` time). Required for Stage 2 enrichment so the
 * `template_match_enriched` listener can find the suggestion to update.
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

/**
 * Always-visible shell.
 *
 * === wave 19 === — two vertical bands (was three before wave 19).
 *   • left   — Sidebar (240px)            : 5-item primary nav + footer
 *   • center — main content (flex-1)      : route Outlet (full-width)
 *
 * The right ActivityFeed rail was removed in wave 19 so non-/today routes
 * (memory file tree, brain viz, canvas board) get the full horizontal
 * space they need. Wave 20 will re-mount the activity widget INSIDE
 * /today as a dashboard card.
 *
 * The Cmd+K palette is mounted globally so it works from any route. The
 * yellow "what's new since you looked" banner is mounted at the very top
 * of the center band — it's hidden until cursor diff produces unseen
 * atoms older than 1 hour.
 */
export function AppShell() {
  const toasts = useStore((s) => s.ui.toasts);
  const dismissToast = useStore((s) => s.ui.dismissToast);
  const paletteOpen = useStore((s) => s.ui.paletteOpen);
  const togglePalette = useStore((s) => s.ui.togglePalette);
  const setPalette = useStore((s) => s.ui.setPalette);
  const localOnly = useStore((s) => s.ui.localOnly);
  const currentUser = useStore((s) => s.ui.currentUser);
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  const setMemoryRoot = useStore((s) => s.ui.setMemoryRoot);
  const samplesSeeded = useStore((s) => s.ui.samplesSeeded);
  const setSamplesSeeded = useStore((s) => s.ui.setSamplesSeeded);
  // === wave 13 ===
  // Wave 13 — populated-app demo seed first-launch wiring. The trigger
  // effect below short-circuits when `demoSeedAttempted` is already true
  // so we never re-flip the banner for users who explicitly hid it.
  const demoSeedAttempted = useStore((s) => s.ui.demoSeedAttempted);
  const setDemoMode = useStore((s) => s.ui.setDemoMode);
  const setDemoSeedAttempted = useStore((s) => s.ui.setDemoSeedAttempted);
  // === end wave 13 ===
  const memoryConfigMode = useStore((s) => s.ui.memoryConfig.mode);
  // === wave 11 === — first-run setup-wizard auto-trigger state.
  // Read once per render so the auto-trigger effect can decide whether to
  // mount SetupWizard right after WelcomeOverlay closes. The wizard only
  // auto-shows ONCE per fresh install: skip = wizard suppressed forever
  // (until user opens via banner / Cmd+K), channelReady = wizard never
  // re-prompts (banner self-hides too).
  const welcomed = useStore((s) => s.ui.welcomed);
  const setupWizardOpen = useStore((s) => s.ui.setupWizardOpen);
  const setSetupWizardOpen = useStore((s) => s.ui.setSetupWizardOpen);
  const setupWizardChannelReady = useStore(
    (s) => s.ui.setupWizardChannelReady,
  );
  const setupWizardSkipped = useStore((s) => s.ui.setupWizardSkipped);
  // === end wave 11 ===
  // === v2.5 trial gate ===
  // Track the team-id used for billing scoping. When the user is solo,
  // we anchor on `solo-${currentUser}`; in team mode we use the repoUrl
  // (or repoLocalPath fallback) so multiple machines see the same record.
  const repoUrl = useStore((s) => s.ui.memoryConfig.repoUrl);
  const repoLocalPath = useStore((s) => s.ui.memoryConfig.repoLocalPath);
  const setBillingSnapshot = useStore((s) => s.ui.setBillingSnapshot);
  const billingStatusVal = useStore((s) => s.ui.billingStatus);
  const trialExpiry = useStore((s) => s.ui.trialExpiry);
  // === end v2.5 trial gate ===

  // First-launch + self-healing sample seed.
  //
  // Lives at the AppShell level (not in /memory) because v1.7 changed the
  // default landing surface from /memory to /today. Without this, a fresh
  // user lands on /today and never visits /memory until later — meanwhile the
  // Module A daemon writes `.tangerine/` and `timeline/` sidecars on its
  // first heartbeat, so by the time the user finally hits /memory the old
  // "is the memory dir empty?" check from Rust returns false and seeding
  // gets skipped forever.
  //
  // The fix is a smarter check: we only care whether the user-facing
  // markdown subfolders (meetings/, decisions/, etc.) have any content. If
  // they're all empty we (re)seed regardless of daemon sidecars or the
  // persisted samplesSeeded flag (the flag self-heals on reinstall).
  //
  // Gating:
  //   * memoryConfigMode != null    → past onboarding
  //   * userFacingFoldersEmpty(...) → no user content lives here
  // After a successful seed we dispatch MEMORY_REFRESHED_EVENT so the
  // sidebar tree + /today timeline rerun their reads immediately, with no
  // page reload needed.
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
        // User content already lives here — sync the persisted flag forward
        // so the tree-refresh deps in Sidebar / memory route stay accurate.
        if (!samplesSeeded) setSamplesSeeded(true);
        return;
      }
      // User-facing folders are empty. If the persisted flag is stale (true
      // from a prior install whose data was wiped), reset so callers know we
      // are re-seeding.
      if (samplesSeeded) setSamplesSeeded(false);
      const r = await initMemoryWithSamples();
      if (cancel) return;
      if (r.path && !r.path.startsWith("~")) {
        setMemoryRoot(r.path);
      }
      // Only commit the flag once seeding actually wrote files. After a
      // successful copy, fan a refresh event out so the sidebar tree + the
      // /today timeline re-read without forcing a route nav.
      if (r.seeded || r.copied > 0) {
        setSamplesSeeded(true);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event(MEMORY_REFRESHED_EVENT));
        }
      }
      // === wave 13 ===
      // Wave 13 — populated-app demo seed. We only attempt the install
      // ONCE per install lifetime (gated by `demoSeedAttempted`), and
      // only when the user-facing folders were empty before this effect
      // fired (i.e. truly-fresh first launch). The Rust command is
      // idempotent on its own, but we don't want to re-flip `demoMode`
      // back to true after the user has explicitly hidden the banner.
      if (!demoSeedAttempted) {
        try {
          const ds = await demoSeedInstall();
          if (cancel) return;
          // Mark attempted regardless of outcome — a transient resource-
          // dir failure shouldn't keep the install effect re-firing on
          // every cold launch.
          setDemoSeedAttempted(true);
          if (ds.ok && ds.copied_files > 0) {
            // Real files landed — flip the banner on so the user knows
            // what they're looking at, and broadcast a refresh so the
            // tree + timeline read the populated state.
            setDemoMode(true);
            if (typeof window !== "undefined") {
              window.dispatchEvent(new Event(MEMORY_REFRESHED_EVENT));
            }
          }
        } catch {
          // Demo seed is best-effort. Mark attempted so we don't loop
          // on a transient failure (e.g. resource_dir unreachable in
          // dev). The user can still get a populated app once the next
          // version reinstalls the bundled tree.
          if (!cancel) setDemoSeedAttempted(true);
        }
      }
      // === end wave 13 ===
    })();
    return () => {
      cancel = true;
    };
  }, [
    memoryConfigMode,
    memoryRoot,
    samplesSeeded,
    setMemoryRoot,
    setSamplesSeeded,
    // === wave 13 ===
    demoSeedAttempted,
    setDemoMode,
    setDemoSeedAttempted,
    // === end wave 13 ===
  ]);

  // === v2.5 trial gate ===
  // Poll `billing_status` on mount + every 1h. Mirrors V2_5_SPEC §2.3:
  // trial-expired with no card → cloud features gated, OSS path keeps
  // working. We DO NOT auto-redirect to /billing here — the route is
  // self-service, and a forced redirect mid-session feels hostile. The
  // `localOnly` strip below renders a paywall hint when status is
  // past_due so the user has a clear path forward without disruption.
  useEffect(() => {
    let cancel = false;
    const teamId = repoUrl ?? repoLocalPath ?? `solo-${currentUser}`;
    const tick = async () => {
      try {
        const s = await fetchBillingStatus(teamId);
        if (cancel) return;
        setBillingSnapshot({ status: s.status, trialExpiry: s.trial_end });
      } catch {
        // Stub mode + no Tauri host → safeInvoke mock returns trialing;
        // any other failure is silent (cloud-features call sites do their
        // own error display).
      }
    };
    void tick();
    const handle = setInterval(() => void tick(), 60 * 60 * 1000); // 1h
    return () => {
      cancel = true;
      clearInterval(handle);
    };
  }, [repoUrl, repoLocalPath, currentUser, setBillingSnapshot]);
  // === end v2.5 trial gate ===

  // v1.9.0-beta.1 — auto-dismiss timers for toasts that declared a
  // `durationMs`. Each timer is keyed by the toast id; we clean them up
  // when the toast leaves the array (user clicked, programmatic dismiss).
  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    for (const t of toasts) {
      if (t.durationMs && t.durationMs > 0) {
        const id = t.id;
        timers.push(
          setTimeout(() => dismissToast(id), t.durationMs),
        );
      }
    }
    return () => {
      for (const tm of timers) clearTimeout(tm);
    };
  }, [toasts, dismissToast]);

  // === wave 5-β ===
  // Local state for the keyboard-shortcuts overlay. Lives in component
  // state (not the store) because it's purely transient UI — opens via
  // `?` press, closes via Esc or backdrop click. Persisting it would be
  // strictly worse: a refresh while the overlay is open is annoying.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // === end wave 5-β ===

  // Cmd+K / Ctrl+K → toggle palette.
  // === wave 5-β ===
  // Same listener also handles `?` (Shift+/) → toggle shortcuts overlay,
  // and `Cmd/Ctrl+,` → jump to /settings. Bracketed inside the same
  // effect so we install/remove a single keydown listener instead of N.
  // Skip `?` when the user is typing in a field — otherwise the
  // shortcut steals every Shift+/ they type into a textarea.
  // === end wave 5-β ===
  useEffect(() => {
    function isTypingTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return true;
      if (t.isContentEditable) return true;
      return false;
    }
    function onKey(e: KeyboardEvent) {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isCmdK) {
        e.preventDefault();
        togglePalette();
        return;
      }
      // === wave 5-β ===
      // Cmd/Ctrl+, → Settings. Standard convention; users from VS Code,
      // Chrome, Slack expect it.
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        // Use the History API directly so we don't need to import
        // useNavigate at the AppShell level (it's already in the
        // <Outlet/> tree). location.assign would full-reload; pushState
        // keeps the router in sync.
        if (typeof window !== "undefined") {
          window.history.pushState({}, "", "/settings");
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
        return;
      }
      // ? (Shift+/) → toggle shortcuts overlay. Suppressed while the
      // user is typing — otherwise the shortcut clobbers every "?"
      // they try to type into a comment / brain edit / search box.
      if (e.key === "?" && !isTypingTarget(e.target)) {
        e.preventDefault();
        setShortcutsOpen((v) => {
          if (!v) void logEvent("shortcuts_open", {});
          return !v;
        });
        return;
      }
      // === end wave 5-β ===
      if (e.key === "Escape" && paletteOpen) {
        setPalette(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePalette, setPalette, paletteOpen]);

  // v1.9.0-beta.1 P1-A — log every route transition. We track `prev` in a
  // ref so the very first render emits `from: ""` (cold-start landing
  // event) and subsequent navigations emit a real `from`. fire-and-forget
  // via `void` so a Tauri stall never blocks the route change.
  const location = useLocation();
  const prevPathRef = useRef<string>("");
  useEffect(() => {
    const to = location.pathname;
    const from = prevPathRef.current;
    if (from === to) return;
    prevPathRef.current = to;
    void logEvent("navigate_route", { from, to });
  }, [location.pathname]);

  // === v1.9 P2 template event listener (consolidated) ===
  // v1.9.0-beta.2 — single Tauri `template_match` listener for ALL 7
  // rule-based templates (P2-A: deadline / pattern_recurrence / conflict;
  // P2-B: decision_drift / long_thread / catchup_hint;
  // P2-C: newcomer_onboarding). Emitted by the co-thinker heartbeat
  // (`agi::co_thinker::heartbeat` → `templates::registry::evaluate_and_emit`
  // → engine `EventSink` → `app.emit("template_match", &m)`).
  //
  // Every payload is forwarded to the suggestion bus, which enforces the
  // 6 anti-Clippy disciplines and routes to the right tier (chip /
  // banner / toast / modal) per `selectTier`. Single-instance listener —
  // adding a new template never requires touching this block (the
  // payload shape is template-agnostic).
  //
  // Newcomer-onboarding gating: the `newcomer_onboarding` template fires
  // every heartbeat where conditions hold (Rust side is stateless), but
  // the React side uses the persisted `newcomerOnboardingShown` flag to
  // ensure the welcome toast surfaces ONCE per fresh-install lifetime.
  // Once dismissed (or once the flag flips for any other reason) the
  // listener silently drops further matches for that template.
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
            // P2-C newcomer latch — read fresh from the store on every
            // event so a flip during the session takes effect immediately.
            if (p.template === "newcomer_onboarding") {
              const ui = useStore.getState().ui;
              if (ui.newcomerOnboardingShown) {
                // Already shown — drop silently. Future heartbeats will
                // keep emitting the match; this listener keeps swallowing.
                return;
              }
              // Flip the latch BEFORE we push so a duplicate event
              // arriving in the same tick (race) doesn't double-fire.
              ui.setNewcomerOnboardingShown(true);
            }
            // Forward to the bus. The bus enforces the master off-switch,
            // confidence floor, modal budget, and tier selection — we do
            // NOT pre-filter here so the disciplines stay in one place.
            // v1.9.0-beta.3 P3-A: atom_refs flows through so the
            // bus's suppression-check derives the scope chain
            // (atom_refs[0] → surface_id → "global") in lockstep with
            // the Rust recompute.
            // v1.9.0 P4-A: match_id flows through so the Stage 2
            // enrichment listener (below) can find the same suggestion
            // by id and swap `body` in place via `updateSuggestion`.
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
        // Browser dev / vitest where `@tauri-apps/api/event` isn't
        // available — silently no-op so the React layer still mounts.
      }
    })();
    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
    };
  }, []);
  // === end v1.9 P2 template event listener ===

  // === v1.9.0 P4-A Stage 2 enrichment listener ===
  // Listens for `template_match_enriched` Tauri events emitted by the
  // backend's `templates::registry::evaluate_and_emit_with_enrichment`
  // path AFTER the rule emit. The payload shares the same `match_id`
  // as the original rule emit; we forward to `updateSuggestion(...)`
  // which finds the existing suggestion in bannerStack / modalQueue /
  // toasts by `match_id` and swaps `body` in place. Visual cue: the
  // store flips an `enriched: true` flag so the renderer can briefly
  // play a ti-pulse animation as a "got smarter" signal.
  //
  // No-op when:
  //   * The user already dismissed the suggestion (no match in any
  //     surface → silent skip in `updateSuggestion`).
  //   * The Tauri bridge is missing (vitest / browser dev) — same
  //     try/catch as the rule listener above.
  //   * The body equals the existing body (e.g. backend re-emitted
  //     because the cache lost the original) — store still applies the
  //     update; pulse fires harmlessly.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        unlistenFn = await listen<TemplateMatchPayload>(
          "template_match_enriched",
          (e) => {
            const p = e.payload;
            if (!p.match_id) return;
            const ui = useStore.getState().ui;
            // Pre-snapshot bodies so the telemetry payload reports the
            // before/after sizes accurately.
            const before =
              ui.bannerStack.find((b) => b.match_id === p.match_id)?.body ??
              ui.modalQueue.find((m) => m.match_id === p.match_id)?.body ??
              ui.toasts.find((t) => t.match_id === p.match_id)?.msg ??
              "";
            ui.updateSuggestion(p.match_id, p.body);
            // Telemetry — fire-and-forget. The "no-op" path (no
            // matching entry) still logs as enriched-but-no-target so
            // analytics can see the late arrivals.
            void logEvent("suggestion_enriched", {
              match_id: p.match_id,
              original_body_size: before.length,
              new_body_size: p.body.length,
              latency_ms: 0,
            });
          },
        );
      } catch {
        // No Tauri bridge — silent no-op.
      }
    })();
    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
    };
  }, []);
  // === end v1.9.0 P4-A Stage 2 enrichment listener ===

  // v1.9.0-beta.1 P1-A — user-initiated toast dismiss. Wraps `dismissToast`
  // so the click + Esc paths log telemetry, while the auto-dismiss timer
  // above does NOT (auto-dismiss is a timeout, not a user action). The
  // suggestion engine uses dismiss_toast frequency to detect "user
  // ignored 5 suggestion-toasts in a row → quiet for 24h" patterns.
  const dismissToastWithTelemetry = (id: string) => {
    const t = toasts.find((x) => x.id === id);
    if (t) {
      void logEvent("dismiss_toast", {
        toast_id: id,
        kind: t.kind,
      });
    }
    dismissToast(id);
  };

  // Mark the user "opened" the app on every focus. Drives Stage 2
  // personalization (open-time learning) — Stage 1 just keeps cursor's
  // last_opened_at fresh so the WhatsNewBanner triggers correctly. The
  // initial mark happens on mount so the first session counts.
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

  // === wave 11 === — auto-trigger the SetupWizard on first launch.
  //
  // Sequence: WelcomeOverlay (4-C) closes → flips `welcomed = true`. THIS
  // effect watches `welcomed` and opens the wizard exactly once if the
  // user hasn't already finished it (`channelReady`) or explicitly skipped
  // (`skipped`). The wizard's persisted state controls future cold launches
  // — once channelReady or skipped flips, the auto-trigger never re-fires.
  //
  // We don't gate on a route since the user may have arrived on /today via
  // a deep link; the wizard is route-agnostic. WelcomeOverlay is the only
  // gate (so the welcome 4-card tour comes first), and we leave a beat for
  // the welcome dismissal to render through before opening to avoid a
  // layered modal stacking glitch.
  //
  // === wave 18 === — when the user is in conversational onboarding mode
  // (default), we DO NOT auto-pop the form-based SetupWizard. The
  // OnboardingChat that lives inline on /today owns the first-run
  // experience instead. The form wizard is still reachable via Cmd+K and
  // the inline "Use form-based setup" link in the chat shell.
  const onboardingMode = useStore((s) => s.ui.onboardingMode);
  // === end wave 18 ===
  useEffect(() => {
    if (!welcomed) return;
    if (setupWizardChannelReady) return;
    if (setupWizardSkipped) return;
    if (setupWizardOpen) return;
    // === wave 18 ===
    // Chat mode owns first-run. Bail out of the form-wizard auto-trigger
    // entirely so the user lands on /today and sees the OnboardingChat,
    // not a layered modal on top of it.
    if (onboardingMode === "chat") return;
    // === end wave 18 ===
    const timer = window.setTimeout(() => {
      setSetupWizardOpen(true);
      void logEvent("setup_wizard_auto_triggered", {});
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    welcomed,
    setupWizardChannelReady,
    setupWizardSkipped,
    setupWizardOpen,
    setSetupWizardOpen,
    // === wave 18 ===
    onboardingMode,
    // === end wave 18 ===
  ]);
  // === end wave 11 ===

  // === wave 1.13-A ===
  // Wave 1.13-A — collab inbox listener.
  //
  // Subscribes to the `inbox:event_created` Tauri event emitted by
  // `commands::inbox_store::inbox_emit`. When the event's `targetUser`
  // matches the current user, push:
  //   1. An in-app toast (uses the existing wave-1.9 toast layer).
  //   2. A system notification via `system_notify` (best-effort; degrades
  //      to a no-op when the OS plugin isn't wired).
  //
  // Source-user events are dropped silently — you don't need a
  // notification when YOU mention yourself.
  const pushToast = useStore((s) => s.ui.pushToast);
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    let myAlias: string | null = null;
    void (async () => {
      try {
        // Resolve the current user once. Falls back to the mock alias
        // ("you") outside Tauri so the no-op listener path still runs.
        try {
          const me = await identityGetCurrentUser();
          if (cancelled) return;
          myAlias = me.alias;
        } catch {
          /* identity is best-effort */
        }
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        unlistenFn = await listen<CollabInboxEvent>(
          "inbox:event_created",
          (e) => {
            const ev = e.payload;
            // Drop self-mentions + events that aren't for me.
            if (myAlias && ev.targetUser !== myAlias) return;
            if (myAlias && ev.sourceUser === myAlias) return;
            const verb =
              ev.kind === "mention"
                ? "mentioned you"
                : ev.kind === "review_request"
                  ? "requested your review"
                  : ev.kind === "comment_reply"
                    ? "replied to your comment"
                    : "sent you something";
            const title = `@${ev.sourceUser} ${verb}`;
            const snippet =
              (ev.payload?.snippet as string | undefined) ??
              (ev.payload?.atom_title as string | undefined) ??
              ev.sourceAtom ??
              "";
            pushToast({
              kind: "info",
              msg: snippet ? `${title}: ${snippet}` : title,
              ctaLabel: "Open inbox",
              ctaHref: "/inbox",
              durationMs: 6000,
            });
            // System notification — best-effort. The Tauri-side handler is
            // a no-op stub today (see commands::external::system_notify),
            // so this keeps working when OS notifications are wired in
            // later without requiring a code change here.
            void systemNotify(title, snippet || "Open Tangerine to view.");
          },
        );
      } catch {
        // Browser dev / vitest where `@tauri-apps/api/event` isn't
        // available — silently no-op so the React layer still mounts.
      }
    })();
    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
    };
    // pushToast is a stable zustand setter so effect runs once.
  }, [pushToast]);
  // === end wave 1.13-A ===

  // === v1.13.5 round-5 ===
  // Round 5 Tauri-event-parity audit found two emit-without-listener bugs:
  //   * `writeback:event` — fires from sources/watcher.rs every time a
  //     GitHub/Linear writeback completes, but no React subscriber. The
  //     decision-trail UI in /reviews can't tell when a writeback lands.
  //   * `config-changed` — fires from commands/config.rs after set_config,
  //     but the Settings panel doesn't auto-refresh on external edits.
  // Both are wired here as lightweight listeners that log telemetry so we
  // have observability + a hook point for v1.14 UI surfaces. The actual
  // refresh/toast UI is intentionally NOT added — that's a v1.14 surface
  // decision. This unblocks future wires without keeping the events dead.
  useEffect(() => {
    let unWb: (() => void) | null = null;
    let unCfg: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const { logEvent } = await import("@/lib/telemetry");
        if (cancelled) return;
        unWb = await listen<unknown>("writeback:event", (e) => {
          // Best-effort; an unknown payload shape mustn't break logging.
          const outcome = (e.payload ?? {}) as Record<string, unknown>;
          void logEvent("writeback_event_observed" as unknown as never, {
            ok: outcome["ok"] ?? null,
            kind: outcome["kind"] ?? null,
          });
        });
        if (cancelled) return;
        unCfg = await listen<unknown>("config-changed", () => {
          void logEvent("config_changed_observed" as unknown as never, {});
        });
      } catch {
        // Browser / vitest — no Tauri bridge; silently no-op.
      }
    })();
    return () => {
      cancelled = true;
      if (unWb) unWb();
      if (unCfg) unCfg();
    };
  }, []);
  // === end v1.13.5 round-5 ===

  return (
    // v1.8 Phase 4 — the AmbientInputObserver wraps the whole shell so a
    // single delegated input listener sees every textarea / contenteditable
    // / palette input in the app. There is intentionally no chatbot tab;
    // every input is an AGI entry point.
    // === wave 22 === — CoachmarkProvider sits ABOVE the AmbientInputObserver
    // so any route component (or floating UI like the FAB / tour) can pull
    // `useCoachmark` regardless of which subtree it lives in. The provider
    // tracks one active step at a time and is a no-op until something calls
    // `showStep`.
    <CoachmarkProvider>
    {/* === wave 1.13-D === — Team presence wraps inside CoachmarkProvider so
        the pill + sidebar dots can call useCoachmark in future iterations.
        Provider must mount inside <BrowserRouter> (which AppShell already
        sits under) because the heartbeat reads `useLocation()`. */}
    <PresenceProvider>
    {/* === end wave 1.13-D === */}
    <AmbientInputObserver>
      <div className="flex h-full w-full bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
        <Sidebar />

        <div className="flex min-w-0 flex-1 flex-col">
          {/* v1.9.0 P4-B — License flip banner. Sits above the WhatsNew /
              local-only strips so the transition notice is the very first
              thing in the content column. Self-dismissing; honours
              localStorage so it never nags after the user clicks ×.
              Always visible in dev mode for contributor awareness. */}
          <LicenseTransitionBanner />
          {/* Wave 3 — connection state. Shows when offline + flashes
              briefly on recovery. Above WhatsNewBanner so a network
              drop is the loudest signal in the strip stack. */}
          <ConnectionBanner />
          {/* === wave 13 === — populated-app demo mode banner. Self-hides
              when `ui.demoMode === false`. ErrorBoundary mirrors the
              wave-10.1 lesson: a thrown render here can never blank
              the shell. Sits above WhatsNewBanner so the demo signal
              isn't buried under "what's new" copy. */}
          <ErrorBoundary label="DemoModeBanner">
            <DemoModeBanner />
          </ErrorBoundary>
          {/* === end wave 13 === */}
          {/* === wave 10 === — git-init wizard banner. Self-hides when
              `gitMode !== "unknown"` or when the memory dir is already a
              git repo. Sits below ConnectionBanner so a network drop is
              still the loudest signal. */}
          {/* === wave 10.1 hotfix === — boundary so a broken banner can
              never blank the shell. Renders null on any throw + logs to
              console with the [wave10] prefix for grep-ability. */}
          <ErrorBoundary label="GitInitBanner">
            <GitInitBannerContainer />
          </ErrorBoundary>
          {/* === end wave 10 === */}
          {/* === wave 11 === — first-run LLM channel banner. Self-hides
              when the user finishes the wizard (channelReady) or
              dismisses for the session. ErrorBoundary so a thrown
              render never blanks the shell (Wave 10.1 lesson). */}
          <ErrorBoundary label="SetupWizardBanner">
            <SetupWizardBanner />
          </ErrorBoundary>
          {/* === end wave 11 === */}
          <WhatsNewBanner />
          {/* === v2.0-beta.3 co-thinker home strip ===
              Sits between the system banners and the suggestion banner so
              the AGI presence indicator is the very first content-band
              the user sees on every route. The strip self-hides when the
              master AGI participation switch is off; mounting it
              unconditionally keeps the layout stable across that flip
              (its own `null` return collapses height to 0). */}
          <HomeStrip />
          {/* === end v2.0-beta.3 co-thinker home strip === */}
          {/* === wave 1.13-D === — TeammatesPill sits flush-right in the
              same row as the HomeStrip-adjacent strip. Self-hides when 0
              teammates active so a solo session looks unchanged. */}
          <div className="flex justify-end px-3 py-1">
            <TeammatesPill />
          </div>
          {/* === end wave 1.13-D === */}
          {localOnly && (
            <div className="ti-no-select flex h-7 items-center justify-center border-b border-[var(--ti-orange-500)]/30 bg-[var(--ti-orange-50)] px-4 text-[11px] font-medium text-[var(--ti-orange-700)] dark:border-[var(--ti-orange-500)]/30 dark:bg-stone-900 dark:text-[var(--ti-orange-500)]">
              Local memory only — sign in to sync your memory dir across machines.
            </div>
          )}
          {/* === v2.5 trial gate === */}
          {/* Paywall hint — surfaces when trial expired and no paid sub. */}
          {billingStatusVal === "past_due" && (
            <div className="ti-no-select flex h-7 items-center justify-center gap-2 border-b border-[var(--ti-danger)]/30 bg-[var(--ti-danger)]/5 px-4 text-[11px] font-medium text-[var(--ti-danger)]">
              Trial expired · Upgrade to keep cloud sync running ·{" "}
              <a href="/billing" className="underline-offset-2 hover:underline">
                Open billing
              </a>
            </div>
          )}
          {billingStatusVal === "trialing" &&
            trialExpiry > 0 &&
            trialExpiry - Math.floor(Date.now() / 1000) < 7 * 24 * 60 * 60 && (
              <div className="ti-no-select flex h-7 items-center justify-center gap-2 border-b border-[var(--ti-orange-500)]/30 bg-[var(--ti-orange-50)] px-4 text-[11px] font-medium text-[var(--ti-orange-700)]">
                Trial ending soon · No card needed yet ·{" "}
                <a href="/billing" className="underline-offset-2 hover:underline">
                  Upgrade for $5/team/mo
                </a>
              </div>
            )}
          {/* === end v2.5 trial gate === */}
          {/* v1.9.0-beta.1 — banner host sits below the system strips so the
              suggestion-tier banners feel like part of the route content. */}
          <BannerHost />
          <main className="flex-1 overflow-auto bg-stone-50 dark:bg-stone-950">
            <Outlet />
          </main>
        </div>

        {/* === wave 19 === — ActivityFeed right-rail mount removed.
            Wave 20 re-embeds the widget inside /today's dashboard so
            the activity signal stays visible on the home surface where
            users expect it (and where it doesn't crowd /memory or
            /canvas). The component itself is unchanged. */}

        <CommandPalette open={paletteOpen} onClose={() => setPalette(false)} />

        {/* Toast layer.
            v1.9.0-beta.1: now also renders kind="suggestion" toasts with a
            🍊 prefix dot and an optional CTA. Suggestion toasts auto-dismiss
            after `durationMs` (default 4s); errors stick. */}
        {toasts.length > 0 && (
          <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
            {toasts.map((t) => {
              const isSuggestion = t.kind === "suggestion";
              return (
                <div
                  key={t.id}
                  role="status"
                  data-toast-id={t.id}
                  data-toast-kind={t.kind}
                  data-testid={isSuggestion ? "suggestion-toast" : "toast"}
                  className="pointer-events-auto max-w-sm rounded-md border border-stone-200 bg-stone-50 px-4 py-3 text-sm shadow-md animate-fade-in dark:border-stone-800 dark:bg-stone-900"
                >
                  <div className="flex items-start gap-2">
                    {isSuggestion && (
                      <span
                        aria-hidden
                        className="mt-0.5 inline-block flex-shrink-0 text-[14px]"
                        title="Tangerine"
                      >
                        🍊
                      </span>
                    )}
                    <span
                      onClick={() => dismissToastWithTelemetry(t.id)}
                      className={
                        "min-w-0 flex-1 cursor-pointer " +
                        (t.kind === "success"
                          ? "text-emerald-700 dark:text-emerald-400"
                          : t.kind === "error"
                            ? "text-rose-700 dark:text-rose-400"
                            : "text-stone-700 dark:text-stone-300")
                      }
                    >
                      {t.msg}
                    </span>
                  </div>
                  {isSuggestion && t.ctaLabel && (
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        data-testid="suggestion-toast-cta"
                        onClick={() => {
                          try {
                            if (t.onAccept) t.onAccept();
                            else if (t.ctaHref && typeof window !== "undefined") {
                              window.location.href = t.ctaHref;
                            }
                          } finally {
                            dismissToast(t.id);
                          }
                        }}
                        className="rounded border border-[var(--ti-orange-300,#FFB477)] bg-[var(--ti-orange-100,#FFE4CD)] px-2 py-0.5 font-mono text-[11px] text-[var(--ti-orange-700,#A04400)] hover:bg-[var(--ti-orange-200,#FFD0A8)] dark:border-stone-600 dark:bg-stone-800 dark:text-[var(--ti-orange-500,#CC5500)] dark:hover:bg-stone-700"
                      >
                        {t.ctaLabel}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* v1.9.0-beta.1 — modal host. Lives outside the flex column so the
            portal-rendered backdrop covers the full viewport. */}
        <ModalHost />

        {/* Wave 4-C — first-run welcome tour. Sits at the top of the
            z-stack so it covers banners + modals on a fresh install.
            Self-hides on subsequent launches via persisted `welcomed`
            flag, so this mount is a no-op for returning users. */}
        <WelcomeOverlay />

        {/* === wave 11 === — first-run LLM channel setup wizard. Auto-
            opens once after WelcomeOverlay closes (effect above). Also
            opened on demand from the SetupWizardBanner / Cmd+K palette /
            heartbeat-fail toast. Wrapped in an ErrorBoundary so a thrown
            render never blanks the shell. Mounted ABOVE WelcomeOverlay
            in z-order so a fast re-trigger doesn't end up trapped under
            a stale welcome tour. */}
        <ErrorBoundary label="SetupWizard">
          <SetupWizard
            open={setupWizardOpen}
            onClose={() => setSetupWizardOpen(false)}
          />
        </ErrorBoundary>
        {/* === end wave 11 === */}

        {/* === wave 5-β === */}
        {/* Discoverability layer. HelpButton is a fixed-position floating
            `?` icon at bottom-right; KeyboardShortcutsOverlay is the
            global cheatsheet bound to the `?` key. Both live OUTSIDE
            the flex column above (same level as ModalHost) so they
            float above any route content + sidebar. The shortcuts
            overlay self-hides when `shortcutsOpen` is false; mounting
            unconditionally keeps the listener wiring stable across
            route changes. */}
        <HelpButton />
        <KeyboardShortcutsOverlay
          open={shortcutsOpen}
          onClose={() => setShortcutsOpen(false)}
        />
        {/* === end wave 5-β === */}

        {/* === wave 25 === — auto-update banner. Wrapped in ErrorBoundary
            (Wave 10.1 lesson) so a thrown render in the updater plugin
            never blanks the shell. Mounted at the top z-stack alongside
            the help button so a "v1.12.1 available" hint is visible
            from every route. */}
        <ErrorBoundary label="UpdaterCheck">
          <UpdaterCheck />
        </ErrorBoundary>
        {/* === end wave 25 === */}

        {/* === wave 22 === — first-run guided tour + "try this" FAB.
            Both are mounted unconditionally; each gates itself internally
            so a returning user (firstRunTourCompleted=true / no demoMode)
            sees nothing. Wrapped in ErrorBoundary so a thrown render in
            the tour cannot blank the shell (Wave 10.1 lesson). */}
        <ErrorBoundary label="FirstRunTour">
          <FirstRunTour />
        </ErrorBoundary>
        <ErrorBoundary label="TryThisFAB">
          <TryThisFAB />
        </ErrorBoundary>
        {/* === end wave 22 === */}
      </div>
    </AmbientInputObserver>
    {/* === wave 1.13-D === */}
    </PresenceProvider>
    {/* === end wave 1.13-D === */}
    </CoachmarkProvider>
  );
}
