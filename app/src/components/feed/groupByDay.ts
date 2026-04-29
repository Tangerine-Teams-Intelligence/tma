// === v1.16 Wave 2 B1 ===
/**
 * groupByDay — chunk timeline atoms into day groups for /feed.
 *
 * Rules per Wave 2 B1 spec:
 *   - same calendar day as `now` → "Today"
 *   - same calendar day as `now - 1d` → "Yesterday"
 *   - within last 7 days → "Mon Apr 28" (weekday + month + day)
 *   - within last 30 days → "Apr 24" (month + day)
 *   - older → full ISO ("2026-03-15")
 *
 * Atoms are pre-sorted descending by `ts`; we preserve input order within
 * each group and emit groups in the order they first appear (so the most-
 * recent atom's group sits at the top).
 *
 * Pure function — no DOM / no Date.now() at call site if `now` is supplied.
 * Tests pass `now` explicitly so the labels stay deterministic across runs.
 */

import type { TimelineEvent } from "@/lib/views";

export interface DayGroup {
  /** Stable key per day (YYYY-MM-DD). Used as React key + filter token. */
  key: string;
  /** Display label ("Today" / "Yesterday" / "Mon Apr 28" / ...). */
  label: string;
  events: TimelineEvent[];
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function dayLabel(eventDate: Date, now: Date): string {
  const startEvent = startOfDay(eventDate);
  const startNow = startOfDay(now);
  const diffMs = startNow.getTime() - startEvent.getTime();
  const oneDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.round(diffMs / oneDay);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays >= 2 && diffDays < 7) {
    return eventDate.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  if (diffDays >= 7 && diffDays < 30) {
    return eventDate.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  // > 30 days, or future-dated atoms (negative diff): full ISO.
  return dayKey(eventDate);
}

export function groupByDay(
  events: TimelineEvent[],
  now: Date = new Date(),
): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const ev of events) {
    const d = new Date(ev.ts);
    const key = Number.isNaN(d.getTime()) ? "unknown" : dayKey(d);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: Number.isNaN(d.getTime()) ? "Unknown" : dayLabel(d, now),
        events: [],
      };
      groups.set(key, group);
    }
    group.events.push(ev);
  }
  return Array.from(groups.values());
}
// === end v1.16 Wave 2 B1 ===
