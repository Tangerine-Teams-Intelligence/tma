// === wave 19 ===
// Wave 19 Information Architecture redesign — Tangerine = team's AI memory app
// (Linear + Obsidian style, NOT chat-only). UI is read-mostly:
// 80% scanning, 15% querying, 3% writing, 2% configuring.
//
// Sidebar drastically reduced from ~30 items across 5+ sections to 5 nav items
// + footer system actions. Everything else (Sources, AI tools, Active agents,
// Advanced, extra views, graphs) is reachable via Cmd+K and Settings, just no
// longer clutters the rail.
//
// Final shape:
//   ┌──────────────────┐
//   │ [T] Tangerine    │  ← brand mark + Cmd+K trigger
//   │  Your team's     │
//   │   AI memory      │
//   ├──────────────────┤
//   │ ▣ Today          │
//   │ ▤ Memory         │
//   │ ◈ Brain          │  ← was /co-thinker, /brain alias added
//   │ ◇ Canvas         │
//   ├──────────────────┤
//   │ ⚙ Settings       │
//   │ 🌙 Theme         │
//   │ ↪ Sign out       │
//   └──────────────────┘
//
// Wave 18 fully delegated all dispatcher / collapse / count-chip logic to
// Sidebar; wave 19 yanks all of that out. No more collapsible sections, no
// "Show advanced" toggle, no SOURCES / AI TOOLS / ACTIVE AGENTS sections.
// Everything not in the 5-item primary nav is reachable via Cmd+K (Wave 5-β +
// Wave 15 already index every route + per-source / per-AI-tool route).
// === end wave 19 ===

import { useTranslation } from "react-i18next";
import { NavLink, useNavigate } from "react-router-dom";
import {
  Settings,
  Lock,
  Sun,
  Moon,
  Monitor,
  Calendar,
  FolderKanban,
  Brain,
  // === v1.18.0 === — Canvas (heat-map + atom + Replay) surface.
  Map as MapIcon,
  // === end v1.18.0 ===
  // === v1.20.0 === — Replay icon for the new R-view sidebar entry.
  Play as PlayIcon,
  // === end v1.20.0 ===
} from "lucide-react";
import { cn } from "@/lib/utils";
import { signOut } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { SyncStatusIndicator } from "@/components/SyncStatusIndicator";
// === wave 10 === — v1.10 git auto-sync indicator (above Settings).
import { GitSyncIndicatorContainer } from "@/components/GitSyncIndicatorContainer";
// === end wave 10 ===
// === wave 10.1 hotfix === — defensive boundary around the wave-10 mount.
// See AppShell.tsx for the rationale. The sidebar footer is the more
// dangerous wrap site: a throw here would visually wipe the rail too,
// not just the dot itself.
import { ErrorBoundary } from "@/components/ErrorBoundary";
// === end wave 10.1 hotfix ===
import { kbdShortcut } from "@/lib/platform";

/**
 * Always-visible left rail (~240px) — hidden by default in v1.19+.
 *
 * === v1.20.0 === — full IA rewrite to match the v1.19 single-canvas
 * design. The wave-19 sidebar still pointed all 5 nav links at routes
 * (/feed, /threads, /people, /canvas, /memory) that v1.19's redirect
 * table sends to /. Clicking any of them while the user was on /
 * looked like a no-op — orange highlight flickered but the canvas view
 * never changed. Now each link is a button that flips
 * `ui.canvasView` directly, mirroring the T/H/P/R single-key
 * shortcuts that AppShell wires up. The Memory entry stays as the
 * only true route nav (it does live at /memory; v1.19 redirects it but
 * MemoryRoute is still mounted so direct URL access works).
 *
 * Brand link: was /feed (dead), now /. The Cmd+K trigger button used
 * to call togglePalette() which flipped a `paletteOpen` flag with no
 * UI consumer (legacy CommandPalette overlay was deleted in v1.16).
 * Now it sets `ui.spotlightOpen = true` so the new Spotlight modal
 * actually opens when clicked.
 */
export function Sidebar() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const setSpotlightOpen = useStore((s) => s.ui.setSpotlightOpen);
  const canvasView = useStore((s) => s.ui.canvasView);
  const setCanvasView = useStore((s) => s.ui.setCanvasView);

  async function handleLock() {
    await signOut();
    navigate("/auth", { replace: true });
  }

  return (
    <aside className="ti-no-select flex h-full w-[240px] shrink-0 flex-col border-r border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-950">
      {/* Brand header — 28×28 rounded "T" tile + display-serif wordmark
          + subtitle ("Your team's AI memory"). Click → /. */}
      <div className="flex items-start justify-between gap-2 border-b border-stone-200 px-3 py-3 dark:border-stone-800">
        <NavLink
          to="/"
          className="flex min-w-0 flex-1 items-center gap-2"
          aria-label="Tangerine — home"
          data-testid="sidebar-brand"
        >
          <div
            data-testid="tangerine-logo"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[15px] font-semibold text-white shadow-sm"
            style={{
              background:
                "linear-gradient(135deg, var(--ti-orange-500) 0%, var(--ti-orange-700) 100%)",
              fontFamily: "var(--ti-font-display)",
              lineHeight: "1",
            }}
            aria-hidden
          >
            T
          </div>
          <div className="flex min-w-0 flex-col">
            <span
              className="truncate text-[14px] font-semibold leading-tight tracking-tight text-[var(--ti-ink-900)] dark:text-[var(--ti-ink-900)]"
              style={{ fontFamily: "var(--ti-font-display)" }}
            >
              Tangerine
            </span>
            <span
              className="truncate text-[10px] leading-tight text-[var(--ti-ink-500)]"
              data-testid="sidebar-brand-subtitle"
            >
              {t("sidebar.subtitleBrand", {
                defaultValue: "Your team's AI memory",
              })}
            </span>
          </div>
        </NavLink>
        <button
          type="button"
          onClick={() => setSpotlightOpen(true)}
          className="mt-0.5 shrink-0 rounded border border-stone-200 px-1.5 py-0.5 font-mono text-[10px] text-stone-500 hover:bg-stone-100 dark:border-stone-800 dark:text-stone-400 dark:hover:bg-stone-900"
          aria-label="Open Spotlight"
          title="Search memory · Cmd+K"
        >
          {kbdShortcut("k")}
        </button>
      </div>

      {/* === v1.20.0 — canvas-view buttons.
          T (time), H (heatmap), P (people), R (replay) mirror the
          AppShell single-key shortcuts. Active state highlights the
          current `ui.canvasView`. The 5th item (Memory) is the only
          true route nav since /memory is still a legitimate fallback
          surface for power users editing the file tree directly. */}
      <nav
        className="flex-1 overflow-y-auto px-2 py-3"
        data-testid="sidebar-primary-nav"
      >
        <CanvasViewButton
          icon={Calendar}
          label={t("sidebar.viewTime", { defaultValue: "Time" })}
          testId="sidebar-nav-time"
          view="time"
          activeView={canvasView}
          onClick={() => {
            setCanvasView("time");
            navigate("/");
          }}
        />
        <CanvasViewButton
          icon={MapIcon}
          label={t("sidebar.viewHeatmap", { defaultValue: "Heatmap" })}
          testId="sidebar-nav-heatmap"
          view="heatmap"
          activeView={canvasView}
          onClick={() => {
            setCanvasView("heatmap");
            navigate("/");
          }}
        />
        <CanvasViewButton
          icon={Brain}
          label={t("sidebar.viewPeople", { defaultValue: "People" })}
          testId="sidebar-nav-people"
          view="people"
          activeView={canvasView}
          onClick={() => {
            setCanvasView("people");
            navigate("/");
          }}
        />
        <CanvasViewButton
          icon={PlayIcon}
          label={t("sidebar.viewReplay", { defaultValue: "Replay" })}
          testId="sidebar-nav-replay"
          view="replay"
          activeView={canvasView}
          onClick={() => {
            setCanvasView("replay");
            navigate("/");
          }}
        />
        <ViewLink
          to="/memory"
          icon={FolderKanban}
          label={t("sidebar.memory")}
          testId="sidebar-nav-memory"
        />
      </nav>

      {/* Footer — === wave 8 === subtle warm tint zone groups the
          system controls (sync / settings / theme / sign-out) so the
          eye reads them as a cluster rather than four floating items.
          === wave 19 === — footer keeps these three system actions plus
          the git-sync + team-sync indicators (no item changes vs. wave 14
          footer). The "Show advanced" toggle is gone — there's no longer
          anything to reveal in the rail. */}
      <div className="ti-zone-quiet border-t border-stone-200 px-2 py-2 dark:border-stone-800">
        {/* === wave 10 === — git auto-sync dot, above the v1.6 team-mode
            SyncStatusIndicator. The two coexist: the v1.6 indicator surfaces
            the team-mode push/pull cadence (which uses an OAuth token + a
            specific team repo), while this one tracks the auto-sync layer
            on the user's `~/.tangerine-memory/` git repo. Click → opens a
            popover with branch / last commit / pull-now / push-now /
            open-shell. */}
        {/* === wave 10.1 hotfix === — boundary so a broken indicator can
            never blank the sidebar footer. */}
        <ErrorBoundary label="GitSyncIndicator">
          <GitSyncIndicatorContainer />
        </ErrorBoundary>
        <SyncStatusIndicator />
        <NavLink
          to="/settings"
          data-testid="sidebar-footer-settings"
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2 rounded px-2 py-1 text-[12px]",
              isActive
                ? "bg-stone-100 text-stone-900 dark:bg-stone-900 dark:text-stone-100"
                : "text-stone-600 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-900",
            )
          }
        >
          <Settings size={12} className="shrink-0" />
          <span>{t("sidebar.settings")}</span>
        </NavLink>
        <ThemeToggle />
        <button
          type="button"
          onClick={handleLock}
          data-testid="sidebar-footer-signout"
          className="mt-0.5 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-stone-600 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-900"
        >
          <Lock size={12} className="shrink-0" />
          <span>{t("sidebar.signOut")}</span>
        </button>
      </div>
    </aside>
  );
}

/**
 * v1.20.0 — Slim ViewLink kept for the surviving Memory route nav.
 * The wave-1.13 presence dots + unread badge wiring is gone (the only
 * caller that used them was Inbox/Threads, which v1.20 removed because
 * those routes redirect to / anyway).
 */
function ViewLink({
  to,
  icon: Icon,
  label,
  testId,
}: {
  to: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  testId?: string;
}) {
  return (
    <NavLink
      to={to}
      data-testid={testId}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 rounded px-2 py-1 text-[13px]",
          isActive
            ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
            : "text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900",
        )
      }
    >
      <Icon size={14} className="shrink-0" />
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

/**
 * v1.20.0 — Canvas-view nav button.
 *
 * The wave-19 sidebar wired its 4 primary nav items to dead routes
 * (/feed → /, /threads → /, /people → /, /canvas → /). v1.20 reroutes
 * them to `setCanvasView()` so clicking actually changes what the user
 * sees. Active highlight derives from `ui.canvasView`, not from the
 * URL, since they all live at `/`.
 */
function CanvasViewButton({
  icon: Icon,
  label,
  testId,
  view,
  activeView,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  testId?: string;
  view: "time" | "heatmap" | "people" | "replay";
  activeView: "time" | "heatmap" | "people" | "replay";
  onClick: () => void;
}) {
  const active = view === activeView;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-active={active ? "true" : "false"}
      data-view={view}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] transition-colors",
        active
          ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
          : "text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900",
      )}
    >
      <Icon size={14} className="shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function ThemeToggle() {
  // === wave 4-D i18n ===
  const { t } = useTranslation();
  const theme = useStore((s) => s.ui.theme);
  const cycle = useStore((s) => s.ui.cycleTheme);
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const label =
    theme === "light"
      ? t("sidebar.themeLight")
      : theme === "dark"
        ? t("sidebar.themeDark")
        : t("sidebar.themeSystem");
  return (
    <button
      type="button"
      onClick={cycle}
      data-testid="sidebar-footer-theme"
      className="mt-0.5 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-stone-600 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-900"
      title="Cycle theme: system → light → dark"
    >
      <Icon size={12} className="shrink-0" />
      <span>{t("sidebar.theme")}</span>
      <span className="ml-auto font-mono text-[10px] text-stone-400 dark:text-stone-500">
        {label}
      </span>
    </button>
  );
}
