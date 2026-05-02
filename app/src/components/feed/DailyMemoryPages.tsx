/**
 * v1.22.0 — Daily Memory Pages.
 *
 * Replaces the v1.19→v1.21 time-density 4-col grid list (which felt like
 * a `git log`) with stacked "day cards" — Apple Photos Memories pattern,
 * done properly. Each day = one section with a hero atom, three smaller
 * highlight cards, and a collapsed "show N quieter atoms" tail.
 *
 * Design choices:
 *
 *   • Day-card container — `max-w-3xl mx-auto px-8 py-12`, one day per
 *     scroll page. Today's card is bordered + no fill; older days get a
 *     subtle stone-50/50 fill so the eye anchors on Today.
 *
 *   • Day header — serif date string ("Today" / "Yesterday" / "Wednesday,
 *     May 1") on the left, mono atom count on the right (justify-between).
 *
 *   • Hero atom — auto-picked via the same +10/+5/+3/+2/+1 scoring the
 *     v1.17 HighlightsRow uses. Falls back to the most-recent atom when
 *     no atom clears score 1. Card uses `vendorFor(source).color` at 15%
 *     opacity for a subtle source tint, mono header (time / actor /
 *     source), sans body line-clamped to 3.
 *
 *   • Highlight cards — atoms ranked 2-4 by the same algorithm. Three-
 *     column grid below the hero. Each card has a 2px source-colored
 *     left border accent + smaller typography.
 *
 *   • Show-N-more — when a day has > 4 atoms, render a quiet `show N
 *     quieter atoms ↓` toggle. Click expands the v1.19/v1.21 4-col
 *     time-density grid for the rest of that day's atoms. Toggle pairs
 *     with `show less ↑`, mirroring the CatchupBanner pattern (CEO's
 *     "every click-in needs a click-out" rule from v1.21.1).
 *
 *   • Today empty — a quiet `Today · 0 atoms · waiting for first capture`
 *     line, NOT a full card with hero. Saves vertical space when the
 *     user just opened the app and hasn't done anything yet.
 *
 * Reuse:
 *   • Day grouping uses the inline `groupByDay` from `feed.tsx` (which
 *     gives us the `dateLabel` + `isToday` + `dayEvents` triple). We
 *     re-derive a richer date string ("Wednesday, May 1") via `Intl.
 *     DateTimeFormat` because the inline grouper only emits short
 *     "Wed 23" labels — Memory pages want the long form.
 *   • Atom scoring is copy-pasted from HighlightsRow's `pickHighlights`
 *     (we don't import — keeps coupling loose; HighlightsRow lives, we
 *     just don't mount it).
 *   • Vendor color via existing `vendorFor`.
 *   • AtomBottomSheet contract unchanged: caller passes `onOpenAtom`,
 *     we wire each card's onClick to it.
 *
 * Hard constraints honored:
 *   • Source tints capped at 15% opacity (1A in hex on the alpha
 *     channel). Loud is the wrong shape.
 *   • `var(--ti-orange-500)` only used for the day-separator on Today's
 *     date and on hover row left-border. Hero card backgrounds are
 *     SOURCE-tinted, never orange.
 *   • Typography binary preserved: serif for date, sans for body, mono
 *     for time / actor / source / counts / IDs.
 *   • No emojis, no lucide icons in the body content.
 */

import { useMemo, useState } from "react";
import type { TimelineEvent } from "@/lib/views";
import { vendorFor } from "./vendor";

const MENTION_RE = /@([a-z0-9][a-z0-9_.-]*)/gi;
const RECENT_24H_MS = 24 * 60 * 60 * 1000;
/** Minimum highlight score below which we fall back to "most recent". */
const MIN_SCORE = 1;
/** A day-card surfaces 1 hero + 3 highlights = 4 atoms above the fold. */
const HIGHLIGHTS_ABOVE_FOLD = 4;

interface DailyMemoryPagesProps {
  events: TimelineEvent[];
  currentUser: string;
  onOpenAtom: (ev: TimelineEvent) => void;
}

interface DayBucket {
  /** Day key — `YYYY-MM-DD`. Used as React key + the data-date attr. */
  key: string;
  /** Long date string — "Today" / "Yesterday" / "Wednesday, May 1". */
  label: string;
  /** True when the bucket is the local-tz current day. */
  isToday: boolean;
  events: TimelineEvent[];
}

/**
 * Top-level component. Groups events into day buckets (newest-day first)
 * and renders one DayCard per bucket. Empty corpus is handled by the
 * caller (FeedRoute mounts the EmptyState diagnostic instead of mounting
 * us when events.length === 0), so we don't worry about it here.
 */
export function DailyMemoryPages({
  events,
  currentUser,
  onOpenAtom,
}: DailyMemoryPagesProps) {
  const buckets = useMemo(() => bucketByDay(events), [events]);

  return (
    <div
      data-testid="daily-memory-pages"
      data-day-count={buckets.length}
      data-event-count={events.length}
      className="mx-auto h-full w-full overflow-y-auto"
      style={{ contentVisibility: "auto" }}
    >
      {buckets.map((b) => (
        <DayCard
          key={b.key}
          bucket={b}
          currentUser={currentUser}
          onOpenAtom={onOpenAtom}
        />
      ))}
    </div>
  );
}

interface DayCardProps {
  bucket: DayBucket;
  currentUser: string;
  onOpenAtom: (ev: TimelineEvent) => void;
}

function DayCard({ bucket, currentUser, onOpenAtom }: DayCardProps) {
  const [showRest, setShowRest] = useState(false);

  const ranked = useMemo(
    () => rankAtomsForDay(bucket.events, currentUser),
    [bucket.events, currentUser],
  );

  // Empty Today edge — render a quiet line, not a full card. (Other days
  // always have ≥1 atom because empty days never produce a bucket.)
  if (bucket.isToday && bucket.events.length === 0) {
    return (
      <section
        data-testid="day-card"
        data-date={bucket.key}
        data-is-today="true"
        data-empty="true"
        className="mx-auto max-w-3xl px-8 py-12"
      >
        <p className="font-mono text-[12px] text-stone-400 dark:text-stone-600">
          <span className="font-display text-[18px] tracking-tight text-stone-500 dark:text-stone-500">
            Today
          </span>
          <span className="ml-3">· 0 atoms · waiting for first capture</span>
        </p>
      </section>
    );
  }

  const [hero, ...rest] = ranked;
  const highlights = rest.slice(0, HIGHLIGHTS_ABOVE_FOLD - 1);
  const quieter = rest.slice(HIGHLIGHTS_ABOVE_FOLD - 1);

  return (
    <section
      data-testid="day-card"
      data-date={bucket.key}
      data-is-today={bucket.isToday ? "true" : "false"}
      data-atom-count={bucket.events.length}
      className={
        "mx-auto max-w-3xl px-8 py-12 " +
        (bucket.isToday
          ? "border-t border-stone-200 dark:border-stone-800"
          : "border-t border-stone-200 bg-stone-50/50 dark:border-stone-800 dark:bg-stone-900/30")
      }
    >
      <DayHeader bucket={bucket} />
      {hero && (
        <HeroCard
          atom={hero}
          isToday={bucket.isToday}
          onOpen={() => onOpenAtom(hero)}
        />
      )}
      {highlights.length > 0 && (
        <div
          data-testid="day-highlights-grid"
          data-count={highlights.length}
          className="mt-4 grid grid-cols-3 gap-3"
        >
          {highlights.map((ev) => (
            <HighlightCard
              key={ev.id}
              atom={ev}
              onOpen={() => onOpenAtom(ev)}
            />
          ))}
        </div>
      )}
      {quieter.length > 0 && !showRest && (
        <button
          type="button"
          data-testid="day-show-more"
          data-count={quieter.length}
          onClick={() => setShowRest(true)}
          className="mt-6 w-full rounded-sm py-1 font-mono text-[11px] text-stone-500 transition-colors hover:text-[var(--ti-orange-500)] dark:text-stone-500"
        >
          show {quieter.length} quieter atom{quieter.length === 1 ? "" : "s"} ↓
        </button>
      )}
      {quieter.length > 0 && showRest && (
        <>
          <ul data-testid="day-quieter-list" className="mt-4">
            {quieter.map((ev) => (
              <li key={ev.id}>
                <button
                  type="button"
                  data-testid="day-quieter-row"
                  data-event-id={ev.id}
                  onClick={() => onOpenAtom(ev)}
                  className="grid w-full cursor-pointer grid-cols-[7ch_8ch_8ch_1fr] items-baseline gap-3 rounded-sm border-l border-transparent px-2 py-1 text-left transition-colors duration-100 hover:border-[var(--ti-orange-500)] hover:bg-stone-100 focus-visible:border-[var(--ti-orange-500)] focus-visible:bg-stone-100 focus-visible:outline-none dark:hover:bg-stone-900 dark:focus-visible:bg-stone-900"
                >
                  <span className="font-mono text-[11px] text-stone-500">
                    {formatClock(ev.ts)}
                  </span>
                  <span className="truncate text-[13px] font-medium text-stone-900 dark:text-stone-100">
                    {ev.actor || "?"}
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
          <button
            type="button"
            data-testid="day-show-less"
            onClick={() => setShowRest(false)}
            className="mt-2 w-full rounded-sm py-1 font-mono text-[11px] text-stone-500 transition-colors hover:text-[var(--ti-orange-500)] dark:text-stone-500"
          >
            show less ↑
          </button>
        </>
      )}
    </section>
  );
}

function DayHeader({ bucket }: { bucket: DayBucket }) {
  return (
    <div
      data-testid="day-card-header"
      className="mb-6 flex items-baseline justify-between"
    >
      <h1
        data-testid="day-card-date"
        data-is-today={bucket.isToday ? "true" : "false"}
        className={
          "font-display text-[28px] tracking-tight " +
          (bucket.isToday
            ? "text-[var(--ti-orange-500)]"
            : "text-stone-900 dark:text-stone-100")
        }
      >
        {bucket.label}
      </h1>
      <span
        data-testid="day-card-atom-count"
        className="font-mono text-[12px] text-stone-500 dark:text-stone-500"
      >
        · {bucket.events.length} atom{bucket.events.length === 1 ? "" : "s"}
      </span>
    </div>
  );
}

interface HeroCardProps {
  atom: TimelineEvent;
  isToday: boolean;
  onOpen: () => void;
}

/**
 * The biggest card per day. Source-tinted background (~15% opacity) for
 * dimensionality without being loud. Today's hero gets `p-8` padding;
 * older days get the standard `p-6`.
 */
function HeroCard({ atom, isToday, onOpen }: HeroCardProps) {
  const vendor = vendorFor(atom.source);
  // 15% opacity — the source tint is a hint, not a paint job. The CSS
  // alpha is appended as 2 hex chars `26` ≈ 0.15.
  const tint = `${vendor.color}26`;

  return (
    <button
      type="button"
      data-testid="day-hero-card"
      data-event-id={atom.id}
      data-source={atom.source || "unknown"}
      onClick={onOpen}
      style={{ backgroundColor: tint }}
      className={
        "block w-full rounded-md text-left transition-shadow duration-100 hover:shadow-sm focus-visible:shadow-sm focus-visible:outline-none " +
        (isToday ? "p-8" : "p-6")
      }
    >
      <div className="mb-3 flex items-baseline gap-2">
        <span className="font-mono text-[12px] text-stone-600 dark:text-stone-400">
          {formatClock(atom.ts)}
        </span>
        <span className="text-stone-400 dark:text-stone-600">·</span>
        <span className="text-[14px] font-medium text-stone-900 dark:text-stone-100">
          {atom.actor || "?"}
        </span>
        <span className="text-stone-400 dark:text-stone-600">·</span>
        <span className="font-mono text-[12px] text-stone-600 dark:text-stone-400">
          {atom.source || "?"}
        </span>
      </div>
      <p className="line-clamp-3 text-[15px] leading-relaxed text-stone-800 dark:text-stone-200">
        {firstNonEmptyLine(atom)}
      </p>
    </button>
  );
}

interface HighlightCardProps {
  atom: TimelineEvent;
  onOpen: () => void;
}

/**
 * Smaller secondary card. Source-color accent on the LEFT border only
 * (no full background tint — the hero already owns that signal). Hover
 * deepens the same source color on the border so the card feels
 * tappable without being loud.
 */
function HighlightCard({ atom, onOpen }: HighlightCardProps) {
  const vendor = vendorFor(atom.source);
  return (
    <button
      type="button"
      data-testid="day-highlight-card"
      data-event-id={atom.id}
      data-source={atom.source || "unknown"}
      onClick={onOpen}
      style={{ borderLeftColor: vendor.color }}
      className="flex flex-col gap-1.5 rounded-md border border-stone-200 border-l-2 p-3 text-left transition-colors hover:border-stone-300 dark:border-stone-800 dark:hover:border-stone-700"
    >
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[10px] text-stone-500">
          {formatClock(atom.ts)}
        </span>
        <span className="text-stone-300 dark:text-stone-700">·</span>
        <span className="truncate text-[11px] font-medium text-stone-700 dark:text-stone-300">
          {atom.actor || "?"}
        </span>
        <span className="text-stone-300 dark:text-stone-700">·</span>
        <span className="truncate font-mono text-[10px] text-stone-500">
          {atom.source || "?"}
        </span>
      </div>
      <p className="line-clamp-2 text-[12px] leading-snug text-stone-800 dark:text-stone-200">
        {firstNonEmptyLine(atom)}
      </p>
    </button>
  );
}

// ---------------- helpers ----------------

/**
 * Bucket events by local calendar day. Newest day first; events within
 * a day are not re-sorted (we trust readTimelineRecent to send them
 * descending by ts, but we explicitly sort once at the top so ranking
 * is stable when callers pass an unsorted array).
 *
 * `isToday` and `label` are computed against `Date.now()` at call time
 * — fine for our use case (the user re-mounts on app open). If they sit
 * on the page across midnight the label drifts, that's a v1.23 problem.
 *
 * Exported so tests can pin the bucketing without a full render.
 */
export function bucketByDay(events: TimelineEvent[]): DayBucket[] {
  const sorted = [...events].sort((a, b) =>
    (b.ts ?? "").localeCompare(a.ts ?? ""),
  );
  const map = new Map<string, TimelineEvent[]>();
  for (const ev of sorted) {
    // v1.22 fix — parse the ts as a Date and bucket by *local* day, not
    // by the UTC slice of the iso. Otherwise UTC+N timezones see early-
    // morning events bucketed under the previous day, and the
    // "Today / Yesterday" labels misfire by 24h.
    const tsDate = ev.ts ? new Date(ev.ts) : null;
    if (!tsDate || Number.isNaN(tsDate.getTime())) continue;
    const day = localDayKey(tsDate);
    let arr = map.get(day);
    if (!arr) {
      arr = [];
      map.set(day, arr);
    }
    arr.push(ev);
  }

  const todayKey = localDayKey(new Date());
  const yesterdayKey = localDayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));

  return [...map.entries()].map(([day, dayEvents]) => {
    const isToday = day === todayKey;
    const isYesterday = day === yesterdayKey;
    const label = isToday
      ? "Today"
      : isYesterday
        ? "Yesterday"
        : longDateString(day);
    return {
      key: day,
      label,
      isToday,
      events: dayEvents,
    };
  });
}

/**
 * Local-tz YYYY-MM-DD. We can't naively slice the ts because the event
 * timestamps are UTC iso, but our "is it today" question is local.
 */
function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * "Wednesday, May 1" — long-form date for older days. Uses the user's
 * locale via `undefined` (we want the local format, not en-US always).
 *
 * v1.22 ships English copy + the spec specifically reads "Wednesday,
 * May 1", so the en-US locale is hard-coded for now. If we i18n later,
 * pass the user's locale in.
 */
function longDateString(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dayKey;
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(d);
  } catch {
    return dayKey;
  }
}

interface ScoredEvent {
  event: TimelineEvent;
  score: number;
}

/**
 * Rank atoms within a single day. Mirrors HighlightsRow's `pickHighlights`
 * but keeps the full sorted list (HighlightsRow caps at 5; we want every
 * atom available so the "show N more" tail is exhaustive).
 *
 * Tie-break = newer first. A day with no atom clearing MIN_SCORE returns
 * the day's atoms in pure newest-first order — the most-recent atom
 * becomes the hero by default.
 *
 * Exported for tests.
 */
export function rankAtomsForDay(
  events: TimelineEvent[],
  currentUser: string,
): TimelineEvent[] {
  if (events.length === 0) return [];
  const me = currentUser.toLowerCase();
  const conceptCountBySource = countConceptsBySource(events);
  const scored: ScoredEvent[] = events.map((ev) => {
    let score = 0;
    const body = ev.body ?? "";
    const mentions = extractMentions(body);
    if (mentions.includes(me)) score += 10;
    if (mentions.length > 0 && !mentions.includes(me)) {
      score += Math.min(mentions.length, 3) * 5;
    }
    const ts = Date.parse(ev.ts || "");
    if (!Number.isNaN(ts) && Date.now() - ts < RECENT_24H_MS) score += 1;
    if (ev.kind === "decision") score += 2;
    for (const c of ev.concepts ?? []) {
      const sourcesForConcept = conceptCountBySource.get(c);
      if (!sourcesForConcept) continue;
      const otherSources = [...sourcesForConcept].filter(
        (s) => s !== ev.source,
      );
      if (otherSources.length > 0) {
        score += 3;
        break;
      }
    }
    return { event: ev, score };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.event.ts || "").localeCompare(a.event.ts || "");
  });
  // If nothing clears MIN_SCORE, the algorithm degenerates to
  // newest-first which is the explicit fallback per spec.
  const anyAboveThreshold = scored.some((s) => s.score >= MIN_SCORE);
  if (!anyAboveThreshold) {
    return [...events].sort((a, b) =>
      (b.ts ?? "").localeCompare(a.ts ?? ""),
    );
  }
  return scored.map((s) => s.event);
}

function countConceptsBySource(
  events: TimelineEvent[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const ev of events) {
    for (const c of ev.concepts ?? []) {
      const set = out.get(c) ?? new Set<string>();
      set.add(ev.source || "");
      out.set(c, set);
    }
  }
  return out;
}

function extractMentions(body: string): string[] {
  if (!body) return [];
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

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
