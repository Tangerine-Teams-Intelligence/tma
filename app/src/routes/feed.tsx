/**
 * v1.16 Wave 2 — /feed Story Feed.
 *
 * Default landing route. Single-column time-ordered atom feed. Replaces
 * the v1.14-era /today aggregation surface (which was widget-heavy and
 * needed the LLM layer to populate "today's brief"). v1.16 design
 * thesis: memory ≠ files, memory = a chronological feed of moments.
 * No AI ranking — pure recency + author + source.
 *
 * Surfaces served:
 *   - Glance (0-3s): "did anything happen / @me?" — first 3 cards visible.
 *   - Triage (3-10s): scan day separator + vendor color + author name.
 *   - Read (10s-1min): click expand inline (short atoms) or drill modal
 *     (long atoms via the AtomCard "Read full" affordance).
 *   - Search/Nav (1+ min): bottom filter chips + Cmd+/ search input.
 *
 * Performance: cold load 100 atoms target < 500ms. Virtualization is
 * deferred to a follow-up wave once we measure real latency on Daizhe's
 * captured corpus — for now we cap to last 500 events at the data
 * layer (`readTimelineRecent(500)`) and rely on React's reconciler for
 * 60fps scroll.
 *
 * R6/R7/R8 honesty: loading + error states are explicit. No fake-green
 * "all clear" — silent zero events and a thrown read are visually
 * distinct (separator + count vs red banner).
 */

import { useEffect, useMemo, useState } from "react";
import {
  readTimelineRecent,
  bucketByDate,
  type TimelineEvent,
  type TangerineNote,
} from "@/lib/views";
import { useStore } from "@/lib/store";
import { AtomCard } from "@/components/feed/AtomCard";
import { DaySeparator } from "@/components/feed/DaySeparator";
import { FilterChips, EMPTY_FILTER, type FeedFilter } from "@/components/feed/FilterChips";
import { TangerineNotes } from "@/components/TangerineNotes";
import { HighlightsRow } from "@/components/feed/HighlightsRow";

const TODAY_CUTOFF_MS = 24 * 60 * 60 * 1000;

export default function FeedRoute() {
  const currentUser = useStore((s) => s.ui.currentUser);
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  const personalAgentsEnabled = useStore((s) => s.ui.personalAgentsEnabled);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [notes, setNotes] = useState<TangerineNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FeedFilter>(EMPTY_FILTER);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    readTimelineRecent(500)
      .then((d) => {
        if (cancel) return;
        setEvents(d.events);
        setNotes(d.notes);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancel) return;
        setLoading(false);
        setError(
          typeof e === "string"
            ? e
            : (e as Error)?.message ?? "Could not read recent timeline.",
        );
      });
    return () => {
      cancel = true;
    };
  }, []);

  const availableSources = useMemo(() => {
    const set = new Set<string>();
    for (const ev of events) {
      const src = (ev.source || "").trim().toLowerCase();
      if (src) set.add(src);
    }
    return [...set].sort();
  }, [events]);

  const filtered = useMemo(() => {
    const cutoffMs = Date.now() - TODAY_CUTOFF_MS;
    const q = filter.query.trim().toLowerCase();
    return events.filter((ev) => {
      if (filter.onlyMe) {
        const actor = (ev.actor || "").toLowerCase();
        if (actor !== currentUser.toLowerCase()) return false;
      }
      if (filter.todayOnly) {
        const ts = Date.parse(ev.ts || "");
        if (Number.isNaN(ts) || ts < cutoffMs) return false;
      }
      if (filter.sources.length > 0) {
        const src = (ev.source || "").trim().toLowerCase();
        if (!filter.sources.includes(src)) return false;
      }
      if (q) {
        const hay = [
          ev.body ?? "",
          ev.actor ?? "",
          ev.kind ?? "",
          ...(ev.concepts ?? []),
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [events, filter, currentUser]);

  const buckets = useMemo(() => bucketByDate(filtered), [filtered]);

  return (
    <div
      data-testid="feed-route"
      className="flex h-full flex-col bg-stone-50 dark:bg-stone-950"
    >
      {/* v1.17 — ViewTabs killed (redundant with Sidebar nav).
          Sidebar's active orange highlight is the single source of truth
          for "which view am I on?" and removing the tab strip cuts ~36px
          of vertical chrome that v1.16 dogfood flagged as bloat. */}
      <main className="flex-1 overflow-y-auto px-3 py-3 md:px-4">
        <div className="mx-auto w-full md:max-w-3xl">
          {notes.length > 0 && <TangerineNotes notes={notes} route="/feed" />}
          {loading && (
            <div
              data-testid="feed-loading"
              className="flex items-center justify-center py-16 text-stone-500"
            >
              <span className="font-mono text-[12px]">Loading captures…</span>
            </div>
          )}
          {error && !loading && (
            <div
              data-testid="feed-error"
              role="alert"
              className="rounded-md border border-rose-300 bg-rose-50 p-4 text-[13px] text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200"
            >
              <div className="font-semibold">Couldn't load captures.</div>
              <div className="mt-1 font-mono text-[11px]">{error}</div>
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <FeedEmptyState
              totalEvents={events.length}
              memoryRoot={memoryRoot}
              personalAgentsEnabled={personalAgentsEnabled}
            />
          )}
          {!loading && !error && buckets.length > 0 && (
            <>
              {/* v1.17 — Apple Photos Memories paradigm. Highlights row
                  hides itself when no atom clears the score threshold,
                  so on a fresh / sparse feed the surface is quiet. */}
              <HighlightsRow events={filtered} currentUser={currentUser} />
              <ol
                data-testid="feed-list"
                data-count={filtered.length}
                className="space-y-2"
              >
                {buckets.map(({ date, events: dayEvents }) => (
                  <li key={date} className="space-y-2">
                    <DaySeparator date={date} />
                    <ul className="space-y-2">
                      {dayEvents.map((ev) => (
                        <li key={ev.id}>
                          <AtomCard event={ev} />
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </main>
      <FilterChips
        filter={filter}
        onChange={setFilter}
        availableSources={availableSources}
      />
    </div>
  );
}

interface FeedEmptyStateProps {
  totalEvents: number;
  memoryRoot?: string;
  personalAgentsEnabled?: Record<string, boolean>;
}

function FeedEmptyState({
  totalEvents,
  memoryRoot,
  personalAgentsEnabled,
}: FeedEmptyStateProps) {
  // Two distinct empty cases — pure empty memory dir vs filtered out
  // every atom. R6/R7/R8 honesty: never collapse them to one message.
  if (totalEvents === 0) {
    // v1.17.5 — empty state was pure-pulse + 2-line copy. Daizhe ("ux太差了")
    // flagged it as dead. New shape: diagnostic 3-row card that names
    // (1) what Tangerine is listening to, (2) where it's reading from,
    // (3) what triggers the first atom. R6 honesty preserved — no fake
    // atoms, no synthetic counters. Just an explicit "here's the
    // contract, this is what you'll see when it fires" so the user can
    // tell on sight whether the daemon is wired right.
    const sources = activeSourceLabels(personalAgentsEnabled ?? {});
    const root = displayMemoryRoot(memoryRoot);
    return (
      <div
        data-testid="feed-empty-no-captures"
        className="mx-auto flex max-w-md flex-col items-stretch gap-4 py-16 text-left"
      >
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--ti-orange-500)]"
          />
          <span className="font-mono text-[10px] uppercase tracking-wider text-stone-500 dark:text-stone-400">
            listening · checking every 30s
          </span>
        </div>
        <h2 className="text-[18px] font-semibold leading-tight text-stone-800 dark:text-stone-100">
          No captures yet.
          <br />
          Open Cursor or Claude Code to write the first one.
        </h2>
        <dl className="mt-1 space-y-2 rounded-md border border-stone-200 bg-white p-3 text-[12px] dark:border-stone-800 dark:bg-stone-900">
          <div className="flex items-baseline gap-2">
            <dt className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-wider text-stone-400">
              watching
            </dt>
            <dd
              data-testid="feed-empty-sources"
              className="min-w-0 flex-1 break-words text-stone-700 dark:text-stone-200"
            >
              {sources.length > 0 ? sources.join(" · ") : (
                <span className="text-amber-600 dark:text-amber-400">
                  no source connected — open Settings
                </span>
              )}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-wider text-stone-400">
              memory dir
            </dt>
            {/* === v1.18.2 R6 fix === When the zustand store hasn't yet
                hydrated `memoryRoot`, displayMemoryRoot returns the
                MEMORY_ROOT_UNRESOLVED sentinel — render an honest amber
                "resolving…" line rather than a fake `~/.tangerine-memory/`
                default. The user can no longer mistake an unhydrated
                store for a confidently-active capture path. */}
            {root === MEMORY_ROOT_UNRESOLVED ? (
              <dd
                data-testid="feed-empty-memory-root"
                data-state="unresolved"
                className="min-w-0 flex-1 break-all font-mono text-[11px] text-amber-600 dark:text-amber-400"
              >
                resolving… (open Settings → Sync to set or verify)
              </dd>
            ) : (
              <dd
                data-testid="feed-empty-memory-root"
                data-state="resolved"
                className="min-w-0 flex-1 break-all font-mono text-[11px] text-stone-600 dark:text-stone-300"
              >
                {root}
              </dd>
            )}
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-wider text-stone-400">
              first atom
            </dt>
            <dd className="min-w-0 flex-1 text-stone-600 dark:text-stone-300">
              your next AI message lands here within a few seconds
            </dd>
          </div>
        </dl>
      </div>
    );
  }
  return (
    <div
      data-testid="feed-empty-filtered"
      className="flex flex-col items-center justify-center py-16 text-center"
    >
      <div className="text-[14px] font-semibold text-stone-700 dark:text-stone-200">
        No captures match the current filter
      </div>
      <p className="mt-2 text-[12px] text-stone-500 dark:text-stone-400">
        Clear the chips at the bottom to see all {totalEvents} captures.
      </p>
    </div>
  );
}

const SOURCE_DISPLAY: Record<string, string> = {
  claude_code: "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  windsurf: "Windsurf",
  devin: "Devin",
  replit: "Replit",
  apple_intelligence: "Apple Intelligence",
  ms_copilot: "Copilot",
};

function activeSourceLabels(map: Record<string, boolean>): string[] {
  return Object.entries(map)
    .filter(([, on]) => on)
    .map(([k]) => SOURCE_DISPLAY[k] ?? k);
}

// === v1.18.2 R6 fix ===
// Pre-fix this returned the literal string "~/.tangerine-memory/" when
// `root` was undefined — i.e. when the zustand store hadn't hydrated
// the memory root yet. That's a fake-default lie: the displayed path
// has no relationship to where Tangerine is actually reading from
// (could be a custom dir, could not be configured at all). Daizhe's
// R6 audit literally called this out: "If `memoryRoot` is undefined
// because the store hasn't hydrated, the row should say so honestly,
// not silently show ~/.tangerine-memory (a default that may not be
// active)." We now return a sentinel the caller renders as a "not
// resolved yet" amber line instead of a confident absolute path.
const MEMORY_ROOT_UNRESOLVED = "__UNRESOLVED__" as const;

function displayMemoryRoot(root: string | undefined): string {
  if (!root) return MEMORY_ROOT_UNRESOLVED;
  // Trim long absolute paths to a leading "~" form when we recognize the
  // home anchor. Keeps the empty-state card from line-wrapping on
  // C:/Users/<long>/Desktop/... paths.
  const norm = root.replace(/\\/g, "/");
  const m = norm.match(/^[A-Za-z]:\/Users\/[^/]+\/(.+)$/);
  if (m) return `~/${m[1]}`;
  if (norm.startsWith("/Users/")) {
    const parts = norm.split("/");
    if (parts.length >= 4) return `~/${parts.slice(3).join("/")}`;
  }
  return norm;
}
