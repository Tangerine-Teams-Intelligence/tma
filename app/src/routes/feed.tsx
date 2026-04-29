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
import { ViewTabs } from "@/components/layout/ViewTabs";
import { AtomCard } from "@/components/feed/AtomCard";
import { DaySeparator } from "@/components/feed/DaySeparator";
import { FilterChips, EMPTY_FILTER, type FeedFilter } from "@/components/feed/FilterChips";
import { TangerineNotes } from "@/components/TangerineNotes";

const TODAY_CUTOFF_MS = 24 * 60 * 60 * 1000;

export default function FeedRoute() {
  const currentUser = useStore((s) => s.ui.currentUser);
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
      <ViewTabs />
      <main className="flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto max-w-3xl">
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
            <FeedEmptyState totalEvents={events.length} />
          )}
          {!loading && !error && buckets.length > 0 && (
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

function FeedEmptyState({ totalEvents }: { totalEvents: number }) {
  // Two distinct empty cases — pure empty memory dir vs filtered out
  // every atom. R6/R7/R8 honesty: never collapse them to one message.
  if (totalEvents === 0) {
    return (
      <div
        data-testid="feed-empty-no-captures"
        className="flex flex-col items-center justify-center py-16 text-center"
      >
        <div className="text-[14px] font-semibold text-stone-700 dark:text-stone-200">
          No captures yet
        </div>
        <p className="mt-2 max-w-md text-[12px] text-stone-500 dark:text-stone-400">
          Tangerine reads your AI-tool conversation logs as you use them. Open
          Cursor or Claude Code and your next message will appear here within
          a minute.
        </p>
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
