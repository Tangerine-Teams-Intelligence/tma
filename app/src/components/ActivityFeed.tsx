import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { X, Activity, Clock } from "lucide-react";
import {
  readTimelineRecent,
  formatRelativeTime,
  bucketByDate,
  type TimelineEvent as TimelineEventT,
} from "@/lib/views";
import { useStore } from "@/lib/store";

/**
 * Right-rail persistent activity feed. Mounted once in <AppShell/> so it
 * stays put across all routes. Reverse-chronological recent atoms across
 * every source. Supports three filter modes:
 *
 *   all   — every captured atom
 *   me    — atoms where actor === currentUser OR currentUser ∈ actors
 *   team  — every atom that is not @me (mirror of "me")
 *
 * Polls every 30s. Each row is dismissible — dismissals are stored in
 * `ui.dismissedAtoms` (zustand) so they persist within the session.
 *
 * Stage 2: this rail is also the surface where Tangerine Notes
 * (`<TangerineNotes/>` analog for streaming alerts) will land. Stage 1
 * just shows captured atoms; the architecture is ready.
 */
export function ActivityFeed() {
  const currentUser = useStore((s) => s.ui.currentUser);
  const dismissed = useStore((s) => s.ui.dismissedAtoms);
  const dismissAtom = useStore((s) => s.ui.dismissAtom);
  const [events, setEvents] = useState<TimelineEventT[]>([]);
  const [filter, setFilter] = useState<"all" | "me" | "team">("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    const tick = () => {
      void readTimelineRecent(120).then((d) => {
        if (cancel) return;
        setEvents(d.events);
        setLoading(false);
      });
    };
    tick();
    const id = setInterval(tick, 30_000);
    const onFocus = () => tick();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
    }
    return () => {
      cancel = true;
      clearInterval(id);
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
      }
    };
  }, []);

  const filtered = useMemo(() => {
    const dismissedSet = new Set(dismissed);
    return events
      .filter((e) => !dismissedSet.has(e.id))
      .filter((e) => {
        if (filter === "all") return true;
        const isMe = e.actor === currentUser || e.actors.includes(currentUser);
        return filter === "me" ? isMe : !isMe;
      });
  }, [events, filter, dismissed, currentUser]);

  const buckets = useMemo(() => bucketByDate(filtered).slice(0, 4), [filtered]);

  return (
    <aside
      data-activity-feed
      className="ti-no-select hidden h-full w-[300px] shrink-0 flex-col border-l border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-950 lg:flex"
    >
      <div className="flex items-center gap-2 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
        <Activity size={12} className="text-[var(--ti-orange-500)]" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-700 dark:text-stone-300">
          Activity
        </span>
        <div className="ml-auto flex gap-1">
          {(["all", "me", "team"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={
                "rounded px-1.5 py-0.5 font-mono text-[10px] " +
                (filter === f
                  ? "bg-[var(--ti-orange-500)] text-white"
                  : "text-stone-500 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-900")
              }
              aria-pressed={filter === f}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading && filtered.length === 0 ? (
          <p className="px-2 py-4 text-center text-[11px] text-stone-400 dark:text-stone-500">
            Loading…
          </p>
        ) : buckets.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <Clock size={14} className="mx-auto text-stone-300 dark:text-stone-700" />
            <p className="mt-2 text-[11px] text-stone-500 dark:text-stone-400">
              Nothing captured yet
            </p>
            <p className="mt-1 text-[10px] text-stone-400 dark:text-stone-500">
              Connect a source to start the feed.
            </p>
          </div>
        ) : (
          buckets.map((b) => (
            <div key={b.date} className="mb-3">
              <p className="mb-1 px-2 font-mono text-[9px] uppercase tracking-wider text-stone-400 dark:text-stone-500">
                {dateLabel(b.date)}
              </p>
              {b.events.slice(0, 25).map((e) => (
                <ActivityRow
                  key={e.id}
                  event={e}
                  onDismiss={() => dismissAtom(e.id)}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

function ActivityRow({
  event,
  onDismiss,
}: {
  event: TimelineEventT;
  onDismiss: () => void;
}) {
  const headline = (event.body ?? "").split("\n")[0] || event.kind;
  const path = event.file ? `/memory/${encodeURI(event.file)}` : null;
  return (
    <div className="group relative flex items-start gap-2 rounded px-2 py-1.5 hover:bg-stone-100 dark:hover:bg-stone-900">
      <div className="min-w-0 flex-1">
        {path ? (
          <Link
            to={path}
            className="block min-w-0"
            data-atom-id={event.id}
          >
            <RowBody event={event} headline={headline} />
          </Link>
        ) : (
          <RowBody event={event} headline={headline} />
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="opacity-0 transition-opacity group-hover:opacity-100"
        aria-label="Dismiss"
        title="Dismiss"
      >
        <X size={11} className="text-stone-400 hover:text-stone-700 dark:text-stone-500 dark:hover:text-stone-200" />
      </button>
    </div>
  );
}

function RowBody({
  event,
  headline,
}: {
  event: TimelineEventT;
  headline: string;
}) {
  return (
    <>
      <p className="truncate text-[11px] text-stone-700 dark:text-stone-300">
        <span className="text-[var(--ti-orange-700)] dark:text-[var(--ti-orange-500)]">
          @{event.actor}
        </span>
        <span className="mx-1 text-stone-400 dark:text-stone-500">·</span>
        <span>{headline}</span>
      </p>
      <p className="font-mono text-[9px] text-stone-400 dark:text-stone-500">
        {formatRelativeTime(event.ts)} · {event.source}
      </p>
    </>
  );
}

function dateLabel(date: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (date === today) return "today";
  if (date === yest) return "yesterday";
  return date;
}
