// Pre-meeting brief trigger.
//
// PRIMARY purpose of the calendar source: enable pre-meeting briefs. When
// the daemon ticks (every 5 min by default), it calls `nextBriefTriggers()`
// which returns events starting in [now, now + brief_lead + window]. For
// each triggerable event the daemon's existing brief-generator extension
// composes a brief and pushes it to the user.
//
// Stage 1: brief content = "events ahead, attendees, prior threads matching
// title". Stage 2 reasoning loop replaces the matching with embedding-based
// retrieval + AI summarisation.
//
// We deliberately keep this module pure-Python-style (no IO inside the
// trigger functions themselves). The daemon owns the actual Claude CLI call
// + notification dispatch — see `briefForEvent()` below for the canonical
// shape the daemon expects.

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultMemoryRoot, makePaths, readConfig } from "./memory.js";
import { fetchIcal } from "./client.js";
import { parseIcal, upcomingEvents, type ParsedEvent } from "./parser.js";

export interface BriefTrigger {
  /** Event slug (matches AtomCalendarRef.slug). */
  slug: string;
  /** Title surfaced to the user. */
  title: string;
  /** ISO start ts. */
  start: string;
  /** Minutes until the event starts (rounded). */
  minutesUntil: number;
  /** Calendar id this came from. */
  calendar: string;
  /** Attendees (raw emails or aliases). */
  attendees: string[];
  /** Location, if any. */
  location: string | null;
}

/**
 * Determine which upcoming events should trigger a pre-meeting brief right
 * now. The daemon calls this on every heartbeat.
 *
 *   - leadMinutes  — how long before the event we want a brief (default 5)
 *   - windowMinutes — daemon tick window so we don't miss events between ticks
 *
 * Events between [now + leadMinutes - windowMinutes, now + leadMinutes]
 * trigger. Roughly: "any event starting in the next 5–10 min."
 */
export function nextBriefTriggers(
  events: ParsedEvent[],
  opts: {
    now?: Date;
    leadMinutes?: number;
    windowMinutes?: number;
    calendar: string;
  },
): BriefTrigger[] {
  const now = opts.now ?? new Date();
  const lead = opts.leadMinutes ?? 5;
  const window = opts.windowMinutes ?? 10;
  const lo = new Date(now.getTime() + (lead - window) * 60 * 1000);
  const hi = new Date(now.getTime() + lead * 60 * 1000);

  const out: BriefTrigger[] = [];
  for (const e of upcomingEvents(events, now)) {
    if (e.start < lo || e.start > hi) continue;
    out.push({
      slug: slugOf(e),
      title: e.summary,
      start: e.start.toISOString(),
      minutesUntil: Math.round((e.start.getTime() - now.getTime()) / 60000),
      calendar: opts.calendar,
      attendees: e.attendees,
      location: e.location ?? null,
    });
  }
  return out;
}

function slugOf(e: ParsedEvent): string {
  // Mirror normalize.eventSlug shape but without re-importing.
  const date = e.start.toISOString().slice(0, 10);
  const summarySlug = e.summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const uidSuffix = e.uid.split(/[@-]/)[0].slice(-8) || "evt";
  return `${date}-${summarySlug}-${uidSuffix}`.slice(0, 100);
}

/**
 * Compose a Stage 1 brief for one event by scanning the team-memory thread
 * and timeline files for atoms whose body or refs mention the event title or
 * attendees. Returns markdown the daemon can hand to a notification.
 *
 * Stage 1 is keyword-substring matching — Stage 2 swaps in semantic search +
 * Claude summarisation.
 */
export async function briefForEvent(
  memoryRoot: string,
  trigger: BriefTrigger,
): Promise<string> {
  const lines: string[] = [
    `# Pre-meeting brief — ${trigger.title}`,
    ``,
    `Starts in ${trigger.minutesUntil} min (${trigger.start} UTC).`,
    ``,
  ];
  if (trigger.attendees.length > 0) {
    lines.push(`Attendees: ${trigger.attendees.join(", ")}`);
    lines.push("");
  }
  if (trigger.location) {
    lines.push(`Location: ${trigger.location}`);
    lines.push("");
  }
  // Cheap keyword-substring scan of thread + timeline files. The Stage 2
  // reasoning loop will replace this with vector retrieval + Claude.
  const matches: string[] = [];
  const root = memoryRoot;
  const search = (trigger.title || "").toLowerCase();
  if (search.length > 2) {
    const dirs = ["timeline", "threads"];
    for (const d of dirs) {
      const dir = join(root, d);
      if (!existsSync(dir)) continue;
      let entries: string[] = [];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith(".md")) continue;
        const fp = join(dir, f);
        let txt = "";
        try {
          txt = await fs.readFile(fp, "utf8");
        } catch {
          continue;
        }
        if (txt.toLowerCase().includes(search)) {
          matches.push(`- ${d}/${f}`);
        }
      }
    }
  }
  if (matches.length === 0) {
    lines.push("_No prior threads matched the event title._");
  } else {
    lines.push("## Relevant prior context");
    lines.push("");
    for (const m of matches.slice(0, 10)) lines.push(m);
    if (matches.length > 10) {
      lines.push(`- _… ${matches.length - 10} more files matched_`);
    }
  }
  lines.push("");
  lines.push("_Generated by tangerine-calendar (Stage 1 keyword match — Stage 2 will use semantic retrieval.)_");
  return lines.join("\n");
}

/**
 * Convenience: load events from all configured iCal feeds and surface the
 * brief triggers for the daemon to act on. The daemon imports this directly
 * (`@tangerine/source-calendar` exposes it via `index.ts`).
 *
 * The daemon should call this each heartbeat. Implementation re-fetches the
 * feeds; a tighter integration could stash parsed events in memory between
 * polls, but for pre-meeting briefs the marginal cost of one HTTP GET per
 * 5-min tick is trivial.
 */
export async function pollBriefTriggers(opts: {
  memoryRoot?: string;
  now?: Date;
  fetch?: typeof fetch;
}): Promise<BriefTrigger[]> {
  const root = opts.memoryRoot ?? defaultMemoryRoot();
  const paths = makePaths(root);
  const cfg = await readConfig(paths);
  const triggers: BriefTrigger[] = [];
  for (const cal of cfg.calendars) {
    if (cal.provider !== "ical" || !cal.url) continue;
    try {
      const text = await fetchIcal(cal.url, { fetch: opts.fetch });
      const events = parseIcal(text);
      triggers.push(
        ...nextBriefTriggers(events, {
          now: opts.now,
          leadMinutes: cfg.brief_lead_minutes,
          windowMinutes: cfg.upcoming_window_minutes,
          calendar: cal.id,
        }),
      );
    } catch {
      // Non-fatal — feed errors don't break the brief loop.
    }
  }
  return triggers;
}
