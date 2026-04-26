import { useEffect, useState } from "react";
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
import { kbdShortcut } from "@/lib/platform";

/**
 * Always-visible left rail (~240px). Two sections:
 *
 *   MEMORY    — file tree of the user's memory dir.
 *   SOURCES   — connectors that write to memory.
 *   SINKS     — consumers that read from memory.
 *
 * Bottom: settings, theme toggle, lock, Cmd+K hint.
 */
export function Sidebar() {
  const navigate = useNavigate();
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  const samplesSeeded = useStore((s) => s.ui.samplesSeeded);
  const togglePalette = useStore((s) => s.ui.togglePalette);
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
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
    }
    return () => {
      cancel = true;
      cancelled = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
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
      {/* Header */}
      <div className="flex items-center justify-between border-b border-stone-200 px-3 py-3 dark:border-stone-800">
        <NavLink to="/memory" className="flex items-center gap-2" aria-label="Memory">
          <div
            className="h-5 w-5 rounded"
            style={{ background: "var(--ti-orange-500)" }}
            aria-hidden
          />
          <span className="text-[13px] font-medium tracking-tight text-stone-900 dark:text-stone-100">
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
      <div className="flex-1 overflow-y-auto">
        {/* VIEWS — primary nav for the Chief of Staff surface */}
        <Section label="Views" subtitle="Today / week / people / projects">
          <ViewLink to="/today" icon={Calendar} label="Today" />
          <ViewLink to="/this-week" icon={CalendarRange} label="This week" />
          <ViewLink to="/people" icon={Users} label="People" />
          <ViewLink to="/projects" icon={FolderKanban} label="Projects" />
          <ViewLink to="/threads" icon={MessageCircle} label="Threads" />
          <ViewLink to="/alignment" icon={Activity} label="Alignment" />
          <ViewLink to="/inbox" icon={Inbox} label="Inbox" />
        </Section>

        {/* MEMORY section */}
        <Section label="Memory" rightHint="">
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

        {/* SOURCES section */}
        <Section label="Sources" subtitle="Where team comms come in">
          <ul>
            {SOURCES.map((s) => (
              <li key={s.id}>
                <SourceLink def={s} />
              </li>
            ))}
          </ul>
        </Section>

        {/* SINKS section */}
        <Section label="Sinks" subtitle="Where team + their AI read out">
          <ul>
            {SINKS.map((s) => (
              <li key={s.id}>
                <SinkLink def={s} />
              </li>
            ))}
          </ul>
        </Section>
      </div>

      {/* Footer */}
      <div className="border-t border-stone-200 px-2 py-2 dark:border-stone-800">
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
          <span>Settings</span>
        </NavLink>
        <ThemeToggle />
        <button
          type="button"
          onClick={handleLock}
          className="mt-0.5 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-stone-600 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-900"
        >
          <Lock size={12} className="shrink-0" />
          <span>Sign out</span>
        </button>
      </div>
    </aside>
  );
}

function Section({
  label,
  children,
  rightHint,
  subtitle,
}: {
  label: string;
  children: React.ReactNode;
  rightHint?: string;
  /** Tiny gray one-liner under the section label, used to explain CoS roles. */
  subtitle?: string;
}) {
  return (
    <div className="border-b border-stone-200/60 px-2 py-3 dark:border-stone-800/60">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="ti-section-label">{label}</span>
        {rightHint && (
          <span className="font-mono text-[10px] text-stone-400 dark:text-stone-500">
            {rightHint}
          </span>
        )}
      </div>
      {subtitle && (
        <p className="mb-2 px-1 text-[10px] leading-tight text-stone-400 dark:text-stone-500">
          {subtitle}
        </p>
      )}
      {children}
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
          "flex items-center gap-2 rounded px-2 py-1 text-[12px]",
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
          "flex items-center gap-2 rounded px-2 py-1 text-[12px]",
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
          "flex items-center gap-2 rounded px-2 py-1 text-[12px]",
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

function StatusChip({
  status,
  comingIn,
}: {
  status: SourceStatus | SinkStatus;
  comingIn?: string;
}) {
  if (status === "active") {
    return (
      <span className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] text-emerald-600 dark:text-emerald-400">
        <span className="ti-live-dot h-1.5 w-1.5" />
        on
      </span>
    );
  }
  if (status === "disconnected") {
    return (
      <span className="ml-auto font-mono text-[10px] text-rose-600 dark:text-rose-400">
        off
      </span>
    );
  }
  return (
    <span
      className="ml-auto font-mono text-[10px] text-stone-400 dark:text-stone-500"
      title={comingIn ? `Coming ${comingIn}` : "Coming soon"}
    >
      {comingIn ?? "soon"}
    </span>
  );
}

function ThemeToggle() {
  const theme = useStore((s) => s.ui.theme);
  const cycle = useStore((s) => s.ui.cycleTheme);
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const label = theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System";
  return (
    <button
      type="button"
      onClick={cycle}
      className="mt-0.5 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-stone-600 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-900"
      title="Cycle theme: system → light → dark"
    >
      <Icon size={12} className="shrink-0" />
      <span>Theme</span>
      <span className="ml-auto font-mono text-[10px] text-stone-400 dark:text-stone-500">
        {label}
      </span>
    </button>
  );
}
