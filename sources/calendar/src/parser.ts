// iCal (RFC 5545) parsing — minimal & dependency-light.
//
// We use `ical.js` (Mozilla's reference implementation) to parse the feed
// because RFC 5545 has too many edge cases (timezones, recurrence rules,
// fold/unfold, escaping) to hand-roll. The output we expose is normalized
// into our own `ParsedEvent` shape so downstream code never touches ical.js.
//
// Recurrence: for Stage 1 we expand recurring events to a fixed window
// (default ±90 days from "now") so the timeline shows them. Two RRULE-driven
// events with the same UID are dedup'd at write time via the atom id, which
// includes the start ts, so each occurrence becomes its own atom.

// @ts-ignore — ical.js ships its own .d.ts but we accept the namespace shape.
import ICAL from "ical.js";

export interface ParsedEvent {
  uid: string;
  summary: string;
  description: string | null;
  start: Date;
  end: Date;
  location: string | null;
  organizer: string | null;
  attendees: string[];
  url: string | null;
  /** True if this is the materialised expansion of a recurring rule. */
  isRecurrenceInstance: boolean;
}

export interface ParseOpts {
  /** Window for recurrence expansion. */
  windowStart?: Date;
  windowEnd?: Date;
  /** Cap on materialised recurrence instances to avoid runaway expansion. */
  maxRecurrenceCount?: number;
}

const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_MAX_RECURRENCES = 200;

/** Parse an iCal feed and return a flat array of events (with recurrences expanded). */
export function parseIcal(icsText: string, opts: ParseOpts = {}): ParsedEvent[] {
  const now = new Date();
  const winStart = opts.windowStart ?? new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const winEnd = opts.windowEnd ?? new Date(now.getTime() + DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const maxRec = opts.maxRecurrenceCount ?? DEFAULT_MAX_RECURRENCES;

  const out: ParsedEvent[] = [];
  let jcal: unknown;
  try {
    jcal = ICAL.parse(icsText);
  } catch (err) {
    throw new Error(`ical parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const comp = new (ICAL as any).Component(jcal);
  const vevents = comp.getAllSubcomponents("vevent") as unknown[];
  for (const v of vevents) {
    const ev = new (ICAL as any).Event(v);
    if (ev.isRecurring()) {
      // Expand to window.
      const iter = ev.iterator();
      let count = 0;
      let next: unknown;
      while ((next = iter.next()) && count < maxRec) {
        const occ = next as { toJSDate: () => Date };
        const startD = occ.toJSDate();
        if (startD > winEnd) break;
        if (startD < winStart) {
          count += 1;
          continue;
        }
        const occurrence = ev.getOccurrenceDetails(occ);
        out.push(toParsedEvent(ev, occurrence.startDate, occurrence.endDate, true));
        count += 1;
      }
    } else {
      out.push(toParsedEvent(ev, ev.startDate, ev.endDate, false));
    }
  }
  return out;
}

function toParsedEvent(
  ev: { uid: string; summary?: string; description?: string; location?: string; organizer?: string; attendees?: unknown[] },
  startDate: { toJSDate: () => Date },
  endDate: { toJSDate: () => Date } | null | undefined,
  isRecurrenceInstance: boolean,
): ParsedEvent {
  const start = startDate.toJSDate();
  const end = endDate ? endDate.toJSDate() : start;
  const attendees = (ev.attendees ?? []).map((a: unknown) => {
    if (typeof a === "string") return a;
    if (a && typeof (a as any).getFirstValue === "function") {
      const v = (a as any).getFirstValue();
      return typeof v === "string" ? v : "";
    }
    return "";
  }).filter((s: string) => s.length > 0);
  return {
    uid: String(ev.uid ?? ""),
    summary: String(ev.summary ?? "Untitled event"),
    description: ev.description ? String(ev.description) : null,
    start,
    end,
    location: ev.location ? String(ev.location) : null,
    organizer: parseEmail(ev.organizer ?? ""),
    attendees: attendees.map(parseEmail).filter((s) => s.length > 0),
    url: null,
    isRecurrenceInstance,
  };
}

/** Pull `mailto:...` addresses out of an iCal CAL-ADDRESS string. */
function parseEmail(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = String(raw).trim();
  if (s.toLowerCase().startsWith("mailto:")) return s.slice(7);
  return s;
}

/** Filter to events that already happened before `now` (or the supplied date). */
export function pastEvents(events: ParsedEvent[], now: Date = new Date()): ParsedEvent[] {
  return events.filter((e) => e.end < now);
}

/** Filter to events that haven't started yet. */
export function upcomingEvents(events: ParsedEvent[], now: Date = new Date()): ParsedEvent[] {
  return events.filter((e) => e.start >= now);
}
