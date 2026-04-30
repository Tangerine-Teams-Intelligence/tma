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
  Layers,
  // === wave 1.13-A === — Inbox is the 6th sidebar nav item.
  Inbox as InboxIcon,
  // === end wave 1.13-A ===
  // === v1.18.0 === — Canvas (heat-map + atom + Replay) surface.
  Map as MapIcon,
  // === end v1.18.0 ===
} from "lucide-react";
import { cn } from "@/lib/utils";
import { signOut } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { SyncStatusIndicator } from "@/components/SyncStatusIndicator";
// === wave 1.13-A ===
// Wave 1.13-A — drives the orange unread badge next to the Inbox label.
// Hook polls once on mount and listens for `inbox:event_created` so a
// fresh @mention bumps the count immediately. Listener is a no-op
// outside Tauri — the count stays at 0 in browser dev / vitest.
import { useInboxUnreadCount } from "@/lib/identity";
// === end wave 1.13-A ===
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
// === wave 1.13-D ===
// v1.13 — small avatar dots inline with each primary nav item showing
// which teammates are currently viewing that route. Self-hides per item
// when no teammates match.
import { SidebarPresenceDots } from "@/components/presence/SidebarPresenceDots";
// === end wave 1.13-D ===

/**
 * Always-visible left rail (~240px).
 *
 * === wave 19 === — drastic IA reduction. The rail now hosts a single
 * 5-item primary nav (Today / Memory / Brain / Canvas + Settings in
 * the footer) plus a brand mark and the system-action footer. Every
 * other surface (sources, AI tools, alignment, inbox, this-week, people,
 * projects, threads, reviews, marketplace, graphs, sinks) still lives
 * at the same routes — they're just no longer in the rail. Power users
 * reach them via Cmd+K (CommandPalette already indexes all of them) or
 * Settings → Sources / AI tools tabs.
 */
export function Sidebar() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const togglePalette = useStore((s) => s.ui.togglePalette);
  // === wave 1.13-A === — drives the unread badge on the Inbox nav item.
  const inboxUnread = useInboxUnreadCount();
  // === end wave 1.13-A ===

  async function handleLock() {
    await signOut();
    navigate("/auth", { replace: true });
  }

  return (
    <aside className="ti-no-select flex h-full w-[240px] shrink-0 flex-col border-r border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-950">
      {/* === wave 19 === — Brand header. Larger than the wave-8 22×22 chip:
          a 28×28 rounded tile + display-serif "Tangerine" wordmark + a
          subtitle ("Your team's AI memory") that hammers the team-memory
          positioning every time the rail loads. Click → /today.
          Cmd+K trigger sits to the right of the wordmark. */}
      <div className="flex items-start justify-between gap-2 border-b border-stone-200 px-3 py-3 dark:border-stone-800">
        <NavLink
          to="/feed"
          className="flex min-w-0 flex-1 items-center gap-2"
          aria-label="Tangerine — Feed"
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
          onClick={togglePalette}
          className="mt-0.5 shrink-0 rounded border border-stone-200 px-1.5 py-0.5 font-mono text-[10px] text-stone-500 hover:bg-stone-100 dark:border-stone-800 dark:text-stone-400 dark:hover:bg-stone-900"
          aria-label="Open command palette"
          title="Search memory · Cmd+K"
        >
          {kbdShortcut("k")}
        </button>
      </div>

      {/* === v1.16 Wave 6 dogfood — sidebar rewritten to match the new
          3-view-mode design. /today / /co-thinker / /canvas were all
          砍 in Wave 1 demolition; the surviving primary surfaces are
          /feed (Story Feed, default landing), /threads (mention auto-
          group), /people (teammate grid), and /memory (file tree fallback
          for power users). Inbox is collapsed into /threads since
          @mention notifications are the same data. Linear-style clean
          rail: 4 primary nav items + footer system controls. */}
      <nav
        className="flex-1 overflow-y-auto px-2 py-3"
        data-testid="sidebar-primary-nav"
      >
        <ViewLink
          to="/feed"
          icon={Calendar}
          label={t("sidebar.feed", { defaultValue: "Feed" })}
          testId="sidebar-nav-feed"
          presenceRoute="/feed"
        />
        <ViewLink
          to="/threads"
          icon={InboxIcon}
          label={t("sidebar.threads", { defaultValue: "Threads" })}
          testId="sidebar-nav-threads"
          badge={inboxUnread > 0 ? inboxUnread : undefined}
        />
        <ViewLink
          to="/people"
          icon={Brain}
          label={t("sidebar.people", { defaultValue: "People" })}
          testId="sidebar-nav-people"
          presenceRoute="/people"
        />
        {/* === v1.18.0 === — Canvas: 2D zoom-based heat-map + atom view
            + Replay timelapse. Sits between /people and /memory per
            the spec ("一个 surface, 两个 zoom level + 一个 timelapse"). */}
        <ViewLink
          to="/canvas"
          icon={MapIcon}
          label={t("sidebar.canvas", { defaultValue: "Canvas" })}
          testId="sidebar-nav-canvas"
          presenceRoute="/canvas"
        />
        {/* === end v1.18.0 === */}
        <ViewLink
          to="/memory"
          icon={FolderKanban}
          label={t("sidebar.memory")}
          testId="sidebar-nav-memory"
          presenceRoute="/memory"
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

// === wave 19 ===
// Single ViewLink primitive remains. The Section / SourceLink / SinkLink /
// StatusChip primitives moved out (wave 19 sidebar has no sub-sections).
// `activeMatchPaths` accepts an optional list of legacy routes that should
// also count as "active" for the highlight — used so the new /brain route
// shows the orange active state when the user lands on the legacy
// /co-thinker URL via a bookmark or external deep link.
// === end wave 19 ===
function ViewLink({
  to,
  icon: Icon,
  label,
  testId,
  activeMatchPaths,
  // === wave 1.13-D === — opt-in route key for SidebarPresenceDots. When
  // omitted (e.g. footer items, Settings) no presence indicator renders.
  presenceRoute,
  // === end wave 1.13-D ===
  // === wave 1.13-A === — opt-in unread badge (orange chip with count).
  // Currently consumed by the Inbox nav item; future surfaces may reuse
  // for review queue / suppressed suggestions count.
  badge,
  // === end wave 1.13-A ===
}: {
  to: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  testId?: string;
  activeMatchPaths?: string[];
  presenceRoute?: string;
  badge?: number;
}) {
  return (
    <NavLink
      to={to}
      data-testid={testId}
      className={({ isActive }) => {
        // === wave 19 === — manual extra-active check so /brain stays
        // highlighted when the user is sitting on /co-thinker (legacy
        // bookmark). NavLink's built-in `isActive` only honours `to`.
        const extraActive =
          (activeMatchPaths ?? []).some(
            (p) =>
              typeof window !== "undefined" &&
              window.location.pathname.startsWith(p),
          );
        const active = isActive || extraActive;
        return cn(
          // === wave 19 === — rail items get a touch more breathing room
          // (py-1 vs. wave-8 py-0.5) since there are only 4 of them; the
          // dense vertical rhythm only made sense when 30+ items competed.
          "flex items-center gap-2 rounded px-2 py-1 text-[13px]",
          active
            ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
            : "text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900",
        );
      }}
    >
      <Icon size={14} className="shrink-0" />
      <span className="truncate">{label}</span>
      {/* === wave 1.13-A === — orange unread chip. Mirrors the system
          design (mono font, 10px) used by GitSyncIndicator + the Inbox
          tab badges so the rail reads as one cohesive system. */}
      {badge !== undefined && badge > 0 && (
        <span
          data-testid={testId ? `${testId}-badge` : undefined}
          className="ml-auto rounded-full bg-[var(--ti-orange-500)] px-1.5 py-0.5 font-mono text-[10px] leading-none text-white"
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      {/* === end wave 1.13-A === */}
      {/* === wave 1.13-D === — teammate avatars inline with the route
          when one or more teammates are viewing it. Self-hides when
          empty so solo users see the rail unchanged. */}
      {presenceRoute && <SidebarPresenceDots route={presenceRoute} />}
      {/* === end wave 1.13-D === */}
    </NavLink>
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
