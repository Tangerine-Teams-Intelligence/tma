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
import { useTranslation } from "react-i18next";
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
  // === wave 10 ===
  GitBranch,
  // === end wave 10 ===
} from "lucide-react";
import { signOut } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { searchMemory, type MemorySearchHit } from "@/lib/memory";
import { showInFolder } from "@/lib/tauri";
import { activeLocale, setLocale } from "@/i18n";
import { logEvent } from "@/lib/telemetry";
// === wave 10 === — git auto-sync palette commands.
import { gitSyncPull, gitSyncPush, gitSyncStatus } from "@/lib/tauri";
// === end wave 10 ===
// === wave 11 === — Test LLM channel palette command.
import { setupWizardTestChannel } from "@/lib/tauri";
// === end wave 11 ===
// === wave 15 === — Atom-content full memory search via the new
// `search_atoms` Tauri command. Distinct from `searchMemory` (above):
// that wrapper does a JS-side substring scan on top of `readDir` /
// `readTextFile`, which is fine for small dirs but spends a Tauri
// IPC round-trip per file. `searchAtoms` is the single-shot Rust
// walker with frontmatter parsing + tf-idf scoring + vendor/title
// metadata so we can render colour dots + titles in the palette.
import { searchAtoms, type AtomSearchResult } from "@/lib/tauri";
import { vendorColor } from "@/lib/vendor-colors";
// === end wave 15 ===

interface Props {
  open: boolean;
  onClose: () => void;
}

// === wave 15 === — `atom` extends the union beyond the old `hit` kind
// (which is the legacy MemorySearchHit row from `searchMemory`). Both
// coexist for now: legacy `hit` rows ship the existing JS-side scan,
// new `atom` rows ship the Rust-side scored search with vendor dots
// + frontmatter title. The palette section header for `atom` rows is
// the i18n'd "MEMORY" / "记忆" label.
type ItemKind = "route" | "action" | "hit" | "atom" | "shortcut";
// === end wave 15 ===

interface PaletteItem {
  id: string;
  kind: ItemKind;
  label: string;
  /** Searchable haystack — label + aliases joined. */
  search: string;
  hint?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  onSelect: () => void;
  // === wave 15 === — Optional vendor id for `atom` rows so the
  // renderer can paint a colour dot. Undefined for non-atom rows.
  vendor?: string | null;
  // === end wave 15 ===
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
// === wave 7 ===
// v1.9.3 honesty pass: every entry must lead to a real surface.
//   - Added the missing source routes (notion / loom / zoom / email /
//     voice-notes / external) so Cmd+K can reach them.
//   - Replaced the bogus `/sources/calendar` (the actual route id is
//     `cal`, not `calendar` — the old entry navigated to a 404 →
//     redirect-to-/today).
//   - Added /sinks/{browser,mcp,local-ws} since those are real routes
//     with detail pages.
// === wave 19 === — palette catalog refresh.
//   - /brain entry added as the wave-19 primary alias for /co-thinker;
//     /co-thinker entry kept so legacy bookmarks still type-complete.
//   - Source rows get clearer descriptions ("Connector — wired to memory/...")
//     so users searching "discord" understand they're opening the connector
//     setup, not a chat window.
//   - AI tool rows expanded below get the same treatment via aiTools.map.
//   - All routes that wave 19 yanked from the sidebar (/inbox /alignment
//     /this-week /people /projects /threads /reviews /marketplace /sources
//     /sinks /ai-tools /graphs) MUST stay in this catalog so Cmd+K is the
//     fallback navigation surface.
const ROUTE_CATALOG: RouteEntry[] = [
  { path: "/today", label: "Today", aliases: ["daily", "home", "brief", "dashboard"] },
  { path: "/memory", label: "Memory", aliases: ["files", "tree", "markdown", "vault"] },
  { path: "/brain", label: "Brain", aliases: ["agi", "co-thinker", "thinker", "team brain"] },
  { path: "/co-thinker", label: "Co-thinker (legacy)", aliases: ["agi", "brain", "thinker"] },
  { path: "/canvas", label: "Canvas", aliases: ["board", "stickies"] },
  { path: "/this-week", label: "This Week", aliases: ["weekly", "7 days"] },
  { path: "/reviews", label: "Reviews", aliases: ["meeting reviews", "decisions only"] },
  { path: "/marketplace", label: "Marketplace", aliases: ["shop", "store", "templates"] },
  { path: "/inbox", label: "Inbox", aliases: ["pending", "tasks", "alerts"] },
  { path: "/alignment", label: "Alignment", aliases: ["bars", "team alignment"] },
  { path: "/people", label: "People", aliases: ["team members", "directory"] },
  { path: "/people/social", label: "Social Graph", aliases: ["network", "graph people"] },
  { path: "/projects", label: "Projects", aliases: ["initiatives"] },
  { path: "/projects/topology", label: "Project Topology", aliases: ["graph projects"] },
  { path: "/threads", label: "Threads", aliases: ["topics", "conversations"] },
  { path: "/decisions/lineage", label: "Decision Lineage", aliases: ["graph decisions"] },
  // Sources — every id matches the SourceId catalog in lib/sources.ts.
  // Wave 19 description: every label now leads with "Source · " so the
  // intent (open a connector setup page) is clear at a glance.
  { path: "/sources/discord", label: "Source · Discord", aliases: ["meetings", "discord", "voice"] },
  { path: "/sources/github", label: "Source · GitHub", aliases: ["pr", "issues", "git"] },
  { path: "/sources/linear", label: "Source · Linear", aliases: ["tickets", "issues"] },
  { path: "/sources/slack", label: "Source · Slack", aliases: ["chat", "workspace"] },
  // The route id is `cal` (matching SourceId), not `calendar`.
  { path: "/sources/cal", label: "Source · Calendar", aliases: ["calendar", "events", "gcal"] },
  { path: "/sources/notion", label: "Source · Notion", aliases: ["docs", "wiki"] },
  { path: "/sources/loom", label: "Source · Loom", aliases: ["video", "loom"] },
  { path: "/sources/zoom", label: "Source · Zoom", aliases: ["zoom", "calls"] },
  { path: "/sources/email", label: "Source · Email", aliases: ["imap", "mail", "gmail"] },
  { path: "/sources/voice-notes", label: "Source · Voice notes", aliases: ["voice", "audio", "mic"] },
  { path: "/sources/external", label: "Source · External world", aliases: ["rss", "podcasts", "youtube", "articles"] },
  // Sinks — corresponds to /sinks/:id.
  { path: "/sinks/browser", label: "Sink · Browser extension", aliases: ["chrome", "ext"] },
  { path: "/sinks/mcp", label: "Sink · MCP server", aliases: ["mcp"] },
  { path: "/sinks/local-ws", label: "Sink · Local WS server", aliases: ["websocket", "ws"] },
  { path: "/billing", label: "Billing", aliases: ["subscription", "payment"] },
  { path: "/settings", label: "Settings", aliases: ["preferences", "config"] },
];
// === end wave 19 ===

// v1.9.3 honesty pass: only AI tool IDs that have a real config in
// lib/ai-tools-config.ts. `devin` / `replit` / `apple-intelligence` /
// `ms-copilot` are personal-agent parsers, NOT /ai-tools/* routes — the
// previous palette pointed them at /ai-tools/devin which renders
// "Unknown AI tool: devin" because the AIToolSetupPage falls back when
// the static config is missing.
const AI_TOOL_IDS = [
  "cursor",
  "claude-code",
  "codex",
  "windsurf",
  "claude-ai",
  "chatgpt",
  "gemini",
  "copilot",
  "v0",
  "ollama",
];
// === end wave 7 ===

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
  const { t } = useTranslation();
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  const cycleTheme = useStore((s) => s.ui.cycleTheme);
  const setWelcomed = useStore((s) => s.ui.setWelcomed);
  // === wave 11 === — pull setup wizard open setter + toast push so the
  // "Set up LLM channel" / "Test LLM channel" palette items can dispatch.
  const setSetupWizardOpen = useStore((s) => s.ui.setSetupWizardOpen);
  const pushToast = useStore((s) => s.ui.pushToast);
  // === end wave 11 ===
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MemorySearchHit[]>([]);
  // === wave 15 === — atom-content search state. `atomHits` holds the
  // scored rows from the Rust `search_atoms` command; `atomSearching`
  // gates the inline "Searching memory…" spinner so the user gets
  // immediate feedback before the IPC round-trip resolves.
  const [atomHits, setAtomHits] = useState<AtomSearchResult[]>([]);
  const [atomSearching, setAtomSearching] = useState(false);
  // === end wave 15 ===
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

    // === wave 19 === — AI tool labels keep the "AI Tool · <id>" prefix so
    // a user typing "cursor" / "claude" lands on the per-tool setup page.
    // The hint reads "/ai-tools/<id>" so the destination is unambiguous
    // (these used to live in the sidebar's AI tools section pre-wave-19).
    const aiTools: PaletteItem[] = AI_TOOL_IDS.map((id) => ({
      id: `route:/ai-tools/${id}`,
      kind: "route" as const,
      label: `AI Tool · ${id}`,
      search: `ai-tools ${id} ${id.replace(/-/g, " ")} setup configure`,
      hint: `/ai-tools/${id}`,
      icon: Compass,
      onSelect: () => {
        navigate(`/ai-tools/${id}`);
        close();
      },
    }));
    // === end wave 19 ===

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
      // === wave 11 === — first-run LLM channel setup wizard. Opens the
      // SetupWizard modal directly. Independent of the welcome-tour replay
      // (above) so a returning user can re-run the LLM setup without also
      // re-watching the 4-card welcome overlay.
      {
        id: "action:setup-llm-channel",
        kind: "action",
        label: "Set up LLM channel",
        search: "setup llm channel ai brain wizard mcp ollama configure init",
        hint: "open setup wizard",
        icon: Brain,
        onSelect: () => {
          setSetupWizardOpen(true);
          close();
        },
      },
      // Run the test prompt through session_borrower::dispatch and toast
      // the result. Useful for "did my channel break?" debugging without
      // walking the wizard again.
      {
        id: "action:test-llm-channel",
        kind: "action",
        label: "Test LLM channel",
        search: "test llm channel probe sample prompt borrow check",
        hint: "send test prompt",
        icon: PlayCircle,
        onSelect: async () => {
          close();
          try {
            const r = await setupWizardTestChannel({});
            if (r.ok) {
              pushToast(
                "success",
                `LLM channel OK · ${r.channel_used} · ${r.latency_ms}ms`,
              );
            } else {
              pushToast(
                "error",
                `LLM channel test failed: ${r.error ?? "unknown"}`,
              );
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            pushToast("error", `LLM channel test failed: ${msg}`);
          }
        },
      },
      // === end wave 11 ===
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
      // === wave 10 ===
      // v1.10 git auto-sync palette commands. The "Initialize git tracking"
      // entry is gated by an async lookup of the current status — we don't
      // want to surface "init" when the dir is already a git repo.
      {
        id: "action:git-pull-team",
        kind: "action",
        label: "Pull from team",
        search: "git pull team sync fetch update",
        hint: "git_sync_pull",
        icon: GitBranch,
        onSelect: () => {
          void gitSyncPull();
          close();
        },
      },
      {
        id: "action:git-push-team",
        kind: "action",
        label: "Push to team",
        search: "git push team sync upload share",
        hint: "git_sync_push",
        icon: GitBranch,
        onSelect: () => {
          void gitSyncPush();
          close();
        },
      },
      {
        id: "action:git-history",
        kind: "action",
        label: "Open git history",
        search: "git history log commits sidebar popover",
        hint: "open the sidebar popover",
        icon: GitBranch,
        onSelect: () => {
          // No dedicated route — surface a hint via the click-bubble
          // mechanism the GitSyncIndicator listens for.
          window.dispatchEvent(new Event("tangerine:git-sync-popover-open"));
          close();
        },
      },
      {
        id: "action:git-init",
        kind: "action",
        label: "Initialize git tracking",
        search: "git init initialize tracking memory dir setup",
        hint: "memory dir → git",
        icon: GitBranch,
        onSelect: async () => {
          // Best-effort: if status says we're already initialized, skip.
          const cur = await gitSyncStatus();
          if (cur.git_initialized) {
            close();
            return;
          }
          window.dispatchEvent(new Event("tangerine:git-init-banner-open"));
          close();
        },
      },
      // === end wave 10 ===
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
  }, [
    navigate,
    onClose,
    cycleTheme,
    setWelcomed,
    memoryRoot,
    // === wave 11 === — new deps for setup-wizard palette items.
    setSetupWizardOpen,
    pushToast,
    // === end wave 11 ===
  ]);

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

  // === wave 15 === — Atom-content search via the Rust `search_atoms`
  // walker. Threshold is 3 chars: shorter queries match too many
  // atoms (e.g. "the" hits everything) AND each query is one Rust
  // walker pass over up to MAX_FILES files, so the threshold also
  // protects p95 latency when the user is typing quickly. We measure
  // wall-clock latency around the IPC and emit the
  // `palette_memory_search` telemetry event so the suggestion engine
  // can flag pathological dirs.
  const ATOM_SEARCH_MIN_CHARS = 3;
  useEffect(() => {
    const q = query.trim();
    if (q.length < ATOM_SEARCH_MIN_CHARS) {
      setAtomHits([]);
      setAtomSearching(false);
      return;
    }
    let cancelled = false;
    setAtomSearching(true);
    const t0 = performance.now();
    void searchAtoms({ query: q, limit: 10 })
      .then((rows) => {
        if (cancelled) return;
        const dt = Math.round(performance.now() - t0);
        setAtomHits(rows);
        setAtomSearching(false);
        void logEvent("palette_memory_search", {
          query: q,
          result_count: rows.length,
          latency_ms: dt,
        });
      })
      .catch(() => {
        if (cancelled) return;
        // safeInvoke already swallows IPC errors and falls back to
        // []; this catch is here purely so the spinner clears even
        // if the Promise rejects through some other path.
        setAtomHits([]);
        setAtomSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);
  // === end wave 15 ===

  // Reset on open + telemetry.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHits([]);
      // === wave 15 === — also clear the atom-content hits + spinner
      // so the palette opens to a clean state (no stale rows from a
      // previous session).
      setAtomHits([]);
      setAtomSearching(false);
      // === end wave 15 ===
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
    // === wave 15 === — Scored atom rows from `search_atoms`. We
    // dedupe against the legacy `searchMemory` rows (matched by
    // path) so a file that shows up in both scans only renders
    // once, with the atom row taking precedence (it has the
    // frontmatter title + vendor decoration).
    const atomItems: PaletteItem[] = atomHits.map((a, i) => ({
      id: `atom:${i}:${a.path}`,
      kind: "atom" as const,
      label: a.title || t("palette.search.untitled"),
      search: `${a.title} ${a.path} ${a.snippet}`,
      hint: a.snippet,
      icon: FileText,
      vendor: a.vendor,
      onSelect: () => {
        navigate(`/memory/${a.path}`);
        onClose();
      },
    }));
    const atomPaths = new Set(atomHits.map((a) => a.path));
    const dedupedMemoryItems = memoryItems.filter((m) => {
      // Memory items use `id` like `hit:<i>:<path>`. Strip the
      // prefix to recover the rel-path for the dedupe check.
      const path = m.id.replace(/^hit:\d+:/, "");
      return !atomPaths.has(path);
    });
    return [...ranked, ...atomItems, ...dedupedMemoryItems];
    // === end wave 15 ===
  }, [staticItems, hits, atomHits, query, navigate, onClose, t]);

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
    // === wave 19 === — "navigate" → "pages" (matches Linear / Notion
    // command-palette idiom; users now think of routes as named pages,
    // not navigation actions).
    if (k === "route") return "pages";
    // === end wave 19 ===
    if (k === "action") return "actions";
    if (k === "hit") return "memory";
    // === wave 15 === — Scored atom rows live under the i18n'd
    // "MEMORY" / "记忆" header so the section is recognisable in
    // both EN and ZH locales.
    if (k === "atom") return t("palette.search.sectionLabel");
    // === end wave 15 ===
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
              // === wave 15 === — Always show the section header at
              // a kind boundary, even when the user is typing. The
              // old rule (`!showHits`) suppressed all headers during
              // an active query, which made it impossible to tell
              // which rows came from the memory walker vs. routes /
              // actions / shortcuts. With atom rows in the mix the
              // grouping becomes load-bearing.
              const showHeader =
                idx === 0 || (prev && prev.kind !== it.kind);
              // === end wave 15 ===
              return (
                <div key={it.id}>
                  {showHeader && (
                    <div
                      className="ti-no-select px-4 pt-2 pb-1 text-[10px] uppercase tracking-wide text-stone-500 dark:text-stone-500"
                      data-testid={`command-palette-section-${it.kind}`}
                    >
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
                    {/* === wave 15 === — vendor colour dot on atom
                        rows. Falls through to the lucide icon for
                        every other kind so the layout doesn't
                        shift. Uses inline style (vs. a data-vendor
                        CSS selector) so unknown vendors get the
                        default-grey fallback from `vendorColor`. */}
                    {it.kind === "atom" ? (
                      <span
                        data-testid="command-palette-vendor-dot"
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: vendorColor(it.vendor).hex }}
                        aria-hidden
                      />
                    ) : (
                      <Icon size={16} className="shrink-0" />
                    )}
                    {/* === end wave 15 === */}
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
          {/* === wave 15 === — Inline status row for the atom-content
              search. Renders below whatever route / action / atom rows
              are already showing so the user always sees the static
              palette items first and the memory-search progress as a
              secondary signal. */}
          {query.trim().length >= ATOM_SEARCH_MIN_CHARS && atomSearching && (
            <div
              data-testid="command-palette-memory-searching"
              className="ti-no-select px-4 py-2 text-[11px] italic text-stone-500 dark:text-stone-400"
            >
              {t("palette.search.searching")}
            </div>
          )}
          {query.trim().length >= ATOM_SEARCH_MIN_CHARS &&
            !atomSearching &&
            atomHits.length === 0 && (
              <div
                data-testid="command-palette-memory-empty"
                className="ti-no-select px-4 py-2 text-[11px] italic text-stone-500 dark:text-stone-400"
              >
                {t("palette.search.noResults")}
              </div>
            )}
          {/* === end wave 15 === */}
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
