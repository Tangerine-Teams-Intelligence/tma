/**
 * Cmd+K / Ctrl+K command palette — keyboard-first launcher.
 *
 * Wave 5-β rewrite: previously this was a memory-search-first palette.
 * It is now a multi-source launcher with three indexed item kinds:
 *   1. Routes — every navigable surface in the app (catalog below).
 *   2. Quick actions — discrete commands (init brain, switch language,
 *      replay welcome tour, open memory dir in OS file manager).
 *   3. Memory hits — substring matches against the markdown corpus.
 *      These show up below routes/actions when the query is non-empty.
 *
 * Mounted at AppShell so Cmd+K works from any route. Esc closes it.
 * ↑/↓ navigate, Enter selects.
 *
 * Hand-rolled — no `cmdk` dependency. Fuzzy match is a substring +
 * word-boundary scorer; no Levenshtein, no fuse.js. Good enough for
 * tens-to-low-hundreds of items.
 *
 * Telemetry: emits `palette_open` (when shown) and `palette_select`
 * (with the chosen item's id) so the suggestion engine can detect
 * "user keeps Cmd+K-ing /memory → maybe sidebar isn't discoverable".
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Settings,
  Lock,
  Search,
  Sun,
  FileText,
  Compass,
  Zap,
  Brain,
  Languages,
  FolderOpen,
  PlayCircle,
} from "lucide-react";
import { signOut } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { searchMemory, type MemorySearchHit } from "@/lib/memory";
import { showInFolder } from "@/lib/tauri";
import { activeLocale, setLocale } from "@/i18n";
import { logEvent } from "@/lib/telemetry";

interface Props {
  open: boolean;
  onClose: () => void;
}

type ItemKind = "route" | "action" | "hit" | "shortcut";

interface PaletteItem {
  id: string;
  kind: ItemKind;
  label: string;
  /** Searchable haystack — label + aliases joined. */
  search: string;
  hint?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  onSelect: () => void;
}

// ---------- catalog ----------

/**
 * Canonical route catalog. Hardcoded because there is no central route
 * registry — `App.tsx` declares <Route> nodes one-by-one. Aliases let
 * the user type natural words ("daily", "tasks") to find the surface.
 *
 * Per-tool ai-tools/{id} entries are expanded below from
 * `AI_TOOLS_CONFIG` so we don't duplicate the catalog.
 */
interface RouteEntry {
  path: string;
  label: string;
  aliases?: string[];
}
const ROUTE_CATALOG: RouteEntry[] = [
  { path: "/today", label: "Today", aliases: ["daily", "home", "brief"] },
  { path: "/this-week", label: "This Week", aliases: ["weekly", "7 days"] },
  { path: "/memory", label: "Memory", aliases: ["files", "tree", "markdown"] },
  { path: "/co-thinker", label: "Co-thinker", aliases: ["agi", "brain", "thinker"] },
  { path: "/canvas", label: "Canvas", aliases: ["board", "stickies"] },
  { path: "/reviews", label: "Reviews", aliases: ["meeting reviews"] },
  { path: "/marketplace", label: "Marketplace", aliases: ["shop", "store"] },
  { path: "/inbox", label: "Inbox", aliases: ["pending", "tasks"] },
  { path: "/alignment", label: "Alignment", aliases: ["bars", "team alignment"] },
  { path: "/people", label: "People", aliases: ["team members", "directory"] },
  { path: "/people/social", label: "Social Graph", aliases: ["network", "graph people"] },
  { path: "/projects", label: "Projects", aliases: ["initiatives"] },
  { path: "/projects/topology", label: "Project Topology", aliases: ["graph projects"] },
  { path: "/threads", label: "Threads", aliases: ["topics", "conversations"] },
  { path: "/decisions/lineage", label: "Decision Lineage", aliases: ["graph decisions"] },
  { path: "/sources/discord", label: "Discord Source", aliases: ["meetings", "discord"] },
  { path: "/sources/github", label: "GitHub Source", aliases: ["pr", "issues"] },
  { path: "/sources/linear", label: "Linear Source", aliases: ["tickets"] },
  { path: "/sources/slack", label: "Slack Source", aliases: ["chat"] },
  { path: "/sources/calendar", label: "Calendar Source", aliases: ["events"] },
  { path: "/billing", label: "Billing", aliases: ["subscription", "payment"] },
  { path: "/settings", label: "Settings", aliases: ["preferences", "config"] },
];

const AI_TOOL_IDS = [
  "cursor",
  "claude-code",
  "codex",
  "windsurf",
  "devin",
  "replit",
  "apple-intelligence",
  "ms-copilot",
  "chatgpt",
  "ollama",
];

/**
 * Custom DOM event the /co-thinker route listens for to auto-trigger
 * the first heartbeat. Dispatched from the "Initialize co-thinker
 * brain" palette action. The route page picks it up and calls
 * `coThinkerTriggerHeartbeat` on mount when the flag is present.
 *
 * Mounted as a window event rather than route-state so the dispatch
 * survives the navigation tick and lands after CoThinkerRoute's
 * effect chain.
 */
export const CO_THINKER_INIT_EVENT = "tangerine:co-thinker-init";

/**
 * Custom DOM event for the welcome-tour replay. Anything that wants to
 * re-show the WelcomeOverlay (Settings button, palette command) calls
 * `setWelcomed(false)` directly — the overlay is a pure prop reader.
 * The constant is exported in case future surfaces want a one-line
 * trigger.
 */
export const WELCOME_REPLAY_EVENT = "tangerine:welcome-replay";

/** Score a candidate against the query. Higher = better. 0 = no match. */
function score(haystack: string, q: string): number {
  if (!q) return 1; // everything matches when query is blank
  const h = haystack.toLowerCase();
  const needle = q.toLowerCase();
  const idx = h.indexOf(needle);
  if (idx < 0) {
    // Word-boundary match: every needle char appears in order, prefer
    // matches that hit at the start of a word.
    let pos = 0;
    let last = -1;
    let inOrderHits = 0;
    for (const ch of needle) {
      const next = h.indexOf(ch, pos);
      if (next < 0) return 0;
      if (last >= 0 && next === last + 1) inOrderHits += 1;
      last = next;
      pos = next + 1;
    }
    return 1 + inOrderHits;
  }
  // Exact substring: prefix match scores highest.
  if (idx === 0) return 100;
  // Word-start boundary: previous char is non-alpha.
  const prev = h[idx - 1];
  if (prev && !/[a-z0-9]/.test(prev)) return 80;
  return 60 - Math.min(50, idx);
}

export function CommandPalette({ open, onClose }: Props) {
  const navigate = useNavigate();
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  const cycleTheme = useStore((s) => s.ui.cycleTheme);
  const setWelcomed = useStore((s) => s.ui.setWelcomed);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MemorySearchHit[]>([]);
  const [active, setActive] = useState(0);

  // Build the static (route + action) item list once per open. Memory
  // hits are merged on top whenever the user types a non-empty query.
  const staticItems: PaletteItem[] = useMemo(() => {
    const close = onClose;

    const routes: PaletteItem[] = ROUTE_CATALOG.map((r) => ({
      id: `route:${r.path}`,
      kind: "route" as const,
      label: r.label,
      search: [r.label, r.path, ...(r.aliases ?? [])].join(" "),
      hint: r.path,
      icon: Compass,
      onSelect: () => {
        navigate(r.path);
        close();
      },
    }));

    const aiTools: PaletteItem[] = AI_TOOL_IDS.map((id) => ({
      id: `route:/ai-tools/${id}`,
      kind: "route" as const,
      label: `AI Tool · ${id}`,
      search: `ai-tools ${id} ${id.replace(/-/g, " ")}`,
      hint: `/ai-tools/${id}`,
      icon: Compass,
      onSelect: () => {
        navigate(`/ai-tools/${id}`);
        close();
      },
    }));

    const actions: PaletteItem[] = [
      {
        id: "action:init-co-thinker",
        kind: "action",
        label: "Initialize co-thinker brain",
        search: "initialize co-thinker brain agi heartbeat init start",
        hint: "trigger first heartbeat",
        icon: Brain,
        onSelect: () => {
          navigate("/co-thinker");
          // Defer one tick so the route's effect chain is mounted
          // before we dispatch — otherwise the listener isn't there.
          window.setTimeout(() => {
            window.dispatchEvent(new Event(CO_THINKER_INIT_EVENT));
          }, 50);
          close();
        },
      },
      {
        id: "action:welcome-replay",
        kind: "action",
        label: "Run welcome tour",
        search: "welcome tour replay onboarding intro show again",
        hint: "re-show overlay",
        icon: PlayCircle,
        onSelect: () => {
          // Resetting `welcomed` causes the WelcomeOverlay to re-mount
          // on the current route. No navigation needed.
          setWelcomed(false);
          window.dispatchEvent(new Event(WELCOME_REPLAY_EVENT));
          close();
        },
      },
      {
        id: "action:open-memory-dir",
        kind: "action",
        label: "Open memory dir in file system",
        search: "open memory dir folder file system explorer finder co-thinker md",
        hint: memoryRoot,
        icon: FolderOpen,
        onSelect: () => {
          void showInFolder(memoryRoot);
          close();
        },
      },
      {
        id: "action:switch-language",
        kind: "action",
        label: "Switch language EN ↔ ZH",
        search: "language switch english chinese 中文 i18n locale",
        hint: activeLocale() === "zh" ? "中文 → English" : "English → 中文",
        icon: Languages,
        onSelect: () => {
          const next = activeLocale() === "zh" ? "en" : "zh";
          void setLocale(next);
          close();
        },
      },
      {
        id: "shortcut:settings",
        kind: "shortcut",
        label: "Settings",
        search: "settings preferences config",
        hint: "Cmd/Ctrl+,",
        icon: Settings,
        onSelect: () => {
          navigate("/settings");
          close();
        },
      },
      {
        id: "shortcut:theme",
        kind: "shortcut",
        label: "Cycle theme",
        search: "theme dark light system color cycle",
        hint: "system → light → dark",
        icon: Sun,
        onSelect: () => {
          cycleTheme();
          close();
        },
      },
      {
        id: "shortcut:signout",
        kind: "shortcut",
        label: "Sign out",
        search: "sign out log out lock",
        hint: "Lock local memory",
        icon: Lock,
        onSelect: async () => {
          await signOut();
          navigate("/auth", { replace: true });
          close();
        },
      },
    ];

    return [...actions, ...routes, ...aiTools];
  }, [navigate, onClose, cycleTheme, setWelcomed, memoryRoot]);

  // Run memory search whenever the query changes (debounced via the
  // effect's natural batching).
  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    void searchMemory(memoryRoot, query).then((rows) => {
      if (!cancelled) setHits(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [memoryRoot, query]);

  // Reset on open + telemetry.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHits([]);
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
      void logEvent("palette_open", {});
    }
  }, [open]);

  // Filter + rank static items. Memory hits append below.
  const items: PaletteItem[] = useMemo(() => {
    const q = query.trim();
    const ranked = staticItems
      .map((it) => ({ it, s: score(it.search, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.it);

    if (!q) return ranked;

    const memoryItems: PaletteItem[] = hits.map((h, i) => ({
      id: `hit:${i}:${h.path}`,
      kind: "hit" as const,
      label: h.path,
      search: h.path,
      hint: h.snippet,
      icon: FileText,
      onSelect: () => {
        navigate(`/memory/${h.path}`);
        onClose();
      },
    }));
    return [...ranked, ...memoryItems];
  }, [staticItems, hits, query, navigate, onClose]);

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[active];
      if (it) {
        void logEvent("palette_select", { id: it.id, kind: it.kind });
        it.onSelect();
      }
    }
  }

  const showHits = query.trim().length > 0;

  // Group items by kind for the section dividers when no query is typed.
  // When the user is searching, we keep ranked order — no grouping.
  function kindLabel(k: ItemKind): string {
    if (k === "route") return "navigate";
    if (k === "action") return "actions";
    if (k === "hit") return "memory";
    return "shortcuts";
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-sm animate-fade-in"
      onClick={onClose}
      data-testid="command-palette"
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl border border-stone-200 bg-stone-50 shadow-2xl dark:border-stone-800 dark:bg-stone-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
          <Search size={16} className="text-stone-500 dark:text-stone-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a route, action, or query…"
            className="flex-1 bg-transparent text-sm text-stone-900 placeholder-stone-500 focus:outline-none dark:text-stone-100 dark:placeholder-stone-400"
            spellCheck={false}
            autoComplete="off"
            data-testid="command-palette-input"
          />
          <kbd className="hidden rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] text-stone-500 sm:inline dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400">
            Esc
          </kbd>
        </div>

        <div className="max-h-[50vh] overflow-auto py-1" data-testid="command-palette-list">
          {items.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-stone-500 dark:text-stone-400">
              <p>No matches.</p>
              <p className="mt-2 text-[11px] italic">
                Try a route name (e.g. "today"), an action (e.g. "init"), or a
                memory search term.
              </p>
            </div>
          ) : (
            items.map((it, idx) => {
              const Icon = it.icon;
              const isActive = idx === active;
              const prev = items[idx - 1];
              const showHeader =
                !showHits && (idx === 0 || (prev && prev.kind !== it.kind));
              return (
                <div key={it.id}>
                  {showHeader && (
                    <div className="ti-no-select px-4 pt-2 pb-1 text-[10px] uppercase tracking-wide text-stone-500 dark:text-stone-500">
                      {kindLabel(it.kind)}
                    </div>
                  )}
                  <button
                    type="button"
                    data-testid={`command-palette-item-${it.id}`}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => {
                      void logEvent("palette_select", { id: it.id, kind: it.kind });
                      it.onSelect();
                    }}
                    className={
                      "flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors duration-fast " +
                      (isActive
                        ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
                        : "text-stone-900 hover:bg-stone-100 dark:text-stone-100 dark:hover:bg-stone-800")
                    }
                  >
                    <Icon size={16} className="shrink-0" />
                    <span className="flex-1 truncate font-mono text-[12px]">{it.label}</span>
                    {it.hint && (
                      <span className="truncate text-[11px] text-stone-500 dark:text-stone-400">
                        {it.hint}
                      </span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="ti-no-select flex items-center justify-between border-t border-stone-200 bg-stone-100 px-4 py-2 text-[10px] text-stone-500 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-400">
          <span>
            <kbd className="font-mono">↑↓</kbd> navigate ·{" "}
            <kbd className="font-mono">Enter</kbd> open ·{" "}
            <kbd className="font-mono">?</kbd> for shortcuts
          </span>
          <span className="flex items-center gap-1">
            <Zap size={10} />
            <span>{items.length}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
