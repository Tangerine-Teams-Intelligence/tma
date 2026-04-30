/**
 * v1.19.0 Round 1 — Single-canvas surface.
 *
 * The 5-tab sidebar architecture was the wrong shape. v1.19 ships a
 * single-canvas + Cmd+K-everything redesign:
 *   • Default view = time-density typography list (Obsidian-grade).
 *   • Single-key shortcuts T / H / P / R cycle between view modes.
 *   • All search / filter / nav goes through Spotlight (Cmd+K).
 *
 * /feed is the entry route in Round 1; v1.19's redirect table sends
 * every legacy route here. The file kept its old name so import paths
 * across the codebase don't break — the render is wholly new.
 *
 * Round-1 punts:
 *   • No virtualization. CSS `content-visibility: auto` is the only
 *     trick we use for the 1000-row 60fps target. If real corpora
 *     stutter, Round 2 swaps in react-virtuoso.
 *   • No header chrome on the time view. The page IS the list.
 *   • Mobile is acceptable to break. Desktop-first.
 */

import { useEffect, useMemo, useState } from "react";
import {
  readTimelineRecent,
  type TimelineEvent,
} from "@/lib/views";
import { useStore } from "@/lib/store";
import { AtomBottomSheet } from "@/components/feed/AtomBottomSheet";
import { CanvasView } from "@/components/canvas/CanvasView";
import { buildPeopleStats } from "@/routes/people/index";
import { useReplayController } from "@/components/canvas/ReplayController";

export default function FeedRoute() {
  const canvasView = useStore((s) => s.ui.canvasView);
  const setCanvasView = useStore((s) => s.ui.setCanvasView);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openAtom, setOpenAtom] = useState<TimelineEvent | null>(null);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    readTimelineRecent(500)
      .then((d) => {
        if (cancel) return;
        setEvents(d.events);
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

  return (
    <div
      data-testid="feed-route"
      data-canvas-view={canvasView}
      className="flex h-full w-full flex-col bg-stone-50 dark:bg-stone-950"
    >
      {loading && (
        <div
          data-testid="feed-loading"
          className="flex h-full items-center justify-center text-stone-500"
        >
          <span className="font-mono text-[12px]">Loading captures…</span>
        </div>
      )}
      {error && !loading && (
        <div className="flex h-full items-center justify-center px-6">
          <div
            data-testid="feed-error"
            role="alert"
            className="max-w-md rounded-md border border-rose-300 bg-rose-50 p-4 text-[13px] text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200"
          >
            <div className="font-semibold">Couldn't load captures.</div>
            <div className="mt-1 font-mono text-[11px]">{error}</div>
          </div>
        </div>
      )}
      {!loading && !error && events.length === 0 && <EmptyState />}
      {!loading && !error && events.length > 0 && (
        <>
          {canvasView === "time" && (
            <TimeDensityList events={events} onOpenAtom={setOpenAtom} />
          )}
          {canvasView === "heatmap" && <HeatmapView events={events} />}
          {canvasView === "people" && (
            <PeopleDensityList events={events} onOpenAtom={setOpenAtom} />
          )}
          {canvasView === "replay" && (
            <ReplayView
              events={events}
              onComplete={() => setCanvasView("time")}
            />
          )}
        </>
      )}
      <AtomBottomSheet event={openAtom} onClose={() => setOpenAtom(null)} />
    </div>
  );
}

/**
 * The default surface. Time-density typography list — bold day separator
 * lines, then a dense one-row-per-atom grid: time / actor / source / body.
 *
 * Layout choices:
 *   • Centered column max-w-2xl (≈ 640px, the Obsidian width).
 *   • CSS grid for the row: `grid-cols-[7ch_8ch_8ch_1fr] gap-3`. The
 *     leading mono columns hold time / actor / source; the body
 *     truncates with `line-clamp-1`.
 *   • Day separator = bold mono text, NOT an <hr>. Top-aligned to the
 *     day's first row.
 *   • Hover = subtle bg + 1px orange left border, click → bottom sheet.
 */
function TimeDensityList({
  events,
  onOpenAtom,
}: {
  events: TimelineEvent[];
  onOpenAtom: (e: TimelineEvent) => void;
}) {
  const grouped = useMemo(() => groupByDay(events), [events]);

  return (
    <div
      data-testid="time-density-list"
      data-count={events.length}
      className="mx-auto h-full w-full max-w-2xl overflow-y-auto px-8 py-12"
      style={{ contentVisibility: "auto" }}
    >
      {grouped.map(({ dateLabel, dayEvents }, idx) => (
        <section
          key={dateLabel + idx}
          data-testid="time-day-section"
          data-date={dateLabel}
          className="mb-8"
        >
          <h2
            data-testid="time-day-separator"
            className="mb-3 font-mono text-[14px] font-bold tracking-tight text-stone-700 dark:text-stone-300"
          >
            {dateLabel}
          </h2>
          <ul>
            {dayEvents.map((ev) => (
              <li key={ev.id}>
                <button
                  type="button"
                  data-testid="time-row"
                  data-event-id={ev.id}
                  onClick={() => onOpenAtom(ev)}
                  className="grid w-full cursor-pointer grid-cols-[7ch_8ch_8ch_1fr] items-baseline gap-3 rounded-sm border-l border-transparent px-2 py-1 text-left hover:border-[var(--ti-orange-500)] hover:bg-stone-100 dark:hover:bg-stone-900"
                >
                  <span className="font-mono text-[11px] text-stone-500 dark:text-stone-500">
                    {formatClock(ev.ts)}
                  </span>
                  <span className="truncate text-[13px] font-medium text-stone-900 dark:text-stone-100">
                    {ev.actor || "?"}
                  </span>
                  <span className="truncate text-[11px] text-stone-500 dark:text-stone-500">
                    {ev.source || "?"}
                  </span>
                  <span className="truncate text-[13px] text-stone-800 dark:text-stone-200">
                    {firstNonEmptyLine(ev)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function HeatmapView({ events }: { events: TimelineEvent[] }) {
  return (
    <div
      data-testid="heatmap-view"
      className="mx-auto h-full w-full max-w-5xl overflow-hidden p-4"
    >
      <CanvasView events={events} autoPlayReplay={false} />
    </div>
  );
}

function PeopleDensityList({
  events,
  onOpenAtom,
}: {
  events: TimelineEvent[];
  onOpenAtom: (e: TimelineEvent) => void;
}) {
  const stats = useMemo(() => buildPeopleStats(events), [events]);
  const [selected, setSelected] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!selected) return [];
    const sel = selected.toLowerCase();
    return events
      .filter((e) => (e.actor ?? "").toLowerCase() === sel)
      .slice()
      .sort((a, b) => Date.parse(b.ts ?? "") - Date.parse(a.ts ?? ""))
      .slice(0, 50);
  }, [events, selected]);

  return (
    <div
      data-testid="people-density-list"
      data-count={stats.length}
      className="mx-auto h-full w-full max-w-2xl overflow-y-auto px-8 py-12"
    >
      <h2 className="mb-4 font-mono text-[14px] font-bold text-stone-700 dark:text-stone-300">
        people
      </h2>
      <ul className="mb-8">
        {stats.map((p) => (
          <li key={p.alias}>
            <button
              type="button"
              data-testid="people-density-row"
              data-alias={p.alias}
              onClick={() =>
                setSelected((cur) => (cur === p.alias ? null : p.alias))
              }
              className={
                "grid w-full cursor-pointer grid-cols-[1fr_8ch_12ch] items-baseline gap-3 rounded-sm border-l px-2 py-1 text-left " +
                (selected === p.alias
                  ? "border-[var(--ti-orange-500)] bg-stone-100 dark:bg-stone-900"
                  : "border-transparent hover:border-[var(--ti-orange-500)] hover:bg-stone-100 dark:hover:bg-stone-900")
              }
            >
              <span className="truncate text-[13px] font-medium text-stone-900 dark:text-stone-100">
                @{p.alias}
              </span>
              <span className="font-mono text-[11px] text-stone-500">
                {p.countToday} 24h
              </span>
              <span className="truncate font-mono text-[11px] text-stone-500">
                {p.hashtags.slice(0, 3).map((h) => `#${h}`).join(" ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {selected && filtered.length > 0 && (
        <>
          <h2 className="mb-3 font-mono text-[14px] font-bold text-stone-700 dark:text-stone-300">
            atoms · @{selected}
          </h2>
          <ul>
            {filtered.map((ev) => (
              <li key={ev.id}>
                <button
                  type="button"
                  data-testid="people-density-atom-row"
                  data-event-id={ev.id}
                  onClick={() => onOpenAtom(ev)}
                  className="grid w-full cursor-pointer grid-cols-[7ch_8ch_1fr] items-baseline gap-3 rounded-sm border-l border-transparent px-2 py-1 text-left hover:border-[var(--ti-orange-500)] hover:bg-stone-100 dark:hover:bg-stone-900"
                >
                  <span className="font-mono text-[11px] text-stone-500">
                    {formatClock(ev.ts)}
                  </span>
                  <span className="truncate text-[11px] text-stone-500">
                    {ev.source || "?"}
                  </span>
                  <span className="truncate text-[13px] text-stone-800 dark:text-stone-200">
                    {firstNonEmptyLine(ev)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Replay surface. Auto-plays once on mount; ESC stops + flips back to time.
 * Reuses the v1.18 useReplayController hook + CanvasView, just driven into
 * an instant-start mode with no UI chrome around it.
 */
function ReplayView({
  events,
  onComplete,
}: {
  events: TimelineEvent[];
  onComplete: () => void;
}) {
  const ctrl = useReplayController(events);
  // Kick the timelapse on mount.
  useEffect(() => {
    ctrl.start();
    // Auto-finish: after REPLAY_DURATION_MS + a small grace, return to
    // the time view. `playing` will flip to false once the controller
    // sees progress >= 1; we watch that and call onComplete.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!ctrl.playing && ctrl.progress >= 1) {
      const id = window.setTimeout(onComplete, 300);
      return () => window.clearTimeout(id);
    }
  }, [ctrl.playing, ctrl.progress, onComplete]);
  // ESC stops + returns.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        ctrl.reset();
        onComplete();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      data-testid="replay-view"
      className="relative mx-auto h-full w-full max-w-5xl overflow-hidden"
    >
      <CanvasView events={events} autoPlayReplay={true} />
    </div>
  );
}

function EmptyState() {
  return (
    <div
      data-testid="empty-state"
      className="flex h-full items-center justify-center"
    >
      <p className="text-[14px] text-stone-400">
        No captures yet. Tangerine is watching.
      </p>
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

interface DayBucket {
  dateLabel: string;
  dayEvents: TimelineEvent[];
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Group atoms into day buckets — newest first. Day label format
 *  matches the spec: "Wed 23" (day-of-week + day-of-month). */
export function groupByDay(events: TimelineEvent[]): DayBucket[] {
  const sorted = [...events].sort((a, b) =>
    (b.ts ?? "").localeCompare(a.ts ?? ""),
  );
  const map = new Map<string, TimelineEvent[]>();
  for (const ev of sorted) {
    const day = (ev.ts ?? "").slice(0, 10);
    if (!day) continue;
    let arr = map.get(day);
    if (!arr) {
      arr = [];
      map.set(day, arr);
    }
    arr.push(ev);
  }
  const todayKey = new Date().toISOString().slice(0, 10);
  return [...map.entries()].map(([day, dayEvents]) => {
    const d = new Date(day + "T00:00:00Z");
    const label = Number.isNaN(d.getTime())
      ? day
      : day === todayKey
        ? "Today"
        : `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()}`;
    return { dateLabel: label, dayEvents };
  });
}
