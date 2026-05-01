/**
 * v1.21.0 — Operability surface A: Catch-up banner.
 *
 * The pre-v1.21 canvas was pure read-only — atoms scrolled past, no
 * surface said "you missed N things while you were away." The catch-up
 * banner sits at the top of /feed (above the time-density list, in the
 * same `max-w-2xl` column) and gives the user a one-glance answer to
 * "what's new since last time I looked."
 *
 * Logic:
 *   • Reads `~/.tangerine-memory/.tangerine/cursors/<user>.json` via
 *     `read_cursor` for the user's `last_opened_at`.
 *   • Filters the events prop to those with `ts > last_opened_at`.
 *   • Renders a header line + the top 3 rows in the same 4-col grid
 *     the time-density list uses (time / actor / source / body).
 *   • A `show all ↓` button reveals all N rows in-line.
 *
 * Empty states (R6 honesty):
 *   • Never visited (`last_opened_at` null) → render nothing. The full
 *     timeline IS the catch-up.
 *   • 0 new atoms since last visit → quiet `caught up · last looked
 *     X ago` line in stone-400 mono.
 *
 * The user's `last_opened_at` is bumped to "now" by `mark_user_opened`
 * the first time they engage (click an atom or fire a T/H/P/R key) —
 * driven by the parent FeedRoute, not this component, since the keys
 * live there.
 */

import { useEffect, useMemo, useState } from "react";
import { readCursor, type TimelineEvent } from "@/lib/views";

interface CatchupBannerProps {
  /** Full event list rendered by the parent (already sorted newest first). */
  events: TimelineEvent[];
  /** Current user alias — drives the cursor read. */
  user: string;
  /** Click handler — opens the atom in the bottom sheet. */
  onOpenAtom: (ev: TimelineEvent) => void;
}

const TOP_N = 3;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function CatchupBanner({ events, user, onOpenAtom }: CatchupBannerProps) {
  const [lastVisited, setLastVisited] = useState<string | null | undefined>(
    undefined,
  );
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancel = false;
    readCursor(user)
      .then((c) => {
        if (cancel) return;
        setLastVisited(c.last_opened_at);
      })
      .catch(() => {
        if (cancel) return;
        setLastVisited(null);
      });
    return () => {
      cancel = true;
    };
  }, [user]);

  const newEvents = useMemo(() => {
    if (!lastVisited) return [];
    const threshold = Date.parse(lastVisited);
    if (Number.isNaN(threshold)) return [];
    return events.filter((ev) => {
      const t = Date.parse(ev.ts ?? "");
      return Number.isFinite(t) && t > threshold;
    });
  }, [events, lastVisited]);

  // Resolving — render nothing yet (no flash of zero state).
  if (lastVisited === undefined) return null;

  // Never visited — the full timeline IS the catch-up. Don't render.
  if (lastVisited === null) return null;

  const count = newEvents.length;

  // 0 new since last visit → quiet `caught up` line.
  if (count === 0) {
    return (
      <div
        data-testid="feed-catchup-banner"
        data-mode="caught-up"
        className="mb-6"
      >
        <p
          data-testid="feed-catchup-count"
          className="font-mono text-[11px] text-stone-400 dark:text-stone-600"
        >
          caught up · last looked {formatRelativeShort(lastVisited)}
        </p>
      </div>
    );
  }

  const rows = showAll ? newEvents : newEvents.slice(0, TOP_N);

  return (
    <div
      data-testid="feed-catchup-banner"
      data-mode="new-atoms"
      className="mb-8"
    >
      <p className="text-[13px] text-stone-700 dark:text-stone-300">
        you were last here {formatRelativeShort(lastVisited)}
        <span className="text-stone-400 dark:text-stone-600"> · </span>
        <span
          data-testid="feed-catchup-count"
          className="font-mono text-[11px] text-[var(--ti-orange-500)]"
        >
          {count} new atom{count === 1 ? "" : "s"} since
        </span>
      </p>
      <div
        aria-hidden
        className="my-3 h-px w-full bg-stone-200 dark:bg-stone-800"
      />
      <ul>
        {rows.map((ev) => (
          <li key={ev.id}>
            <button
              type="button"
              data-testid="feed-catchup-row"
              data-event-id={ev.id}
              onClick={() => onOpenAtom(ev)}
              className="grid w-full cursor-pointer grid-cols-[7ch_8ch_8ch_1fr] items-baseline gap-3 rounded-sm border-l border-transparent px-2 py-1 text-left transition-colors duration-100 hover:border-[var(--ti-orange-500)] hover:bg-stone-100 focus-visible:border-[var(--ti-orange-500)] focus-visible:bg-stone-100 focus-visible:outline-none dark:hover:bg-stone-900 dark:focus-visible:bg-stone-900"
            >
              <span className="font-mono text-[11px] text-stone-500 dark:text-stone-500">
                {formatClock(ev.ts)}
              </span>
              <span className="truncate text-[13px] font-medium text-stone-900 dark:text-stone-100">
                {ev.actor || "?"}
              </span>
              <span className="truncate font-mono text-[11px] text-stone-500 dark:text-stone-500">
                {ev.source || "?"}
              </span>
              <span className="truncate text-[13px] text-stone-800 dark:text-stone-200">
                {firstNonEmptyLine(ev)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!showAll && count > TOP_N && (
        <button
          type="button"
          data-testid="feed-catchup-show-all"
          onClick={() => setShowAll(true)}
          className="mt-2 w-full rounded-sm py-1 font-mono text-[11px] text-stone-500 transition-colors hover:text-[var(--ti-orange-500)] dark:text-stone-500"
        >
          show all {count} ↓
        </button>
      )}
    </div>
  );
}

// ---------- helpers ----------

function firstNonEmptyLine(ev: TimelineEvent): string {
  const body = ev.body ?? ev.kind ?? "";
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return "(no body)";
}

function formatClock(iso: string | null | undefined): string {
  if (!iso) return "??:??";
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (m) return `${m[1]}:${m[2]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "??:??";
  return d.toISOString().slice(11, 16);
}

/**
 * Short "X ago" — "12 min ago" / "2h ago" / "3d ago" / "Tue 23". The
 * banner header reads naturally with this terse form ("you were last
 * here 2h ago"), unlike the longer `formatRelativeTime` in views.ts.
 */
export function formatRelativeShort(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "recently";
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 60 * 60) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 60 * 60 * 24) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 60 * 60 * 24 * 7) {
    return `${Math.floor(seconds / (60 * 60 * 24))}d ago`;
  }
  // Older than a week → render the actual day, not "12d ago" which
  // gets unwieldy.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "a while ago";
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()}`;
}
