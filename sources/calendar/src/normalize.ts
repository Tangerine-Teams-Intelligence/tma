// Calendar event payloads → Tangerine atoms.
//
// One atom per event (per occurrence for recurring events). Past + upcoming
// events use the same `kind: calendar_event`; the daemon distinguishes them
// for the pre-meeting brief by checking `start` against now().

import {
  defaultAgi,
  type Atom,
  type AtomCalendarRef,
  type AtomRefs,
  type AgiHooks,
  type IdentityMap,
  type SourceConfig,
} from "./types.js";
import type { ParsedEvent } from "./parser.js";

export interface NormalizeCtx {
  calendar: { id: string; name?: string; provider: "ical" | "google" };
  identity: IdentityMap;
  config: SourceConfig;
}

export function makeCtx(
  calendar: { id: string; name?: string; provider: "ical" | "google" },
  identity: IdentityMap,
  config: SourceConfig,
): NormalizeCtx {
  return { calendar, identity, config };
}

export function aliasFor(addr: string | null | undefined, identity: IdentityMap): string {
  if (!addr) return "unknown";
  const mapped = identity[addr];
  return mapped && mapped.length > 0 ? mapped : addr;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "event";
}

/** Stable slug from event UID + start ts so recurring instances are unique. */
export function eventSlug(uid: string, startIso: string, summary: string): string {
  // YYYY-MM-DD-<summary-slug>-<uid-suffix>
  const date = startIso.slice(0, 10);
  const summarySlug = slugify(summary);
  const uidSuffix = uid.split(/[@-]/)[0].slice(-8) || "evt";
  return `${date}-${summarySlug}-${uidSuffix}`.slice(0, 100);
}

function buildRefs(opts: {
  calendar: AtomCalendarRef;
  people: string[];
  projects: string[];
  threads: string[];
  meetings?: string[];
}): AtomRefs {
  const refs: AtomRefs = {
    calendar: opts.calendar,
    meeting: null,
    decisions: [],
    people: opts.people,
    projects: opts.projects,
    threads: opts.threads,
  };
  if (opts.meetings && opts.meetings.length > 0) {
    refs.meetings = opts.meetings;
  }
  return refs;
}

function buildAgi(overrides: Partial<AgiHooks> = {}): AgiHooks {
  return { ...defaultAgi(), ...overrides };
}

export function normalizeEvent(raw: ParsedEvent, ctx: NormalizeCtx): Atom {
  const startIso = raw.start.toISOString();
  const endIso = raw.end.toISOString();
  const slug = eventSlug(raw.uid, startIso, raw.summary);

  const organizer = aliasFor(raw.organizer ?? null, ctx.identity);
  const attendees = raw.attendees.map((a) => aliasFor(a, ctx.identity));
  const actor = organizer && organizer !== "unknown" ? organizer : (attendees[0] ?? "unknown");
  const actors = uniq([actor, ...attendees]);

  const calRef: AtomCalendarRef = {
    provider: ctx.calendar.provider,
    calendar: ctx.calendar.id,
    uid: raw.uid,
    slug,
    start: startIso,
    end: endIso,
    title: raw.summary,
    location: raw.location ?? undefined,
    organizer: raw.organizer ?? undefined,
    url: raw.url ?? undefined,
  };

  const projects: string[] = [];
  // Project hint from title brackets (mirrors the GitHub source's regex).
  const m = /^\s*\[([a-zA-Z0-9._-]+)\]/.exec(raw.summary);
  if (m && m[1]) projects.push(m[1]);

  const thread = `cal-${ctx.calendar.id.toLowerCase()}-${slug}`;
  const meetings = [slug]; // pre-emptive meeting hint; daemon may resolve later.

  const desc = raw.description ? `\n\n${truncate(raw.description, 800)}` : "";
  const loc = raw.location ? `\nLocation: ${raw.location}` : "";
  const attendeesLine = raw.attendees.length > 0 ? `\nAttendees: ${raw.attendees.join(", ")}` : "";

  return {
    id: `evt-cal-${ctx.calendar.id.toLowerCase()}-${slug}`,
    ts: startIso,
    source: "calendar",
    actor,
    actors,
    kind: "calendar_event",
    refs: buildRefs({
      calendar: calRef,
      people: actors,
      projects,
      threads: [thread],
      meetings,
    }),
    status: "active",
    sample: false,
    body:
      `**${raw.summary}** (${formatRange(raw.start, raw.end)})${loc}${attendeesLine}${desc}`,
    agi: buildAgi(),
  };
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function formatRange(start: Date, end: Date): string {
  const s = start.toISOString().replace("T", " ").slice(0, 16);
  const e = end.toISOString().replace("T", " ").slice(0, 16);
  return `${s} → ${e} UTC`;
}
