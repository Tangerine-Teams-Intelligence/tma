/**
 * v1.23.0 — Depth Canvas (replaces v1.22 Daily Memory Pages).
 *
 * CEO verdict on v1.22: "完全不行,整个 visual 根本不行,非常不行". After
 * 6 redesign attempts the direction surfaced: "要有一种平面 3D 的感觉" —
 * planar 3D. 2D layout that USES 3D techniques (depth shadow, layered
 * planes, hover lift, perspective) but stays a plane. Apple Vision Pro UI
 * / Stripe homepage / Linear app aesthetic — cards floating above a base
 * plane with subtle z-depth.
 *
 * The data flow is unchanged from v1.22 (`bucketByDay` + `rankAtomsForDay`
 * exports preserved so the existing test specs still hit the same pure
 * helpers). What changes is the visual layer:
 *
 *   z-axis layers from back to front:
 *     1. Background gradient base — `radial-gradient` with a soft warm
 *        glow at center top, fading to stone at the edges. Stays put.
 *     2. Heatmap underlayer — semi-transparent (max 0.20 opacity) day-
 *        density bars. Ambient ground, NOT primary content. Tinted by
 *        the dominant source for that day.
 *     3. Day separator — sticky-ish floating chip with backdrop-blur
 *        and a subtle shadow. Sits BETWEEN heatmap and atoms.
 *     4. Atom cards — solid white backgrounds with prominent
 *        box-shadows. Hero gets the deepest shadow, highlights medium,
 *        quieter cards lightest. On hover: translateY(-2px) +
 *        shadow grows. Today's hero gets a near-imperceptible
 *        perspective tilt that flattens on hover.
 *     5. Operability surfaces (CatchupBanner, CaptureInput) — already
 *        owned by /feed; we just keep them visually consistent.
 *
 * Source tinting changed from v1.22's flat tinted-bg to a glow:
 *   `box-shadow: 0 0 40px {source-color}/0.15` plus a 1px source-tinted
 * border. The source is *lit* not *colored*. Combined with the depth
 * shadow it gives each card a subtle aura keyed to its vendor.
 *
 * Hard constraints honored:
 *   • R6 honesty preserved — empty Today still renders the diagnostic line
 *     (caller-side empty state still owns the all-empty case).
 *   • Pure CSS — no three.js / framer-motion / WebGL. transforms +
 *     box-shadow + backdrop-blur only.
 *   • Typography binary preserved: serif for "Today" / "Yesterday"
 *     (high-attention days), sans for older day labels, mono for
 *     time/actor/source/IDs/counts.
 *   • Click contract: hero/highlight/quieter rows all call
 *     `onOpenAtom(ev)` → AtomBottomSheet.
 *   • Show-N-more reveal preserved (with the v1.22 show-less twin).
 *   • The local-day bucketing fix from v1.22 stays.
 *
 * What punted to v1.24+:
 *   • Parallax-on-scroll (heatmap moves slower than cards).
 *   • Mobile responsive (3-col grid still flexes via Tailwind, but no
 *     dedicated narrow-viewport polish).
 *   • Atom-emerges-from-cell zoom-in (that was v1.18 H view).
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
  /** True when the bucket is local-tz yesterday. Drives serif-vs-sans. */
  isYesterday: boolean;
  events: TimelineEvent[];
}

/**
 * Top-level component. Groups events into day buckets (newest-day first)
 * and renders the depth canvas: a radial-gradient base, a heatmap
 * underlayer, then the floating day separators + atom cards on top.
 *
 * Empty corpus is handled by the caller (FeedRoute mounts the EmptyState
 * diagnostic instead of mounting us when events.length === 0), so we
 * don't worry about it here.
 */
export function DailyMemoryPages({
  events,
  currentUser,
  onOpenAtom,
}: DailyMemoryPagesProps) {
  const buckets = useMemo(() => bucketByDay(events), [events]);
  const heatmapDays = useMemo(() => buildHeatmapDays(buckets), [buckets]);

  return (
    <div
      data-testid="daily-memory-pages"
      data-day-count={buckets.length}
      data-event-count={events.length}
      className="relative mx-auto h-full w-full overflow-y-auto"
      style={{
        contentVisibility: "auto",
        // Layer 1 — radial-gradient base. Soft warm glow at the upper-center
        // fades to neutral stone at the edges. Pure CSS (no asset). Stays
        // put behind everything (no scroll movement); the heatmap +
        // separators + atom cards layer atop it.
        background:
          "radial-gradient(ellipse 80% 60% at 50% 30%, rgba(255, 244, 234, 0.85), rgba(245, 245, 244, 1) 65%)",
      }}
    >
      {/* Layer 2 — heatmap underlayer. Full-width ribbons keyed by atom
          density per day. NOT clickable, NOT primary content. The opacity
          ceiling is 0.20 so the layer reads as ambient ground. */}
      <DepthHeatmap days={heatmapDays} />

      {/* Layer 3+4 — atoms + day separators. Single column, generous
          horizontal padding so the depth shadows breathe. */}
      <div
        data-testid="depth-canvas-stack"
        className="relative z-10 mx-auto flex max-w-3xl flex-col gap-10 px-8 py-10"
      >
        {buckets.map((b) => (
          <DayPlane
            key={b.key}
            bucket={b}
            currentUser={currentUser}
            onOpenAtom={onOpenAtom}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------- Heatmap underlayer ----------------

interface HeatmapDay {
  key: string;
  /** 0.0 - 1.0 density relative to the busiest day in the corpus. */
  density: number;
  /** Hex color for the dominant source on this day. */
  color: string;
}

/**
 * Compress the full bucket list into a row of normalized density cells.
 * The density is event-count / max-event-count so a day with 30 atoms
 * vs a day with 3 reads as 10x more lit. Capped opacity 0.20 in the
 * cell's render (the visual ceiling lives in DepthHeatmap, not here).
 */
function buildHeatmapDays(buckets: DayBucket[]): HeatmapDay[] {
  if (buckets.length === 0) return [];
  const maxCount = Math.max(...buckets.map((b) => b.events.length), 1);
  return buckets.map((b) => {
    const density = b.events.length / maxCount;
    const dominant = pickDominantSource(b.events);
    return {
      key: b.key,
      density,
      color: vendorFor(dominant).color,
    };
  });
}

function pickDominantSource(events: TimelineEvent[]): string | null {
  if (events.length === 0) return null;
  const counts = new Map<string, number>();
  for (const ev of events) {
    const s = ev.source || "unknown";
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [s, c] of counts) {
    if (c > bestCount) {
      best = s;
      bestCount = c;
    }
  }
  return best;
}

/**
 * The ambient density "ground" of the canvas. Stretches behind the entire
 * scrollable column. Each day is one cell of the same height as its plane
 * above; cells are colored by the dominant vendor for that day at low
 * opacity. The eye reads the column as a continuous heat-stripe rather
 * than discrete days — exactly the "depth" cue we want.
 */
function DepthHeatmap({ days }: { days: HeatmapDay[] }) {
  if (days.length === 0) return null;
  return (
    <div
      data-testid="depth-heatmap"
      data-day-count={days.length}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 mx-auto flex max-w-3xl flex-col px-2"
    >
      {days.map((d) => (
        <div
          key={d.key}
          data-testid="depth-heatmap-cell"
          data-day={d.key}
          data-density={d.density.toFixed(2)}
          className="flex-1 rounded-2xl"
          style={{
            backgroundColor: d.color,
            // Cap at 0.20 (per spec). 0 atom days fade to transparent.
            opacity: 0.05 + d.density * 0.15,
          }}
        />
      ))}
    </div>
  );
}

// ---------------- Day plane (separator + atoms) ----------------

interface DayPlaneProps {
  bucket: DayBucket;
  currentUser: string;
  onOpenAtom: (ev: TimelineEvent) => void;
}

function DayPlane({ bucket, currentUser, onOpenAtom }: DayPlaneProps) {
  const [showRest, setShowRest] = useState(false);

  const ranked = useMemo(
    () => rankAtomsForDay(bucket.events, currentUser),
    [bucket.events, currentUser],
  );

  // Empty Today edge — render a quiet diagnostic plane, not a full card.
  // Other days always have ≥1 atom because empty days never produce a
  // bucket.
  if (bucket.isToday && bucket.events.length === 0) {
    return (
      <section
        data-testid="day-card"
        data-date={bucket.key}
        data-is-today="true"
        data-empty="true"
        className="flex flex-col gap-3"
      >
        <DaySeparator bucket={bucket} />
        <p
          data-testid="day-empty-line"
          className="rounded-xl bg-white/70 px-5 py-4 font-mono text-[12px] text-stone-400 shadow-[0_2px_8px_rgba(0,0,0,0.04)] backdrop-blur-sm dark:bg-stone-900/60 dark:text-stone-600"
        >
          0 atoms · waiting for first capture
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
      className="flex flex-col gap-3"
    >
      <DaySeparator bucket={bucket} />
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
          className="grid grid-cols-1 gap-3 md:grid-cols-3"
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
          className="mt-1 self-start rounded-full bg-white/60 px-4 py-1.5 font-mono text-[11px] text-stone-500 shadow-[0_2px_8px_rgba(0,0,0,0.04)] backdrop-blur-sm transition-all duration-200 ease-out hover:-translate-y-px hover:bg-white/90 hover:text-[var(--ti-orange-500)] hover:shadow-[0_4px_12px_rgba(0,0,0,0.08)] dark:bg-stone-900/60 dark:text-stone-500"
        >
          show {quieter.length} quieter atom{quieter.length === 1 ? "" : "s"} ↓
        </button>
      )}
      {quieter.length > 0 && showRest && (
        <>
          <ul
            data-testid="day-quieter-list"
            className="flex flex-col gap-1.5 rounded-xl bg-white/60 p-3 shadow-[0_2px_8px_rgba(0,0,0,0.04)] backdrop-blur-sm dark:bg-stone-900/50"
          >
            {quieter.map((ev) => {
              const v = vendorFor(ev.source);
              return (
                <li key={ev.id}>
                  <button
                    type="button"
                    data-testid="day-quieter-row"
                    data-event-id={ev.id}
                    onClick={() => onOpenAtom(ev)}
                    style={{ borderLeftColor: v.color }}
                    className="grid w-full cursor-pointer grid-cols-[7ch_8ch_8ch_1fr] items-baseline gap-3 rounded-md border-l-2 px-3 py-1.5 text-left transition-all duration-200 ease-out hover:-translate-y-px hover:bg-white hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)] focus-visible:outline-none focus-visible:bg-white focus-visible:shadow-[0_2px_8px_rgba(0,0,0,0.06)] dark:hover:bg-stone-800 dark:focus-visible:bg-stone-800"
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
              );
            })}
          </ul>
          <button
            type="button"
            data-testid="day-show-less"
            onClick={() => setShowRest(false)}
            className="mt-1 self-start rounded-full bg-white/60 px-4 py-1.5 font-mono text-[11px] text-stone-500 shadow-[0_2px_8px_rgba(0,0,0,0.04)] backdrop-blur-sm transition-all duration-200 ease-out hover:-translate-y-px hover:bg-white/90 hover:text-[var(--ti-orange-500)] hover:shadow-[0_4px_12px_rgba(0,0,0,0.08)] dark:bg-stone-900/60 dark:text-stone-500"
          >
            show less ↑
          </button>
        </>
      )}
    </section>
  );
}

// ---------------- Day separator (floating chip) ----------------

/**
 * Sticky-ish day separator. Sits ABOVE the heatmap layer and BELOW the
 * atom cards. Today / Yesterday get the prominent serif headline (28px);
 * older days get a sans `font-medium` chip — fewer big headlines means
 * the recent days actually stand out instead of every day shouting.
 *
 * `position: sticky` keeps the separator visible as the user scrolls
 * through that day's atoms, mimicking a real depth cue.
 */
function DaySeparator({ bucket }: { bucket: DayBucket }) {
  const useSerif = bucket.isToday || bucket.isYesterday;
  return (
    <div
      data-testid="day-card-header"
      className="sticky top-2 z-20 mb-1 flex items-baseline justify-between"
    >
      <h1
        data-testid="day-card-date"
        data-is-today={bucket.isToday ? "true" : "false"}
        className={
          "rounded-full bg-stone-50/70 px-3 py-1 shadow-sm backdrop-blur-sm dark:bg-stone-900/60 " +
          (useSerif
            ? "font-display text-[28px] tracking-tight " +
              (bucket.isToday
                ? "text-[var(--ti-orange-500)]"
                : "text-stone-900 dark:text-stone-100")
            : "text-[14px] font-medium text-stone-600 dark:text-stone-400")
        }
      >
        {bucket.label}
      </h1>
      <span
        data-testid="day-card-atom-count"
        className="rounded-full bg-stone-50/70 px-3 py-1 font-mono text-[12px] text-stone-500 shadow-sm backdrop-blur-sm dark:bg-stone-900/60 dark:text-stone-500"
      >
        · {bucket.events.length} atom{bucket.events.length === 1 ? "" : "s"}
      </span>
    </div>
  );
}

// ---------------- Hero / Highlight cards (the floating layer) ----------------

interface HeroCardProps {
  atom: TimelineEvent;
  isToday: boolean;
  onOpen: () => void;
}

/**
 * The biggest card per day. Solid white background — the depth comes from
 * the box-shadow + source-tinted glow, NOT a paint job over the body.
 *
 * Today's hero gets the deepest shadow (24/32/48px multi-stack) and a
 * subtle perspective tilt that flattens on hover. Older days share a
 * lighter shadow stack but the same hover behaviour.
 *
 * Source tinting is a glow: an outer box-shadow keyed to vendorFor color
 * at low opacity, layered with the depth shadow. The card itself stays
 * crisp white so the body text reads as cleanly as possible.
 */
function HeroCard({ atom, isToday, onOpen }: HeroCardProps) {
  const vendor = vendorFor(atom.source);
  // Convert hex → rgb so we can compose alpha shadows in box-shadow.
  const rgb = hexToRgb(vendor.color);
  // Multi-shadow: depth (vertical, dark) + glow (omni, source-color).
  const restShadow = isToday
    ? `0 12px 48px rgba(0, 0, 0, 0.10), 0 4px 16px rgba(0, 0, 0, 0.04), 0 0 48px rgba(${rgb}, 0.18)`
    : `0 8px 32px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04), 0 0 36px rgba(${rgb}, 0.14)`;
  const hoverShadow = isToday
    ? `0 16px 56px rgba(0, 0, 0, 0.14), 0 6px 20px rgba(0, 0, 0, 0.06), 0 0 56px rgba(${rgb}, 0.24)`
    : `0 12px 40px rgba(0, 0, 0, 0.12), 0 3px 12px rgba(0, 0, 0, 0.05), 0 0 44px rgba(${rgb}, 0.18)`;

  return (
    <button
      type="button"
      data-testid="day-hero-card"
      data-event-id={atom.id}
      data-source={atom.source || "unknown"}
      onClick={onOpen}
      style={
        {
          boxShadow: restShadow,
          borderColor: `rgba(${rgb}, 0.20)`,
          // Inline CSS variables so the hover state can swap the shadow
          // without needing a JS handler. Hover style block lives below
          // in the `style jsx`-style trick: we set the var on hover via
          // the className, but Tailwind's arbitrary-value syntax can't
          // reach our computed shadow. Workaround: inline both via style
          // + a CSS-variable hand-off using `:hover` from a class.
          "--hero-rest-shadow": restShadow,
          "--hero-hover-shadow": hoverShadow,
          // Subtle planar perspective. Today's hero leans 0.5deg toward
          // the user; on hover it flattens, signaling "lifted toward
          // you". Older days skip the tilt — keeps the day-1 hero from
          // feeling visually busier than it needs.
          transform: isToday
            ? "perspective(1000px) rotateX(0.4deg) translateZ(0)"
            : "translateZ(0)",
        } as React.CSSProperties
      }
      className={
        "group block w-full rounded-xl border bg-white text-left transition-all duration-200 ease-out hover:-translate-y-[2px] hover:scale-[1.005] focus-visible:-translate-y-[2px] focus-visible:outline-none dark:bg-stone-900 " +
        // The hover-shadow swap is implemented via a CSS variable
        // re-binding in a sibling rule injected globally below; see
        // `__HERO_HOVER_STYLE__` near the bottom of this module.
        "hero-card-depth " +
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
        <span
          className="font-mono text-[12px] text-stone-600 dark:text-stone-400"
          style={{ color: vendor.color }}
        >
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
 * Smaller secondary card for atoms ranked 2–4 of the day. Same depth
 * mechanic as HeroCard but with a lighter shadow stack so the eye reads
 * the hero as primary. Hover lift + shadow-grow shared.
 */
function HighlightCard({ atom, onOpen }: HighlightCardProps) {
  const vendor = vendorFor(atom.source);
  const rgb = hexToRgb(vendor.color);
  const restShadow = `0 4px 16px rgba(0, 0, 0, 0.06), 0 1px 4px rgba(0, 0, 0, 0.03), 0 0 24px rgba(${rgb}, 0.10)`;
  const hoverShadow = `0 8px 24px rgba(0, 0, 0, 0.10), 0 2px 6px rgba(0, 0, 0, 0.04), 0 0 32px rgba(${rgb}, 0.16)`;

  return (
    <button
      type="button"
      data-testid="day-highlight-card"
      data-event-id={atom.id}
      data-source={atom.source || "unknown"}
      onClick={onOpen}
      style={
        {
          boxShadow: restShadow,
          borderColor: `rgba(${rgb}, 0.18)`,
          "--hl-rest-shadow": restShadow,
          "--hl-hover-shadow": hoverShadow,
        } as React.CSSProperties
      }
      className="highlight-card-depth flex flex-col gap-1.5 rounded-lg border bg-white p-4 text-left transition-all duration-200 ease-out hover:-translate-y-[2px] focus-visible:-translate-y-[2px] focus-visible:outline-none dark:bg-stone-900"
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
        <span
          className="truncate font-mono text-[10px]"
          style={{ color: vendor.color }}
        >
          {atom.source || "?"}
        </span>
      </div>
      <p className="line-clamp-2 text-[12px] leading-snug text-stone-800 dark:text-stone-200">
        {firstNonEmptyLine(atom)}
      </p>
    </button>
  );
}

// ---------------- Hover-shadow hand-off (CSS-variable swap) ----------------

/**
 * Tailwind can't reach an inline-style-bound multi-stop box-shadow on
 * `:hover`. Cleanest workaround: stash both rest + hover shadows as CSS
 * vars on the element (already done inline), then a tiny global style
 * block swaps which var paints the box-shadow.
 *
 * Inlined via a `<style>` element injected once at module-eval time. No
 * stylesheet import, no Tailwind plugin — just a 3-line CSS string.
 */
const __HERO_HOVER_STYLE__ = `
.hero-card-depth { box-shadow: var(--hero-rest-shadow); }
.hero-card-depth:hover, .hero-card-depth:focus-visible {
  box-shadow: var(--hero-hover-shadow);
  transform: translateY(-2px) scale(1.005) translateZ(0) !important;
}
.highlight-card-depth { box-shadow: var(--hl-rest-shadow); }
.highlight-card-depth:hover, .highlight-card-depth:focus-visible {
  box-shadow: var(--hl-hover-shadow);
}
`;

// Inject once. SSR-safe: no-op when document is undefined (vitest jsdom
// always has it; Tauri renders client-only).
if (typeof document !== "undefined") {
  const id = "v1_23-depth-canvas-hover-styles";
  if (!document.getElementById(id)) {
    const el = document.createElement("style");
    el.id = id;
    el.textContent = __HERO_HOVER_STYLE__;
    document.head.appendChild(el);
  }
}

// ---------------- helpers ----------------

/**
 * Bucket events by local calendar day. Newest day first; events within
 * a day are not re-sorted (we trust readTimelineRecent to send them
 * descending by ts, but we explicitly sort once at the top so ranking
 * is stable when callers pass an unsorted array).
 *
 * `isToday` and `label` are computed against `Date.now()` at call time
 * — fine for our use case (the user re-mounts on app open).
 *
 * Exported so tests can pin the bucketing without a full render.
 */
export function bucketByDay(events: TimelineEvent[]): DayBucket[] {
  const sorted = [...events].sort((a, b) =>
    (b.ts ?? "").localeCompare(a.ts ?? ""),
  );
  const map = new Map<string, TimelineEvent[]>();
  for (const ev of sorted) {
    // v1.22 fix preserved — parse the ts as a Date and bucket by *local*
    // day, not by the UTC slice of the iso. UTC+N timezones otherwise
    // see early-morning events bucketed under the previous day, and the
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
      isYesterday,
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
 * "Wednesday, May 1" — long-form date for older days. en-US locale is
 * hard-coded for now; v1.23 ships English copy + the spec specifically
 * reads "Wednesday, May 1".
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

/**
 * Hex (`#10b981`) → `r, g, b` triplet (`16, 185, 129`) for splicing into
 * `rgba(...)` in box-shadow strings. Falls back to neutral grey on parse
 * failure so a malformed vendor entry never crashes the render.
 */
function hexToRgb(hex: string): string {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return "120, 113, 108"; // stone-500
  const r = Number.parseInt(m[1], 16);
  const g = Number.parseInt(m[2], 16);
  const b = Number.parseInt(m[3], 16);
  return `${r}, ${g}, ${b}`;
}
