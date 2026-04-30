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
 *
 * v1.19.1 Round 2 changes:
 *   • A. EmptyState honesty restored: branches on number of connected
 *     sources. 0 → no-sources copy with ⌘K hint. ≥1 → diagnostic
 *     three-row (watching / memory dir / first atom) with mono labels.
 *     `memoryRoot` undefined → "resolving…" (R6 amber treatment).
 *   • C. Time-view header line: "past 7 days · N atoms" mono.
 *   • D. Heatmap + Replay views mount CanvasView with `chromeless`,
 *     so the inner Replay button + zoom hint don't duplicate the
 *     v1.19 outer chrome.
 *   • H. Day separator "Today" gets the orange accent; other days
 *     stay stone.
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
 *     day's first row. "Today" gets the orange accent so the most-recent
 *     day anchors the eye (Round 2 H).
 *   • Hover = subtle bg + 1px orange left border, click → bottom sheet.
 *
 * Round 2 C: a single mono header line — "past N days · M atoms" —
 * sits above the first day separator so the page has top context.
 */
function TimeDensityList({
  events,
  onOpenAtom,
}: {
  events: TimelineEvent[];
  onOpenAtom: (e: TimelineEvent) => void;
}) {
  const grouped = useMemo(() => groupByDay(events), [events]);
  const headerLabel = useMemo(
    () => buildTimeViewHeaderLabel(events, 500),
    [events],
  );

  return (
    <div
      data-testid="time-density-list"
      data-count={events.length}
      className="mx-auto h-full w-full max-w-2xl overflow-y-auto px-8 py-12"
      style={{ contentVisibility: "auto" }}
    >
      <div
        data-testid="time-view-header"
        className="mb-6 font-mono text-[11px] text-stone-500"
      >
        {headerLabel}
      </div>
      {grouped.map(({ dateLabel, dayEvents, isToday }, idx) => (
        <section
          key={dateLabel + idx}
          data-testid="time-day-section"
          data-date={dateLabel}
          className="mb-8"
        >
          <h2
            data-testid="time-day-separator"
            data-is-today={isToday ? "true" : "false"}
            className={
              "mb-3 font-mono text-[14px] font-bold tracking-tight " +
              (isToday
                ? "text-[var(--ti-orange-500)]"
                : "text-stone-700 dark:text-stone-300")
            }
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
      <CanvasView events={events} autoPlayReplay={false} chromeless={true} />
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
                  <span className="truncate font-mono text-[11px] text-stone-500">
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
 *
 * Round 2 D: passes `chromeless` to CanvasView so the v1.18 internal
 * Replay button + pan-zoom hint don't duplicate the v1.19 outer chrome
 * (R is the replay shortcut now; the page IS the canvas).
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
      <CanvasView events={events} autoPlayReplay={true} chromeless={true} />
    </div>
  );
}

/**
 * Round 2 A — empty-state honesty restored.
 *
 * The Round 1 single-line "No captures yet. Tangerine is watching." LIES
 * when zero sources are connected — there is nothing watching. Branch:
 *   • 0 sources connected → tell the truth + point at ⌘K :sources
 *   • ≥1 source connected → v1.17.5-style three-row diagnostic, but
 *     inside the v1.19 single-canvas aesthetic (no card border, no
 *     orange accent, just typography + mono labels).
 * `memoryRoot === undefined` → render "resolving…" in stone-400, the
 * same R6 amber treatment v1.18.2 added when the path was unknown.
 */
function EmptyState() {
  const personalAgentsEnabled = useStore(
    (s) => s.ui.personalAgentsEnabled,
  );
  const memoryRoot = useStore((s) => s.ui.memoryRoot);

  const enabledSources = useMemo(() => {
    return Object.entries(personalAgentsEnabled)
      .filter(([, v]) => v)
      .map(([k]) => k);
  }, [personalAgentsEnabled]);

  const noSources = enabledSources.length === 0;

  if (noSources) {
    return (
      <div
        data-testid="empty-state"
        data-empty-mode="no-sources"
        className="flex h-full items-center justify-center px-8"
      >
        <p className="max-w-md text-center text-[14px] text-stone-500 dark:text-stone-400">
          No sources connected. Press{" "}
          <span className="font-mono text-stone-700 dark:text-stone-300">
            ⌘K
          </span>{" "}
          and type{" "}
          <span className="font-mono text-stone-700 dark:text-stone-300">
            :sources
          </span>
          , or open Settings to connect Cursor / Claude Code / Slack.
        </p>
      </div>
    );
  }

  // ≥1 source connected: diagnostic 3-row card pattern, single-canvas
  // aesthetic. Mono labels, sans values; no card border, no orange.
  const sourceList = formatSources(enabledSources);
  const memoryRootDisplay = memoryRoot && memoryRoot.length > 0 ? memoryRoot : null;

  return (
    <div
      data-testid="empty-state"
      data-empty-mode="diagnostic"
      className="flex h-full items-center justify-center px-8"
    >
      <div className="grid w-full max-w-md grid-cols-[10ch_1fr] items-baseline gap-x-3 gap-y-2">
        <span className="font-mono text-[11px] text-stone-500">watching</span>
        <span
          data-testid="empty-state-watching"
          className="truncate text-[13px] text-stone-800 dark:text-stone-200"
        >
          {sourceList}
        </span>
        <span className="font-mono text-[11px] text-stone-500">memory dir</span>
        <span
          data-testid="empty-state-memory-root"
          className={
            "truncate text-[13px] " +
            (memoryRootDisplay
              ? "text-stone-800 dark:text-stone-200"
              : "text-stone-400")
          }
        >
          {memoryRootDisplay ?? "resolving…"}
        </span>
        <span className="font-mono text-[11px] text-stone-500">first atom</span>
        <span
          data-testid="empty-state-first-atom"
          className="text-[13px] text-stone-800 dark:text-stone-200"
        >
          open Cursor and run a Claude prompt — it lands here within ~30s
        </span>
      </div>
    </div>
  );
}

// ---------- helpers ----------

/**
 * Normalize a snake_case adapter id (`claude_code`) into a kebab-case
 * display name (`claude-code`). Truncate the list to 3 entries with
 * `· N more` so the diagnostic card doesn't wrap onto a 4th line.
 */
function formatSources(ids: string[]): string {
  const normalized = ids.map((id) => id.replace(/_/g, "-"));
  if (normalized.length <= 3) return normalized.join(" · ");
  const head = normalized.slice(0, 3).join(" · ");
  const remaining = normalized.length - 3;
  return `${head} · ${remaining} more`;
}

function firstNonEmptyLine(ev: TimelineEvent): string {
  const body = ev.body ?? ev.kind ?? "";
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return "(no body)";
}

/**
 * v1.19.2 Round 3 Fix 3 — dynamic time-view header label.
 *
 * v1.19.1 R2 hardcoded "past 7 days · N atoms". The label lies in two
 * directions: a corpus that only goes back 1 day still says "past 7
 * days" (overstates depth); a corpus crammed into the last 12h says the
 * same (understates density). R3 computes the actual span from the
 * oldest event in the result set.
 *
 *   • events.length === 0   → ""             (caller hides via empty state)
 *   • days === 0            → "today · N atoms"
 *   • 1 ≤ days ≤ 13         → "past N days · M atoms"
 *   • 14 ≤ days ≤ 30        → "past K weeks · M atoms"   (K = ceil(days/7), capped at 4)
 *   • days > 30             → "past 30+ days · M atoms"
 *
 * The atom count uses singular `1 atom` / plural `N atoms`. If the
 * caller hit the `cap` (events.length === cap), the count is suffixed
 * with `+` so the user sees "we got more than this and stopped".
 *
 * Honesty: if the oldest event's `ts` is malformed / unparseable, fall
 * back to "recent · N atoms" rather than fabricate a number.
 *
 * Exported so vitest can hit it without rendering the component.
 */
export function buildTimeViewHeaderLabel(
  events: TimelineEvent[],
  cap: number,
  now: number = Date.now(),
): string {
  if (events.length === 0) return "";
  const countNum = events.length;
  const countSuffix = countNum >= cap ? "+" : "";
  const atomCountLabel =
    countNum === 1 ? "1 atom" : `${countNum}${countSuffix} atoms`;
  // Find the oldest event by parsing every ts (events arrive newest
  // first per readTimelineRecent's contract, but we don't trust it
  // structurally — pick the actual min).
  let oldestMs: number | null = null;
  for (const ev of events) {
    if (!ev.ts) continue;
    const t = Date.parse(ev.ts);
    if (Number.isNaN(t)) continue;
    if (oldestMs === null || t < oldestMs) oldestMs = t;
  }
  if (oldestMs === null) {
    return `recent · ${atomCountLabel}`;
  }
  const days = Math.floor((now - oldestMs) / (24 * 60 * 60 * 1000));
  if (days <= 0) return `today · ${atomCountLabel}`;
  if (days <= 13) {
    return days === 1
      ? `past 1 day · ${atomCountLabel}`
      : `past ${days} days · ${atomCountLabel}`;
  }
  if (days <= 30) {
    const weeks = Math.min(4, Math.ceil(days / 7));
    return weeks === 1
      ? `past 1 week · ${atomCountLabel}`
      : `past ${weeks} weeks · ${atomCountLabel}`;
  }
  return `past 30+ days · ${atomCountLabel}`;
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
  /** Round 2 H — drives the orange accent on the day separator. */
  isToday: boolean;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Group atoms into day buckets — newest first. Day label format
 *  matches the spec: "Wed 23" (day-of-week + day-of-month). The
 *  current day labels as "Today" and gets the orange accent (Round 2 H). */
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
    const isToday = day === todayKey;
    const label = Number.isNaN(d.getTime())
      ? day
      : isToday
        ? "Today"
        : `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()}`;
    return { dateLabel: label, dayEvents, isToday };
  });
}
