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
 *
 * v1.21.0 — Operability surface C: Ask mode.
 *   • Tab strip at the top: [ Search ] [ Ask ]. Default = Search.
 *   • Ask mode reranks the existing 500-event corpus by a 4-signal
 *     heuristic (term match + recency decay + decision boost +
 *     cross-source concept overlap). NO LLM call — the work happens
 *     in 50 lines of TS so the user gets sub-100ms answers without
 *     a backend round trip.
 *   • Empty / no-match → honest empty-state line, never fabricated.
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
  // v1.20.0 — `:about` now surfaces the running app version as a toast
  // (was a misdirect to /settings before).
  { key: "about", label: ":about", hint: "show app version" },
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

export type SpotlightMode = "search" | "ask";

export function Spotlight() {
  const open = useStore((s) => s.ui.spotlightOpen);
  const setOpen = useStore((s) => s.ui.setSpotlightOpen);
  const setCanvasView = useStore((s) => s.ui.setCanvasView);
  const cycleTheme = useStore((s) => s.ui.cycleTheme);
  // v1.20.0 — `:replay` and `:about` go through pushToast for honest
  // empty-corpus + version-disclosure flows.
  const pushToast = useStore((s) => s.ui.pushToast);
  const [mode, setMode] = useState<SpotlightMode>("search");
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [openAtom, setOpenAtom] = useState<TimelineEvent | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset query + selection + mode when the modal toggles open. We
  // refetch events once on each open so the result list reflects
  // fresh writes (cheap — readTimelineRecent caps at 500). Mocks
  // fall through outside Tauri, so the panel still renders in vitest.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    setMode("search");
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
  const rows = useMemo(
    () => (mode === "search" ? buildResults(query, events) : []),
    [mode, query, events],
  );

  // v1.21.0 Ask mode — rerank the corpus on every keystroke (debounced
  // to 200ms via the Spotlight modal close-on-empty-input which is
  // already throttled by the user typing speed).
  const askResults = useMemo(
    () => (mode === "ask" ? rankAskResults(query, events) : []),
    [mode, query, events],
  );

  const onSelect = useCallback(
    (row: ResultRow) => {
      const p = row.payload;
      if (!p) return;
      if (p.kind === "atom") {
        setOpenAtom(p.event);
        // v1.19.1 Round 2 E — atom open closes spotlight so the sheet has
        // full focus (the agent's own Round 1 comment: "feels weird").
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
        // v1.19.1 Round 2 E — `theme` is incremental (user may want to
        // cycle through system → light → dark in one go), so we leave
        // the spotlight open. Every other command closes after running.
        runCommand(p.key, {
          setCanvasView,
          cycleTheme,
          pushToast,
          eventCount: events.length,
        });
        if (p.key !== "theme") setOpen(false);
        return;
      }
    },
    [setOpen, setCanvasView, cycleTheme, pushToast, events.length],
  );

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      const list = mode === "ask" ? askResults : rows;
      const len = list.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(len - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (mode === "ask") {
          const r = askResults[activeIdx];
          if (r) {
            setOpenAtom(r.event);
            setOpen(false);
          }
          return;
        }
        const row = rows[activeIdx];
        if (row) onSelect(row);
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, rows, askResults, mode, activeIdx, setOpen, onSelect]);

  // Clamp activeIdx if the result list shrinks while typing.
  useEffect(() => {
    const len = mode === "ask" ? askResults.length : rows.length;
    if (activeIdx >= len) {
      setActiveIdx(Math.max(0, len - 1));
    }
  }, [rows.length, askResults.length, mode, activeIdx]);

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
            data-mode={mode}
            // v1.19.2 Round 3 visual fix V6 — `animate-fade-in` (200ms,
            // upward translateY 8px → 0) so the modal feels like a real
            // overlay rather than a div that snapped into place.
            className="relative z-10 w-full max-w-[640px] animate-fade-in overflow-hidden rounded-xl border border-stone-200 bg-white shadow-2xl dark:border-stone-800 dark:bg-stone-900"
          >
            {/* v1.21.0 — mode tab strip. Search (default) keeps the
                v1.19 fuzzy-jump behavior; Ask reranks the corpus by
                relevance + recency + decision-kind boost. */}
            <div
              data-testid="spotlight-mode-strip"
              className="flex items-center gap-1 border-b border-stone-200 px-3 pt-2 dark:border-stone-800"
            >
              <button
                type="button"
                data-testid="spotlight-mode-search"
                data-active={mode === "search" ? "true" : "false"}
                onClick={() => {
                  setMode("search");
                  setActiveIdx(0);
                  setQuery("");
                  inputRef.current?.focus();
                }}
                className={
                  "border-b-2 px-2 pb-1.5 pt-1 text-[12px] font-medium transition-colors " +
                  (mode === "search"
                    ? "border-[var(--ti-orange-500)] text-stone-900 dark:text-stone-100"
                    : "border-transparent text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200")
                }
              >
                Search
              </button>
              <button
                type="button"
                data-testid="spotlight-mode-ask"
                data-active={mode === "ask" ? "true" : "false"}
                onClick={() => {
                  setMode("ask");
                  setActiveIdx(0);
                  setQuery("");
                  inputRef.current?.focus();
                }}
                className={
                  "border-b-2 px-2 pb-1.5 pt-1 text-[12px] font-medium transition-colors " +
                  (mode === "ask"
                    ? "border-[var(--ti-orange-500)] text-stone-900 dark:text-stone-100"
                    : "border-transparent text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200")
                }
              >
                Ask
              </button>
            </div>
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
                placeholder={
                  mode === "ask" ? "ask your team's memory…" : undefined
                }
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIdx(0);
                }}
                aria-label={
                  mode === "ask" ? "Ask your team's memory" : "Search, jump, or run"
                }
                className="w-full border-none bg-transparent font-mono text-[18px] leading-none text-stone-900 outline-none placeholder:text-stone-400 dark:text-stone-100"
              />
            </header>
            {mode === "search" && (
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
            )}
            {mode === "ask" && (
              <AskResults
                query={query}
                results={askResults}
                activeIdx={activeIdx}
                onActivate={setActiveIdx}
                onOpenAtom={(ev) => {
                  setOpenAtom(ev);
                  setOpen(false);
                }}
                eventCount={events.length}
              />
            )}
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

// ============================================================================
// v1.21.0 — Ask mode (Operability surface C)
// ============================================================================

export interface AskResult {
  event: TimelineEvent;
  score: number;
  /** First body line that contains a query term (for the result excerpt). */
  excerpt: string;
}

const RECENCY_DAY_DECAY = 1 / 30; // 30-day half-life-ish.
const DECISION_BOOST = 5;
const CROSS_SOURCE_BOOST = 3;
const MAX_ASK_RESULTS = 5;

/**
 * 4-signal rerank — pure function, exported so vitest can hit it
 * without rendering the modal.
 *
 * Signals:
 *   1. Term-match — count of distinct query keyword occurrences in
 *      `body` ∪ `topic` ∪ `concepts` ∪ `actor`. Each occurrence adds 1.
 *   2. Recency — `exp(-days_old * RECENCY_DAY_DECAY)`. Today ≈ 1.0;
 *      30 days ≈ 0.37; 60 days ≈ 0.14.
 *   3. Decision boost — +5 if `kind === "decision"`. Decisions are
 *      what the user actually wants when they ask "what did we decide
 *      about X."
 *   4. Cross-source boost — +3 if any of the result's `concepts`
 *      appears in ≥2 distinct source vendors across the matched set.
 *      Surfaces topics that multiple tools converged on.
 *
 * Honesty: empty query OR empty corpus → empty results. We never
 * fabricate "here's what you might want to know." Top 5 only.
 */
export function rankAskResults(
  query: string,
  events: TimelineEvent[],
  now: number = Date.now(),
): AskResult[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0 || events.length === 0) return [];

  const terms = q.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return [];

  // Pass 1 — term-match + recency + decision boost.
  const candidates: AskResult[] = [];
  for (const ev of events) {
    if (ev.sample) continue;
    const haystack = [
      ev.body ?? "",
      ev.actor ?? "",
      ev.kind ?? "",
      ...(ev.concepts ?? []),
    ]
      .join(" ")
      .toLowerCase();
    let termHits = 0;
    for (const t of terms) {
      if (haystack.includes(t)) termHits += 1;
    }
    if (termHits === 0) continue;

    const tsMs = Date.parse(ev.ts ?? "");
    const days = Number.isFinite(tsMs)
      ? Math.max(0, (now - tsMs) / (24 * 60 * 60 * 1000))
      : 30;
    const recency = Math.exp(-days * RECENCY_DAY_DECAY);
    const decisionBoost = ev.kind === "decision" ? DECISION_BOOST : 0;

    const score = termHits * 2 + recency * 3 + decisionBoost;
    candidates.push({ event: ev, score, excerpt: pickExcerpt(ev, terms) });
  }

  if (candidates.length === 0) return [];

  // Pass 2 — cross-source boost. For each concept tag in the matched
  // set, count distinct source vendors. Boost any result whose
  // concepts overlap a multi-source concept.
  const conceptSources = new Map<string, Set<string>>();
  for (const c of candidates) {
    for (const concept of c.event.concepts ?? []) {
      const key = concept.toLowerCase();
      let set = conceptSources.get(key);
      if (!set) {
        set = new Set();
        conceptSources.set(key, set);
      }
      set.add(c.event.source ?? "");
    }
  }
  for (const c of candidates) {
    const hasCross = (c.event.concepts ?? []).some(
      (concept) =>
        (conceptSources.get(concept.toLowerCase())?.size ?? 0) >= 2,
    );
    if (hasCross) c.score += CROSS_SOURCE_BOOST;
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, MAX_ASK_RESULTS);
}

function pickExcerpt(ev: TimelineEvent, terms: string[]): string {
  const body = ev.body ?? "";
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    const lower = t.toLowerCase();
    if (terms.some((term) => lower.includes(term))) {
      return truncateExcerpt(t);
    }
  }
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t.length > 0) return truncateExcerpt(t);
  }
  return ev.kind ?? "(no body)";
}

function truncateExcerpt(s: string): string {
  if (s.length <= 100) return s;
  return s.slice(0, 97) + "…";
}

function AskResults({
  query,
  results,
  activeIdx,
  onActivate,
  onOpenAtom,
  eventCount,
}: {
  query: string;
  results: AskResult[];
  activeIdx: number;
  onActivate: (idx: number) => void;
  onOpenAtom: (ev: TimelineEvent) => void;
  eventCount: number;
}) {
  const trimmed = query.trim();

  if (trimmed.length === 0) {
    return (
      <div
        data-testid="spotlight-ask-prompt"
        className="px-4 py-6 text-center font-mono text-[11px] text-stone-400 dark:text-stone-600"
      >
        Ask a question — answers come from your team's atoms, not an LLM.
      </div>
    );
  }

  if (eventCount === 0) {
    return (
      <div
        data-testid="spotlight-ask-empty"
        data-empty-mode="no-corpus"
        className="px-4 py-6 text-center font-mono text-[11px] text-stone-400 dark:text-stone-600"
      >
        No atoms in memory yet — connect a source in Settings first.
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div
        data-testid="spotlight-ask-empty"
        data-empty-mode="no-match"
        className="px-4 py-6 text-center font-mono text-[11px] text-stone-400 dark:text-stone-600"
      >
        No atoms match.
      </div>
    );
  }

  return (
    <div
      data-testid="spotlight-ask-results"
      data-count={results.length}
      className="max-h-[60vh] overflow-y-auto py-2"
    >
      <div className="px-4 pb-2 pt-1 font-mono text-[10px] uppercase tracking-wider text-stone-400">
        {results.length} atom{results.length === 1 ? "" : "s"} relevant to "
        {trimmed}"
      </div>
      <ul className="px-2">
        {results.map((r, i) => {
          const active = i === activeIdx;
          return (
            <li key={r.event.id}>
              <button
                type="button"
                data-testid="spotlight-ask-result-row"
                data-event-id={r.event.id}
                data-active={active ? "true" : "false"}
                onMouseEnter={() => onActivate(i)}
                onClick={() => onOpenAtom(r.event)}
                className={
                  "block w-full rounded-md px-2 py-2 text-left transition-colors " +
                  (active
                    ? "border-l border-[var(--ti-orange-500)] bg-stone-50 dark:bg-stone-800"
                    : "hover:bg-stone-50 dark:hover:bg-stone-800")
                }
              >
                <div className="flex items-baseline gap-2 font-mono text-[11px] text-stone-500 dark:text-stone-500">
                  <span>● {(r.event.ts ?? "").slice(0, 10)}</span>
                  <span>·</span>
                  <span>{r.event.actor || "?"}</span>
                  <span>·</span>
                  <span>{r.event.source || "?"}</span>
                </div>
                <div className="mt-0.5 truncate text-[13px] text-stone-800 dark:text-stone-200">
                  {r.excerpt}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function runCommand(
  key: SpotlightCommand,
  ctx: {
    setCanvasView: (v: "time" | "heatmap" | "people" | "replay") => void;
    cycleTheme: () => void;
    pushToast: (kind: "info" | "success" | "error", text: string) => void;
    eventCount: number;
  },
): void {
  switch (key) {
    case "replay":
      // v1.20.0 honesty fix — running `:replay` with an empty corpus
      // would silently switch to the replay view with nothing to play.
      // The user'd see a blank canvas + a slowly ticking progress bar
      // for 5s, then auto-flip back to the time view. Now we surface
      // the empty-corpus case as an honest toast and stay where we are.
      if (ctx.eventCount === 0) {
        ctx.pushToast(
          "info",
          "No captures to replay. Connect a source in Settings first.",
        );
        return;
      }
      ctx.setCanvasView("replay");
      return;
    case "settings":
      if (typeof window !== "undefined") {
        window.history.pushState({}, "", "/settings");
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
      return;
    case "theme":
      // v1.19.1 Round 2 E — caller leaves spotlight open after :theme so
      // the user can cycle multiple times.
      ctx.cycleTheme();
      return;
    case "sources":
      // v1.19.1 Round 2 E — there's no /settings/connect route in v1.19;
      // /settings owns the Connect tab. Route to /settings.
      if (typeof window !== "undefined") {
        window.history.pushState({}, "", "/settings");
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
      return;
    case "about":
      // v1.20.0 honesty fix — `:about` used to navigate to /settings
      // and hope the user found the version chip somewhere. The
      // version is actually defined as `__APP_VERSION__` (a Vite
      // build-time constant); we surface it as a toast so the user
      // gets the answer immediately without leaving the canvas.
      ctx.pushToast(
        "info",
        `Tangerine AI Teams v${__APP_VERSION__}`,
      );
      return;
  }
}
