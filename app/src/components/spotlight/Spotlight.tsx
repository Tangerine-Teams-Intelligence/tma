/**
 * v1.19.0 Round 1 — Spotlight (Cmd+K everything).
 *
 * Modal overlay. Triggered by Cmd+K (or Ctrl+K on Windows / Linux).
 * ESC closes. The Spotlight is the single first-class navigation surface
 * in v1.19's modeless redesign — sidebars are second-class, banners are
 * dead, status chips live in the spotlight instead of a global bar.
 *
 * UI shape:
 *   • Big mono input at top (auto-focus). No placeholder text — just a
 *     small ⌘ hint icon. Filter syntax:
 *       - `<plain text>` → fuzzy match across recent atoms / people /
 *         threads / commands
 *       - `@<alias>`     → filter to atoms by that actor
 *       - `#<concept>`   → filter to atoms with that concept tag
 *       - `:<command>`   → only commands
 *   • Result groups underneath. Recent atoms / People / Threads /
 *     Commands. Each shows the top 8 entries by recency / activity.
 *     Arrow keys navigate the flat result list across groups; Enter
 *     selects; ESC closes.
 *   • Selection actions:
 *       - atom    → opens AtomBottomSheet
 *       - person  → filters the main canvas to that actor
 *       - thread  → filters the main canvas to that thread
 *       - command → runs the command
 *
 * State lives entirely inside this component (input string, hover idx).
 * The open / closed boolean lives in the zustand UI slice so the
 * keybind handler at AppShell scope can flip it without prop drilling.
 *
 * Round-1 punts:
 *   • No backend wiring for the result groups; all sourced from
 *     `readTimelineRecent(500)` (the same call /feed makes). People
 *     and threads are derived from atom actors / refs.
 *   • No fuzzy library; we use plain `String.includes`. Round 2 may
 *     add fuse.js if Daizhe complains.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { readTimelineRecent, type TimelineEvent } from "@/lib/views";
import { useStore } from "@/lib/store";
import { AtomBottomSheet } from "@/components/feed/AtomBottomSheet";

export type SpotlightCommand =
  | "replay"
  | "settings"
  | "theme"
  | "sources"
  | "about";

export interface SpotlightCommandSpec {
  key: SpotlightCommand;
  label: string;
  hint: string;
}

const COMMANDS: SpotlightCommandSpec[] = [
  { key: "replay", label: ":replay", hint: "play canvas timelapse" },
  { key: "settings", label: ":settings", hint: "open Settings" },
  { key: "theme", label: ":theme", hint: "cycle theme" },
  { key: "sources", label: ":sources", hint: "list connected sources" },
  { key: "about", label: ":about", hint: "Tangerine v" },
];

interface ResultRow {
  group: "recent" | "people" | "threads" | "commands";
  id: string;
  primary: string;
  secondary: string;
  payload?:
    | { kind: "atom"; event: TimelineEvent }
    | { kind: "person"; alias: string }
    | { kind: "thread"; topic: string }
    | { kind: "command"; key: SpotlightCommand };
}

export function Spotlight() {
  const open = useStore((s) => s.ui.spotlightOpen);
  const setOpen = useStore((s) => s.ui.setSpotlightOpen);
  const setCanvasView = useStore((s) => s.ui.setCanvasView);
  const cycleTheme = useStore((s) => s.ui.cycleTheme);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [openAtom, setOpenAtom] = useState<TimelineEvent | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset query + selection when the modal toggles open. We refetch
  // events once on each open so the result list reflects fresh writes
  // (cheap — readTimelineRecent caps at 500). Mocks fall through outside
  // Tauri, so the panel still renders in vitest.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    let cancel = false;
    readTimelineRecent(500)
      .then((d) => {
        if (cancel) return;
        setEvents(d.events);
      })
      .catch(() => {
        if (cancel) return;
        setEvents([]);
      });
    return () => {
      cancel = true;
    };
  }, [open]);

  // Auto-focus the input on open. The microtask delay lets the modal
  // mount + transition before we steal focus.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  // ESC + arrow keys + Enter handlers. Mounted only while open so we
  // don't intercept ESC on the rest of the app.
  const rows = useMemo(() => buildResults(query, events), [query, events]);

  const onSelect = useCallback(
    (row: ResultRow) => {
      const p = row.payload;
      if (!p) return;
      if (p.kind === "atom") {
        setOpenAtom(p.event);
        // Keep the spotlight open behind the bottom sheet feels weird —
        // close it so the sheet has full focus.
        setOpen(false);
        return;
      }
      if (p.kind === "person") {
        // Round-1 simplification: all "filter to person" actions just
        // switch the canvas to People view. The People view itself
        // surfaces per-actor atom lists.
        setCanvasView("people");
        setOpen(false);
        return;
      }
      if (p.kind === "thread") {
        // Round-1 simplification: thread filter routes to time view
        // since threads don't have a dedicated canvas mode yet.
        setCanvasView("time");
        setOpen(false);
        return;
      }
      if (p.kind === "command") {
        runCommand(p.key, { setCanvasView, cycleTheme });
        setOpen(false);
        return;
      }
    },
    [setOpen, setCanvasView, cycleTheme],
  );

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(rows.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const row = rows[activeIdx];
        if (row) onSelect(row);
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, rows, activeIdx, setOpen, onSelect]);

  // Clamp activeIdx if the result list shrinks while typing.
  useEffect(() => {
    if (activeIdx >= rows.length) {
      setActiveIdx(Math.max(0, rows.length - 1));
    }
  }, [rows.length, activeIdx]);

  return (
    <>
      <AtomBottomSheet event={openAtom} onClose={() => setOpenAtom(null)} />
      {open && (
        <div
          data-testid="spotlight"
          role="dialog"
          aria-modal="true"
          aria-label="Spotlight"
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[14vh]"
        >
          <button
            type="button"
            aria-label="Close spotlight"
            data-testid="spotlight-backdrop"
            onClick={() => setOpen(false)}
            className="absolute inset-0 cursor-default"
          />
          <section
            data-testid="spotlight-panel"
            className="relative z-10 w-full max-w-[640px] overflow-hidden rounded-xl border border-stone-200 bg-white shadow-2xl dark:border-stone-800 dark:bg-stone-900"
          >
            <header className="flex items-center gap-3 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
              <Search
                size={16}
                aria-hidden
                className="shrink-0 text-stone-400"
              />
              <input
                ref={inputRef}
                data-testid="spotlight-input"
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIdx(0);
                }}
                aria-label="Search, jump, or run"
                className="w-full border-none bg-transparent font-mono text-[18px] leading-none text-stone-900 outline-none placeholder:text-stone-400 dark:text-stone-100"
              />
            </header>
            <div
              data-testid="spotlight-results"
              data-count={rows.length}
              className="max-h-[60vh] overflow-y-auto py-2"
            >
              {rows.length === 0 && (
                <div
                  data-testid="spotlight-empty"
                  className="px-4 py-8 text-center font-mono text-[12px] text-stone-400"
                >
                  no matches
                </div>
              )}
              {renderGroups(rows, activeIdx, onSelect, setActiveIdx)}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function renderGroups(
  rows: ResultRow[],
  activeIdx: number,
  onSelect: (r: ResultRow) => void,
  setActiveIdx: (i: number) => void,
) {
  const groupOrder: ResultRow["group"][] = [
    "recent",
    "people",
    "threads",
    "commands",
  ];
  const groupLabel: Record<ResultRow["group"], string> = {
    recent: "Recent",
    people: "People",
    threads: "Threads",
    commands: "Commands",
  };
  const blocks = [];
  let flatIdx = 0;
  for (const g of groupOrder) {
    const groupRows = rows.filter((r) => r.group === g);
    if (groupRows.length === 0) continue;
    const startIdx = rows.findIndex((r) => r === groupRows[0]);
    blocks.push(
      <div key={g} data-testid={`spotlight-group-${g}`} className="px-2">
        <div className="px-2 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-stone-400">
          {groupLabel[g]}
        </div>
        <ul>
          {groupRows.map((row, i) => {
            const fi = startIdx + i;
            flatIdx = fi;
            const active = activeIdx === fi;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  data-testid="spotlight-result"
                  data-row-id={row.id}
                  data-active={active ? "true" : "false"}
                  onMouseEnter={() => setActiveIdx(fi)}
                  onClick={() => onSelect(row)}
                  className={
                    "flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left transition-colors " +
                    (active
                      ? "border-l border-[var(--ti-orange-500)] bg-stone-50 dark:bg-stone-800"
                      : "hover:bg-stone-50 dark:hover:bg-stone-800")
                  }
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] text-stone-900 dark:text-stone-100">
                    {row.primary}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-stone-500 dark:text-stone-400">
                    {row.secondary}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>,
    );
  }
  void flatIdx;
  return blocks;
}

/**
 * Build the flat result list from the query + atom corpus.
 *
 * Filtering rules:
 *   - leading `:` → only the Commands group, fuzzy-matched on label.
 *   - leading `@` → only the People group, fuzzy-matched on alias.
 *   - leading `#` → only Recent atoms whose concepts include the tag.
 *   - otherwise   → fuzzy match across all four groups; empty query
 *                   surfaces the top 8 of each group by recency.
 */
export function buildResults(
  query: string,
  events: TimelineEvent[],
): ResultRow[] {
  const q = query.trim().toLowerCase();
  const isCommand = q.startsWith(":");
  const isPerson = q.startsWith("@");
  const isConcept = q.startsWith("#");
  const stripped = isCommand || isPerson || isConcept ? q.slice(1) : q;

  const out: ResultRow[] = [];

  if (isCommand) {
    for (const c of COMMANDS) {
      if (!stripped || c.label.toLowerCase().includes(stripped) || c.hint.toLowerCase().includes(stripped)) {
        out.push({
          group: "commands",
          id: `cmd-${c.key}`,
          primary: c.label,
          secondary: c.hint,
          payload: { kind: "command", key: c.key },
        });
      }
    }
    return out;
  }

  // Recent atoms.
  const sortedAtoms = [...events].sort((a, b) =>
    (b.ts ?? "").localeCompare(a.ts ?? ""),
  );

  if (isPerson) {
    const aliases = uniqueActors(events);
    for (const alias of aliases) {
      if (!stripped || alias.toLowerCase().includes(stripped)) {
        const last24 = sortedAtoms.filter(
          (e) =>
            (e.actor ?? "").toLowerCase() === alias.toLowerCase() &&
            Date.now() - Date.parse(e.ts ?? "") < 24 * 60 * 60 * 1000,
        ).length;
        out.push({
          group: "people",
          id: `person-${alias}`,
          primary: `@${alias}`,
          secondary: `${last24} atoms last 24h`,
          payload: { kind: "person", alias },
        });
      }
    }
    return out.slice(0, 16);
  }

  if (isConcept) {
    for (const ev of sortedAtoms) {
      if (
        !stripped ||
        (ev.concepts ?? []).some((c) => c.toLowerCase().includes(stripped))
      ) {
        out.push({
          group: "recent",
          id: ev.id,
          primary: bodyPreview(ev),
          secondary: clockOf(ev.ts),
          payload: { kind: "atom", event: ev },
        });
      }
      if (out.length >= 16) break;
    }
    return out;
  }

  // Plain query → 4 groups.
  // 1. Recent atoms — top 8 (or filtered by stripped text)
  let recentTaken = 0;
  for (const ev of sortedAtoms) {
    const hay = [ev.body ?? "", ev.actor ?? "", ...(ev.concepts ?? [])]
      .join(" ")
      .toLowerCase();
    if (!stripped || hay.includes(stripped)) {
      out.push({
        group: "recent",
        id: ev.id,
        primary: bodyPreview(ev),
        secondary: clockOf(ev.ts),
        payload: { kind: "atom", event: ev },
      });
      recentTaken += 1;
      if (recentTaken >= 8) break;
    }
  }
  // 2. People — top 8 by recency.
  const aliases = uniqueActors(events).slice(0, 8);
  for (const alias of aliases) {
    if (stripped && !alias.toLowerCase().includes(stripped)) continue;
    const last24 = sortedAtoms.filter(
      (e) =>
        (e.actor ?? "").toLowerCase() === alias.toLowerCase() &&
        Date.now() - Date.parse(e.ts ?? "") < 24 * 60 * 60 * 1000,
    ).length;
    out.push({
      group: "people",
      id: `person-${alias}`,
      primary: `@${alias}`,
      secondary: `${last24} atoms last 24h`,
      payload: { kind: "person", alias },
    });
  }
  // 3. Threads — derive from atom refs.
  const threads = uniqueThreads(events).slice(0, 8);
  for (const t of threads) {
    if (stripped && !t.topic.toLowerCase().includes(stripped)) continue;
    out.push({
      group: "threads",
      id: `thread-${t.topic}`,
      primary: `${t.topic}`,
      secondary: `${t.atomCount} atoms · ${formatLatest(t.latestTs)}`,
      payload: { kind: "thread", topic: t.topic },
    });
  }
  // 4. Commands — always show all 5 unless query strips them.
  for (const c of COMMANDS) {
    if (
      stripped &&
      !c.label.toLowerCase().includes(stripped) &&
      !c.hint.toLowerCase().includes(stripped)
    ) {
      continue;
    }
    out.push({
      group: "commands",
      id: `cmd-${c.key}`,
      primary: c.label,
      secondary: c.hint,
      payload: { kind: "command", key: c.key },
    });
  }
  return out;
}

function uniqueActors(events: TimelineEvent[]): string[] {
  const seen = new Map<string, number>(); // alias → most recent ts ms
  for (const ev of events) {
    const a = (ev.actor ?? "").trim();
    if (!a) continue;
    const ts = Date.parse(ev.ts ?? "");
    const prev = seen.get(a);
    if (prev === undefined || (Number.isFinite(ts) && ts > prev)) {
      seen.set(a, Number.isFinite(ts) ? ts : 0);
    }
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([alias]) => alias);
}

interface ThreadAgg {
  topic: string;
  atomCount: number;
  latestTs: string | null;
}

function uniqueThreads(events: TimelineEvent[]): ThreadAgg[] {
  const map = new Map<string, ThreadAgg>();
  for (const ev of events) {
    const refs = (ev.refs ?? {}) as { threads?: string[] };
    for (const t of refs.threads ?? []) {
      let entry = map.get(t);
      if (!entry) {
        entry = { topic: t, atomCount: 0, latestTs: null };
        map.set(t, entry);
      }
      entry.atomCount += 1;
      if (!entry.latestTs || (ev.ts ?? "") > entry.latestTs) {
        entry.latestTs = ev.ts ?? entry.latestTs;
      }
    }
  }
  return [...map.values()].sort((a, b) => {
    const at = Date.parse(a.latestTs ?? "");
    const bt = Date.parse(b.latestTs ?? "");
    return bt - at;
  });
}

function bodyPreview(ev: TimelineEvent): string {
  const body = (ev.body ?? "").split("\n")[0]?.trim() ?? "";
  if (body.length > 0) return body;
  return ev.kind ?? "(no body)";
}

function clockOf(iso: string | null | undefined): string {
  if (!iso) return "??:??";
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return "??:??";
  return `${m[1]}:${m[2]}`;
}

function formatLatest(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 60 * 60) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 60 * 60 * 24) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / (60 * 60 * 24))}d ago`;
}

function runCommand(
  key: SpotlightCommand,
  ctx: {
    setCanvasView: (v: "time" | "heatmap" | "people" | "replay") => void;
    cycleTheme: () => void;
  },
): void {
  switch (key) {
    case "replay":
      ctx.setCanvasView("replay");
      return;
    case "settings":
      if (typeof window !== "undefined") {
        window.history.pushState({}, "", "/settings");
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
      return;
    case "theme":
      ctx.cycleTheme();
      return;
    case "sources":
      if (typeof window !== "undefined") {
        window.history.pushState({}, "", "/settings");
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
      return;
    case "about":
      if (typeof window !== "undefined") {
        window.history.pushState({}, "", "/whats-new-app");
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
      return;
  }
}
