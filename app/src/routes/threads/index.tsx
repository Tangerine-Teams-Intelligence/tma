/**
 * v1.16 Wave 2 Agent B2 — /threads route.
 *
 * Threads are derived from each atom body's @mention set. Atoms sharing
 * the exact same set of mentions belong to the same thread. The atom
 * with no mentions falls into an "Uncategorized" bucket. No LLM, no
 * smart layer — pure regex match against atom body.
 *
 * R6/R7/R8 honesty:
 *   - Loading: explicit "Reading captures…" text + data-testid
 *   - Error: red banner with the underlying message + retry button
 *   - Empty (0 atoms): one message
 *   - Empty (atoms exist but every one is Uncategorized after filter):
 *     a different message (handled by search filter)
 *   - Never paint silent zero
 *
 * Surfaces: glance the title list, click a card → AtomCard list expands
 * inline. Search box filters by mention name (lowercase substring).
 */

import { useEffect, useMemo, useState } from "react";
import { MessageCircle, AlertCircle, Search } from "lucide-react";
import {
  readTimelineRecent,
  type TimelineEvent,
  type TangerineNote,
} from "@/lib/views";
import { ViewTabs } from "@/components/layout/ViewTabs";
import { ThreadCard, type Thread } from "@/components/threads/ThreadCard";
import { TangerineNotes } from "@/components/TangerineNotes";
import { EmptyStateAnimation } from "@/components/onboarding/EmptyStateAnimation";

/** Body text matches `@<word>` for at-mention detection. Mirrors the
 *  regex used in AtomCard.tsx + mention_extractor.rs. */
const MENTION_RE = /@([a-z0-9][a-z0-9_.-]*)/gi;

export default function ThreadsListRoute() {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [notes, setNotes] = useState<TangerineNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [query, setQuery] = useState("");

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
  }, [refreshKey]);

  const threads = useMemo(() => groupByMentionSet(events), [events]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter(
      (t) =>
        t.mentions.some((m) => m.includes(q)) ||
        t.title.toLowerCase().includes(q),
    );
  }, [threads, query]);

  return (
    <div
      data-testid="threads-route"
      className="flex h-full flex-col bg-stone-50 dark:bg-stone-950"
    >
      <ViewTabs />
      <main className="flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto max-w-3xl">
          {notes.length > 0 && <TangerineNotes notes={notes} route="/threads" />}

          <header className="mt-2 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800">
              <MessageCircle size={18} className="text-stone-500" />
            </div>
            <div className="min-w-0 flex-1">
              <h1
                data-testid="threads-header"
                className="text-[18px] font-semibold tracking-tight text-stone-900 dark:text-stone-100"
              >
                Threads · {threads.length} active
              </h1>
              <p className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
                Grouped by @mention set across {events.length} captured atom
                {events.length === 1 ? "" : "s"}.
              </p>
            </div>
          </header>

          <div className="mt-4 flex items-center gap-2 rounded-md border border-stone-200 bg-white px-2 py-1.5 dark:border-stone-800 dark:bg-stone-900">
            <Search size={14} className="text-stone-400" />
            <input
              data-testid="threads-search-input"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by @mention…"
              className="w-full bg-transparent text-[13px] text-stone-800 placeholder:text-stone-400 focus:outline-none dark:text-stone-100"
            />
          </div>

          {loading && (
            <div
              data-testid="threads-loading"
              className="flex items-center justify-center py-16 text-stone-500"
            >
              <span className="font-mono text-[12px]">Reading captures…</span>
            </div>
          )}

          {error && !loading && (
            <div
              data-testid="threads-error"
              role="alert"
              className="mt-4 rounded-md border border-rose-300 bg-rose-50 p-4 text-[13px] text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200"
            >
              <div className="flex items-center gap-2 font-semibold">
                <AlertCircle size={16} />
                Couldn't load threads.
              </div>
              <div className="mt-1 font-mono text-[11px]">{error}</div>
              <button
                type="button"
                data-testid="threads-retry"
                onClick={() => setRefreshKey((k) => k + 1)}
                className="mt-3 rounded border border-rose-300 bg-white px-2 py-0.5 font-mono text-[11px] text-rose-800 hover:bg-rose-100 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-100 dark:hover:bg-rose-900"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && events.length === 0 && (
            // v1.16 Wave 3 C2 — animated 5-sample preview replaces the
            // text-only "No captures yet" so the page feels alive in the
            // 5s gap before the first real capture lands. Outer wrapper
            // keeps the legacy testid for the Wave 2 B2 empty-state spec.
            <div data-testid="threads-empty-no-captures" className="py-4">
              <EmptyStateAnimation variant="threads" />
            </div>
          )}

          {!loading && !error && events.length > 0 && filtered.length === 0 && (
            <div
              data-testid="threads-empty-filtered"
              className="flex flex-col items-center justify-center py-16 text-center"
            >
              <div className="text-[14px] font-semibold text-stone-700 dark:text-stone-200">
                No threads match the current filter
              </div>
              <p className="mt-2 text-[12px] text-stone-500 dark:text-stone-400">
                Clear the search box to see all {threads.length} thread
                {threads.length === 1 ? "" : "s"}.
              </p>
            </div>
          )}

          {!loading && !error && filtered.length > 0 && (
            <ol
              data-testid="threads-list"
              data-count={filtered.length}
              className="mt-4 space-y-2"
            >
              {filtered.map((t) => (
                <li key={t.key || "__uncategorized__"}>
                  <ThreadCard thread={t} />
                </li>
              ))}
            </ol>
          )}
        </div>
      </main>
    </div>
  );
}

// ---------- mention-set grouping ----------

/** Extract sorted lowercase unique mentions from an atom body. */
function mentionsOf(body: string | null | undefined): string[] {
  if (!body) return [];
  const set = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    set.add(m[1].toLowerCase());
  }
  return [...set].sort();
}

/**
 * Group atoms by exact mention set. Two atoms share a thread iff their
 * sorted-unique mention arrays are equal. Atoms with no mention go into
 * a single "Uncategorized" bucket so users can still scan unattributed
 * captures.
 *
 * Thread events are sorted newest-first. Threads themselves are sorted
 * by latest atom timestamp (most recently active thread on top).
 */
export function groupByMentionSet(events: TimelineEvent[]): Thread[] {
  const buckets = new Map<string, { mentions: string[]; events: TimelineEvent[] }>();
  for (const ev of events) {
    const mentions = mentionsOf(ev.body);
    const key = mentions.join(",");
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { mentions, events: [] };
      buckets.set(key, bucket);
    }
    bucket.events.push(ev);
  }
  const threads: Thread[] = [];
  for (const [key, bucket] of buckets) {
    bucket.events.sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));
    threads.push({
      key,
      mentions: bucket.mentions,
      title:
        bucket.mentions.length === 0
          ? "Uncategorized"
          : "with " + bucket.mentions.map((m) => `@${m}`).join(", "),
      events: bucket.events,
    });
  }
  // Most recently active thread first; Uncategorized falls in line by ts.
  threads.sort((a, b) => {
    const aTs = a.events[0]?.ts ?? "";
    const bTs = b.events[0]?.ts ?? "";
    return bTs.localeCompare(aTs);
  });
  return threads;
}
