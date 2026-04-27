/**
 * Wave 5-β help registry.
 *
 * One file, one source of truth. The HelpPanel reads `helpFor(routePath)`
 * and renders title + body + shortcuts. Routes without an explicit entry
 * fall back to a generic "page about <name>" derived from the path.
 *
 * Why a registry instead of 12 markdown files: most pages need ~3 lines
 * of explanation; a per-page file is overkill. When a page genuinely
 * needs paragraphs (Co-thinker walkthrough, Canvas mechanics) we'll
 * promote that one entry to a `body` that's a multi-line string.
 *
 * Authoring rules:
 *   - Keep `title` under 40 chars. Shows in the panel header.
 *   - Keep `body` under 600 chars. The panel is a popover, not a docs
 *     site. If a page needs more, link to `docs/<page>.md` from the body.
 *   - List `shortcuts` as `{ keys: "Cmd+K", label: "..." }`. The panel
 *     renders them as a compact 2-col table.
 *
 * Coordination with Wave 5-α: this registry is owned by Wave 5-β.
 * Wave 5-α's progressive-disclosure work for Settings happens inside
 * `pages/settings/*` and does not touch `help/`.
 */

export interface HelpShortcut {
  /** Display string. "Cmd+K" / "?" / "Esc". */
  keys: string;
  /** What the shortcut does on this page. */
  label: string;
}

export interface HelpEntry {
  title: string;
  body: string;
  shortcuts?: HelpShortcut[];
}

/**
 * Global shortcuts that work on every route. The HelpPanel concats
 * these with per-route shortcuts so the user always sees the full
 * picture without us re-listing them in every entry.
 */
export const GLOBAL_SHORTCUTS: HelpShortcut[] = [
  { keys: "Cmd/Ctrl+K", label: "Open command palette" },
  { keys: "?", label: "Open this help / shortcuts overlay" },
  { keys: "Esc", label: "Close any modal or overlay" },
  { keys: "Cmd/Ctrl+,", label: "Jump to Settings" },
];

/**
 * Per-route help entries. Only the most-used routes are filled in;
 * everything else falls back to `genericHelp(path)`.
 */
const REGISTRY: Record<string, HelpEntry> = {
  "/today": {
    title: "Today",
    body: "Your daily brief. Top of the page is the alignment bar (what the team agreed on yesterday) followed by an atom timeline of every recent event across your sources. Use this as your morning standup surface — open Tangerine, read the brief, decide what matters today.",
    shortcuts: [
      { keys: "j / k", label: "Move between timeline items" },
    ],
  },
  "/co-thinker": {
    title: "Co-thinker",
    body: "Your team's persistent AGI brain, stored as a markdown file at `~/.tangerine-memory/agi/co-thinker.md`. The brain re-reads atoms every 5 minutes via your primary AI tool (Cursor / Claude / ChatGPT). Edit the doc to steer; the AGI honours your edits on the next heartbeat. Use 'Initialize' on an empty brain to fire the first heartbeat.",
    shortcuts: [
      { keys: "Cmd/Ctrl+E", label: "Toggle edit mode" },
      { keys: "Cmd/Ctrl+S", label: "Save brain edits" },
    ],
  },
  "/canvas": {
    title: "Canvas",
    body: "A persistent whiteboard per project. Throw stickies, the AGI throws stickies back. When two stickies conflict, the AGI proposes a lock — clicking through pins the decision into a memory atom. Look for the 🍊 dot to see AGI-authored stickies; click 'View AGI reasoning' to jump to the brain entry that produced it.",
    shortcuts: [
      { keys: "Double-click", label: "New sticky at cursor" },
      { keys: "Drag", label: "Reposition sticky" },
    ],
  },
  "/memory": {
    title: "Memory",
    body: "The file tree. Every source writes markdown atoms here; everything Tangerine knows is on disk under `~/.tangerine-memory/`. Click a file to read it, edit it in your favourite editor, or open the folder in Finder/Explorer. This is the single source of truth — even the AGI brain is just a file.",
    shortcuts: [
      { keys: "Click file", label: "Preview in viewer" },
      { keys: "Open in OS", label: "Reveal in Finder/Explorer" },
    ],
  },
  "/ai-tools": {
    title: "AI Tools",
    body: "We borrow your existing AI subscription instead of charging for our own. Pick one as your primary tool (the ⭐ in the sidebar) — every co-thinker heartbeat will route through it. Cursor / Claude Code / Codex / Windsurf use MCP; ChatGPT / Claude.ai use a browser extension; Devin / Replit use HTTP. Per-tool setup pages walk you through wiring each one.",
  },
  "/settings": {
    title: "Settings",
    body: "Tabbed config. General has language + log level; AGI has the sensitivity slider that controls how often the brain surfaces in your UI; Personal Agents toggles per-source capture into your private vault. The 'Replay welcome tour' button lives in General — use it if you want to see the 4-card intro again.",
  },
  "/inbox": {
    title: "Inbox",
    body: "Pending decisions surfaced from your sources. Each row is a question waiting on a human. Click through to the source atom (the Linear ticket / Discord thread / GitHub PR) where it originated. Resolving an inbox item writes a decision atom that the co-thinker brain will pick up on its next heartbeat.",
  },
  "/alignment": {
    title: "Alignment",
    body: "How aligned the team is on each open question. The bars are computed from atom voting — a long bar means everyone agrees; a short / split bar means there's still discussion. Click a bar to see the source atoms that contributed.",
  },
};

/**
 * Auto-derive a sensible title from a route path. `/projects/topology`
 * → "Project Topology". Used as the fallback when there's no entry in
 * REGISTRY.
 */
function titleFromPath(path: string): string {
  const tail = path.split("/").filter(Boolean).pop() ?? "Page";
  return tail
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Strip dynamic params (`/people/:alias` → `/people`) so we can match
 * generic help entries even when the user is on a detail route.
 *
 * Also collapses two-segment lookup chains: `/sources/discord` exists
 * as a route entry, but `/sources/notion/setup` should fall back to
 * the `/sources/*` family for the title.
 */
function normalizePath(path: string): string {
  // Drop trailing dynamic segments (param-like `:foo` won't appear in
  // the live URL, but slugs and ids will). We try the full path first
  // and progressively drop tail segments.
  return path.replace(/\/$/, "") || "/";
}

/**
 * Resolve the help entry for a given route. Tries an exact match, then
 * progressively shorter prefixes (so `/people/eric` falls back to the
 * `/people` entry — or, lacking that, a generic). Always returns
 * something — the panel never shows "no help" copy.
 */
export function helpFor(routePath: string): HelpEntry {
  const normalized = normalizePath(routePath);
  if (REGISTRY[normalized]) return REGISTRY[normalized];

  // Walk up the path, stopping at "/".
  const segments = normalized.split("/").filter(Boolean);
  while (segments.length > 0) {
    segments.pop();
    const prefix = "/" + segments.join("/");
    if (REGISTRY[prefix]) return REGISTRY[prefix];
  }

  // Final fallback — derive from the path.
  return {
    title: titleFromPath(routePath),
    body: `This is the ${titleFromPath(routePath)} page. We haven't written specific help copy for it yet — but every Tangerine surface follows the same rules: every interaction is captured as a memory atom on disk, and the AGI re-reads those atoms on each heartbeat. Use Cmd+K to navigate, ? for keyboard shortcuts.`,
  };
}

/**
 * The list of routes the registry has explicit copy for. Useful for
 * tests + analytics ("how many routes have authored help?").
 */
export const AUTHORED_ROUTES = Object.keys(REGISTRY);
