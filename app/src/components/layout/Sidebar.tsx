import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, useNavigate } from "react-router-dom";
import {
  Settings,
  Lock,
  Sun,
  Moon,
  Monitor,
  Inbox,
  Activity,
  Calendar,
  CalendarRange,
  Users,
  FolderKanban,
  MessageCircle,
  Layers,
  Brain,
  GitPullRequest,
  Store,
  // === v2.0-beta.1 graphs ===
  Diamond,
  Network,
  Workflow,
  // === end v2.0-beta.1 graphs ===
  // === wave 8 === — collapsible-section chevrons.
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { signOut } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { SOURCES, type SourceDef, type SourceStatus } from "@/lib/sources";
import { SINKS, type SinkDef, type SinkStatus } from "@/lib/sinks";
import {
  readFrontmatterTitle,
  readMemoryTree,
  type MemoryNode,
} from "@/lib/memory";
import { MemoryTree } from "@/components/MemoryTree";
import { SyncStatusIndicator } from "@/components/SyncStatusIndicator";
// === wave 10 === — v1.10 git auto-sync indicator (above Solo / Settings).
import { GitSyncIndicatorContainer } from "@/components/GitSyncIndicatorContainer";
// === end wave 10 ===
// === wave 10.1 hotfix === — defensive boundary around the wave-10 mount.
// See AppShell.tsx for the rationale. The sidebar footer is the more
// dangerous wrap site: a throw here would visually wipe the rail too,
// not just the dot itself.
import { ErrorBoundary } from "@/components/ErrorBoundary";
// === end wave 10.1 hotfix ===
import { AIToolsSection } from "@/components/ai-tools/AIToolsSection";
// === v2.0-beta.2 ACTIVE AGENTS section ===
import { ActiveAgentsSection } from "@/components/layout/ActiveAgentsSection";
// === end v2.0-beta.2 ACTIVE AGENTS section ===
import { MEMORY_REFRESHED_EVENT } from "@/components/layout/AppShell";
import { kbdShortcut } from "@/lib/platform";

/**
 * Always-visible left rail (~240px). v1.8 Phase 1 layout:
 *
 *   VIEWS     — Today / Week / People / Projects / Threads / Alignment / Inbox
 *               + new Canvas (Phase 4) + Co-thinker (Phase 3) entries.
 *   MEMORY    — file tree of the user's memory dir.
 *   SOURCES   — 10 connectors that write to memory (Discord, Slack, GitHub,
 *               Linear, Notion, Calendar, Loom, Zoom, Email, Voice notes).
 *   AI TOOLS  — first-class section: Cursor / Claude Code / ChatGPT etc with
 *               live install-status detected via the Rust `detect_ai_tools`
 *               command. ⭐ marks the user's primary tool.
 *   ADVANCED  — formerly SINKS: Browser ext, MCP server, Local WS server.
 *               These are mechanism, not a user-facing feature — demoted from
 *               the user's mental model in v1.8.
 *
 * Bottom: settings, theme toggle, lock, Cmd+K hint.
 */
export function Sidebar() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  const samplesSeeded = useStore((s) => s.ui.samplesSeeded);
  const togglePalette = useStore((s) => s.ui.togglePalette);
  // === wave 8 === — per-section collapse state from store.
  const sidebarSections = useStore((s) => s.ui.sidebarSections);
  const toggleSidebarSection = useStore((s) => s.ui.toggleSidebarSection);
  const [tree, setTree] = useState<MemoryNode[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancel = false;
    let cancelled = false;
    const refresh = () =>
      readMemoryTree(memoryRoot).then((t) => {
        if (!cancel && !cancelled) setTree(t);
      });
    void refresh();
    // Re-walk when window regains focus so files written by sources outside
    // the app (Discord bot writing to memory/meetings/) show up automatically.
    const onFocus = () => void refresh();
    // AppShell dispatches MEMORY_REFRESHED_EVENT after a sample-seed so the
    // tree picks up the new files immediately without waiting for focus.
    const onRefreshed = () => void refresh();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
      window.addEventListener(MEMORY_REFRESHED_EVENT, onRefreshed);
    }
    return () => {
      cancel = true;
      cancelled = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener(MEMORY_REFRESHED_EVENT, onRefreshed);
      }
    };
    // samplesSeeded is in deps so the tree refreshes once Rust finishes the
    // first-launch sample copy.
  }, [memoryRoot, samplesSeeded]);

  // Whenever the tree changes, fetch frontmatter `title` for every file in
  // parallel so the tree shows human-readable names instead of truncated
  // filenames like `sample-postgres-over-mongo...`. Misses (no title field,
  // file gone, parse failure) silently fall back to the filename.
  useEffect(() => {
    let cancel = false;
    const paths: string[] = [];
    const collect = (nodes: MemoryNode[]): void => {
      for (const n of nodes) {
        if (n.kind === "file") paths.push(n.path);
        else if (n.kind === "dir") collect(n.children ?? []);
      }
    };
    collect(tree);
    if (paths.length === 0) {
      setTitles({});
      return;
    }
    void Promise.all(
      paths.map(async (p) => [p, await readFrontmatterTitle(memoryRoot, p)] as const),
    ).then((rows) => {
      if (cancel) return;
      const next: Record<string, string> = {};
      for (const [p, t] of rows) if (t) next[p] = t;
      setTitles(next);
    });
    return () => {
      cancel = true;
    };
  }, [memoryRoot, tree]);

  async function handleLock() {
    await signOut();
    navigate("/auth", { replace: true });
  }

  return (
    <aside className="ti-no-select flex h-full w-[240px] shrink-0 flex-col border-r border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-950">
      {/* Header — === wave 8 === bigger, more recognizable Tangerine
          mark. The 5×5 orange square is replaced by a 22×22 rounded
          tile with a typeset T in display serif so the brand reads at
          a glance instead of looking like a randomly placed dot. */}
      <div className="flex items-center justify-between border-b border-stone-200 px-3 py-3 dark:border-stone-800">
        <NavLink to="/memory" className="flex items-center gap-2" aria-label="Memory">
          <div
            data-testid="tangerine-logo"
            className="flex h-[22px] w-[22px] items-center justify-center rounded-md text-[14px] font-semibold text-white shadow-sm"
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
          <span
            className="text-[14px] font-semibold tracking-tight text-[var(--ti-ink-900)] dark:text-[var(--ti-ink-900)]"
            style={{ fontFamily: "var(--ti-font-display)" }}
          >
            Tangerine
          </span>
        </NavLink>
        <button
          type="button"
          onClick={togglePalette}
          className="rounded border border-stone-200 px-1.5 py-0.5 font-mono text-[10px] text-stone-500 hover:bg-stone-100 dark:border-stone-800 dark:text-stone-400 dark:hover:bg-stone-900"
          aria-label="Open command palette"
          title="Search memory"
        >
          {kbdShortcut("k")}
        </button>
      </div>

      {/* Scrollable middle */}
      {/* === wave 4-D i18n === */}
      <div className="flex-1 overflow-y-auto">
        {/* === wave 9 === — AI TOOLS section moves to TOP. Design moat #4
            says AI tools are first-class; visually elevating them above
            Sources is the literal expression of that claim. The header
            picks up the elevated display-serif treatment via `ti-section-elevated`. */}
        <Section
          label={t("sidebar.aiTools")}
          subtitle={t("sidebar.subtitleAITools")}
          collapsible
          expanded={sidebarSections.aiTools}
          onToggle={() => toggleSidebarSection("aiTools")}
          headerStyle="elevated"
        >
          <AIToolsSection />
        </Section>

        {/* VIEWS — primary nav for the Chief of Staff surface */}
        <Section label={t("sidebar.views")} subtitle={t("sidebar.subtitleViews")}>
          <ViewLink to="/today" icon={Calendar} label={t("sidebar.today")} />
          <ViewLink to="/this-week" icon={CalendarRange} label={t("sidebar.thisWeek")} />
          <ViewLink to="/people" icon={Users} label={t("sidebar.people")} />
          <ViewLink to="/projects" icon={FolderKanban} label={t("sidebar.projects")} />
          <ViewLink to="/threads" icon={MessageCircle} label={t("sidebar.threads")} />
          <ViewLink to="/alignment" icon={Activity} label={t("sidebar.alignment")} />
          <ViewLink to="/inbox" icon={Inbox} label={t("sidebar.inbox")} />
          {/* v1.8 Phase 1 — Phase 3 / Phase 4 placeholder surfaces. */}
          <ViewLink to="/canvas" icon={Layers} label={t("sidebar.canvas")} />
          <ViewLink to="/co-thinker" icon={Brain} label={t("sidebar.coThinker")} />
          <ViewLink to="/reviews" icon={GitPullRequest} label={t("sidebar.reviews")} />
          <ViewLink to="/marketplace" icon={Store} label={t("sidebar.marketplace")} />
          <p className="mb-1 mt-3 px-2 text-[10px] uppercase tracking-wide text-stone-400 dark:text-stone-500">
            {t("sidebar.graphs")}
          </p>
          <ViewLink to="/decisions/lineage" icon={Diamond} label={t("sidebar.lineage")} />
          <ViewLink to="/people/social" icon={Network} label={t("sidebar.social")} />
          <ViewLink to="/projects/topology" icon={Workflow} label={t("sidebar.topology")} />
        </Section>

        {/* MEMORY section */}
        <Section label={t("sidebar.memory")} rightHint="">
          <NavLink
            to="/memory"
            end
            className={({ isActive }) =>
              cn(
                "block rounded px-2 py-1 text-[11px] font-mono",
                isActive
                  ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
                  : "text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900",
              )
            }
          >
            ~ /memory
          </NavLink>
          <div className="mt-1">
            <MemoryTree
              tree={tree}
              titles={titles}
              showNewFile
              onNewFile={() => navigate("/memory")}
            />
          </div>
        </Section>

        {/* SOURCES section — === wave 8 === collapsible with count chip. */}
        <Section
          label={t("sidebar.sources")}
          subtitle={t("sidebar.subtitleSources")}
          collapsible
          expanded={sidebarSections.sources}
          onToggle={() => toggleSidebarSection("sources")}
          count={SOURCES.length}
        >
          <ul>
            {SOURCES.map((s) => (
              <li key={s.id}>
                <SourceLink def={s} />
              </li>
            ))}
          </ul>
        </Section>

        <Section
          label={t("sidebar.activeAgents")}
          subtitle={t("sidebar.subtitleActiveAgents")}
          collapsible
          expanded={sidebarSections.activeAgents}
          onToggle={() => toggleSidebarSection("activeAgents")}
        >
          <ActiveAgentsSection />
        </Section>

        <Section
          label={t("sidebar.advanced")}
          subtitle={t("sidebar.subtitleAdvanced")}
          collapsible
          expanded={sidebarSections.advanced}
          onToggle={() => toggleSidebarSection("advanced")}
          count={SINKS.length}
        >
          <ul>
            {SINKS.map((s) => (
              <li key={s.id}>
                <SinkLink def={s} />
              </li>
            ))}
          </ul>
        </Section>
      </div>

      {/* Footer — === wave 8 === subtle warm tint zone groups the
          system controls (sync / settings / theme / sign-out) so the
          eye reads them as a cluster rather than four floating items. */}
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
          className="mt-0.5 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-stone-600 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-900"
        >
          <Lock size={12} className="shrink-0" />
          <span>{t("sidebar.signOut")}</span>
        </button>
      </div>
      {/* === end wave 4-D i18n === */}
    </aside>
  );
}

function Section({
  label,
  children,
  rightHint,
  subtitle,
  collapsible,
  expanded,
  onToggle,
  count,
  headerStyle = "default",
}: {
  label: string;
  children: React.ReactNode;
  rightHint?: string;
  /** Tiny gray one-liner under the section label, used to explain CoS roles. */
  subtitle?: string;
  // === wave 8 === — collapsibility props. When collapsible=true, the
  // header becomes a button that toggles `expanded`. The count chip
  // shows when collapsed so the user knows how many items hide below.
  collapsible?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  count?: number;
  // === wave 9 === — `elevated` swaps the all-caps tracked sans label
  // for the display-serif treatment so the AI Tools section reads as
  // first-class while every other section keeps the prior subtle style.
  headerStyle?: "default" | "elevated";
}) {
  const isExpanded = !collapsible || expanded;
  // === wave 8 === — bumped section header to font-bold (700) from the
  // prior 600 in `.ti-section-label`. The class still anchors tracking
  // and color; we override weight inline to keep the global utility
  // unchanged for non-sidebar use.
  // === wave 9 === — elevated label uses ti-section-elevated (display
  // serif, ti-orange-700, no caps).
  const isElevated = headerStyle === "elevated";
  const headerInner = (
    <>
      <span className="flex items-center gap-1.5">
        {collapsible && (
          isExpanded ? (
            <ChevronDown size={11} className="text-[var(--ti-ink-400)]" />
          ) : (
            <ChevronRight size={11} className="text-[var(--ti-ink-400)]" />
          )
        )}
        {isElevated ? (
          <span className="ti-section-elevated" data-testid="sidebar-section-elevated">
            {label}
          </span>
        ) : (
          <span
            className="ti-section-label"
            style={{ fontWeight: 700 }}
          >
            {label}
          </span>
        )}
        {collapsible && !isExpanded && typeof count === "number" && (
          <span className="font-mono text-[10px] text-[var(--ti-ink-400)]">
            ({count})
          </span>
        )}
      </span>
      {rightHint && (
        <span className="font-mono text-[10px] text-stone-400 dark:text-stone-500">
          {rightHint}
        </span>
      )}
    </>
  );
  // === wave 9 === — elevated section gets a soft warm wash so the AI
  // Tools zone reads as the first-class surface in the rail. Keeps the
  // ordinary border/padding for the default treatment so non-elevated
  // sections look unchanged from wave 8.
  const wrapperClass = isElevated
    ? "ti-zone-warm border-b border-stone-200/60 px-2 py-3 dark:border-stone-800/60"
    : "border-b border-stone-200/60 px-2 py-2.5 dark:border-stone-800/60";
  return (
    <div className={wrapperClass}>
      {collapsible ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isExpanded}
          data-testid={`sidebar-section-${label.toLowerCase().replace(/\s+/g, "-")}`}
          className="mb-1 flex w-full items-center justify-between rounded px-1 py-0.5 text-left transition-colors duration-fast hover:bg-stone-100 dark:hover:bg-stone-900"
        >
          {headerInner}
        </button>
      ) : (
        <div className="mb-1 flex items-center justify-between px-1">
          {headerInner}
        </div>
      )}
      {isExpanded && subtitle && (
        <p className="mb-2 px-1 text-[10px] leading-tight text-stone-400 dark:text-stone-500">
          {subtitle}
        </p>
      )}
      {isExpanded && children}
    </div>
  );
}

function ViewLink({
  to,
  icon: Icon,
  label,
}: {
  to: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          // === wave 8 === — slightly tighter vertical padding (py-0.5)
          // to drop per-row height to ~28px so the dense lower sections
          // don't dominate the rail.
          "flex items-center gap-2 rounded px-2 py-0.5 text-[12px]",
          isActive
            ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
            : "text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900",
        )
      }
    >
      <Icon size={12} className="shrink-0" />
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

function SourceLink({ def }: { def: SourceDef }) {
  const Icon = def.icon;
  return (
    <NavLink
      to={`/sources/${def.id}`}
      className={({ isActive }) =>
        cn(
          // === wave 8 === — slightly tighter vertical padding (py-0.5)
          // to drop per-row height to ~28px so the dense lower sections
          // don't dominate the rail.
          "flex items-center gap-2 rounded px-2 py-0.5 text-[12px]",
          isActive
            ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
            : "text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900",
        )
      }
    >
      <Icon size={12} className="shrink-0" />
      <span className="truncate">{def.title}</span>
      <StatusChip status={def.status} comingIn={def.comingIn} />
    </NavLink>
  );
}

function SinkLink({ def }: { def: SinkDef }) {
  const Icon = def.icon;
  return (
    <NavLink
      to={`/sinks/${def.id}`}
      className={({ isActive }) =>
        cn(
          // === wave 8 === — slightly tighter vertical padding (py-0.5)
          // to drop per-row height to ~28px so the dense lower sections
          // don't dominate the rail.
          "flex items-center gap-2 rounded px-2 py-0.5 text-[12px]",
          isActive
            ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
            : "text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900",
        )
      }
    >
      <Icon size={12} className="shrink-0" />
      <span className="truncate">{def.title}</span>
      <StatusChip status={def.status} comingIn={def.comingIn} />
    </NavLink>
  );
}

// === wave 7 ===
// v1.9.3 honesty pass: the chip used to render green "已连/Connected" for
// any source whose CATALOG status was "active" — even if the user hadn't
// configured a single thing on this machine. That was a lie. Now:
//   - "shipped" → quiet grey "Ready" badge (the page is real, but we make
//                 NO claim about whether it's been wired up — users can
//                 check the source detail page to see real config status)
//   - "beta"    → amber "Beta" badge with tooltip
//   - "coming"  → grey "Coming v1.X" badge
function StatusChip({
  status,
  comingIn,
}: {
  status: SourceStatus | SinkStatus;
  comingIn?: string;
}) {
  const { t } = useTranslation();
  if (status === "shipped") {
    return (
      <span
        className="ml-auto font-mono text-[10px] text-stone-500 dark:text-stone-400"
        title="Setup page is live — open it to wire up your account."
      >
        {t("sidebar.statusReady")}
      </span>
    );
  }
  if (status === "beta") {
    return (
      <span
        className="ml-auto font-mono text-[10px] text-amber-600 dark:text-amber-400"
        title={
          comingIn
            ? `Beta — full release ${comingIn}. Try it; report issues.`
            : "Beta — try it; report issues."
        }
      >
        {t("sidebar.statusBeta")}
      </span>
    );
  }
  // status === "coming"
  return (
    <span
      className="ml-auto font-mono text-[10px] text-stone-400 dark:text-stone-500"
      title={comingIn ? `Coming ${comingIn}` : "Coming soon"}
    >
      {comingIn ?? t("sidebar.statusSoon")}
    </span>
  );
}
// === end wave 7 ===

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
