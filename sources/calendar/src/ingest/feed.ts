// Calendar-feed ingest. Per calendar:
//   1. fetch iCal text (or — Stage 2 — Google Calendar API)
//   2. parse to ParsedEvent[] (recurrence-expanded)
//   3. emit one calendar_event atom per event (past + upcoming)
//   4. dedup at write time via stable atom id (uid + start ts)

import type { Atom, CalendarConfig, IdentityMap, SourceConfig } from "../types.js";
import { fetchIcal } from "../client.js";
import { parseIcal, type ParsedEvent } from "../parser.js";
import { makeCtx, normalizeEvent } from "../normalize.js";

export interface IngestFeedOpts {
  /** Inject fetch for tests. */
  fetch?: typeof fetch;
  /** Override "now" for deterministic recurrence windows in tests. */
  now?: Date;
}

export interface IngestFeedResult {
  atoms: Atom[];
  rawEmails: Set<string>;
  newCursor: string | null;
}

export async function ingestFeed(
  cal: CalendarConfig,
  identity: IdentityMap,
  config: SourceConfig,
  opts: IngestFeedOpts = {},
): Promise<IngestFeedResult> {
  if (cal.provider !== "ical") {
    throw new Error(`provider ${cal.provider} not supported in Stage 1 (ical only)`);
  }
  if (!cal.url) {
    throw new Error(`calendar ${cal.id} missing url`);
  }
  const text = await fetchIcal(cal.url, { fetch: opts.fetch });
  const events = parseIcal(text);
  return ingestParsed(events, cal, identity, config, opts.now ?? new Date());
}

/** Pure-function variant for tests: skip the network. */
export function ingestParsed(
  events: ParsedEvent[],
  cal: CalendarConfig,
  identity: IdentityMap,
  config: SourceConfig,
  now: Date = new Date(),
): IngestFeedResult {
  const ctx = makeCtx(
    { id: cal.id, name: cal.name, provider: cal.provider },
    identity,
    config,
  );
  const atoms: Atom[] = [];
  const rawEmails = new Set<string>();
  let newCursor: string | null = null;

  for (const e of events) {
    if (e.organizer) rawEmails.add(e.organizer);
    for (const a of e.attendees) rawEmails.add(a);
    const atom = normalizeEvent(e, ctx);
    atoms.push(atom);
    if (newCursor === null || atom.ts > newCursor) newCursor = atom.ts;
  }

  // The cursor is the wall-clock of this poll, not the newest event ts —
  // calendars may have events scheduled far in the future, so a future-event
  // cursor would skip back-fills next time.
  return { atoms, rawEmails, newCursor: now.toISOString() };
}
