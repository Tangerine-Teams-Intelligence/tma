// Polling loop. Per calendar:
//   1. fetch iCal feed
//   2. parse + normalize events (past + upcoming)
//   3. write atoms (dedup by id at write time)
//   4. update cursor (wall-clock ts of this poll)

import {
  defaultMemoryRoot,
  makePaths,
  readConfig,
  readCursors,
  readIdentity,
  writeCursors,
  writeAtoms,
  learnIdentities,
  type MemoryPaths,
} from "./memory.js";
import type { Atom, CalendarConfig } from "./types.js";
import { ingestFeed } from "./ingest/feed.js";

export interface PollOpts {
  memoryRoot?: string;
  /** Inject fetch for tests. */
  fetch?: typeof fetch;
  /** Override "now" for deterministic tests. */
  now?: Date;
  /** dry-run: do everything except write atoms or advance cursors. */
  dryRun?: boolean;
}

export interface CalendarPollResult {
  calendar: string;
  calendarName?: string;
  atomCount: number;
  written: number;
  skipped: number;
  newCursor: string | null;
  error?: string;
}

export interface PollResult {
  calendars: CalendarPollResult[];
  totalAtoms: number;
  totalWritten: number;
}

async function pollOneCalendar(
  paths: MemoryPaths,
  cal: CalendarConfig,
  opts: PollOpts,
): Promise<CalendarPollResult> {
  const cfg = await readConfig(paths);
  const identity = await readIdentity(paths);
  const dryRun = opts.dryRun ?? false;

  let atoms: Atom[] = [];
  const allRawEmails = new Set<string>();
  let newCursor: string | null = null;

  try {
    const r = await ingestFeed(cal, identity, cfg, { fetch: opts.fetch, now: opts.now });
    atoms = r.atoms;
    r.rawEmails.forEach((e) => allRawEmails.add(e));
    newCursor = r.newCursor;
  } catch (err) {
    return {
      calendar: cal.id,
      calendarName: cal.name,
      atomCount: 0,
      written: 0,
      skipped: 0,
      newCursor: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Calendar-level project tagging from config — splice into every atom.
  if (cal.projects && cal.projects.length > 0) {
    for (const a of atoms) {
      const merged = new Set([...a.refs.projects, ...cal.projects]);
      a.refs.projects = [...merged];
    }
  }

  if (!dryRun) {
    await learnIdentities(paths, allRawEmails);
  }

  let written = 0;
  let skipped = 0;
  if (!dryRun) {
    const w = await writeAtoms(paths, atoms);
    written = w.written;
    skipped = w.skipped;
    if (newCursor) {
      const fresh = await readCursors(paths);
      fresh[cal.id] = newCursor;
      await writeCursors(paths, fresh);
    }
  }

  return {
    calendar: cal.id,
    calendarName: cal.name,
    atomCount: atoms.length,
    written,
    skipped,
    newCursor,
  };
}

export async function runOnce(opts: PollOpts = {}): Promise<PollResult> {
  const root = opts.memoryRoot ?? defaultMemoryRoot();
  const paths = makePaths(root);
  const cfg = await readConfig(paths);

  const results: CalendarPollResult[] = [];
  for (const c of cfg.calendars) {
    const r = await pollOneCalendar(paths, c, opts);
    results.push(r);
  }
  return {
    calendars: results,
    totalAtoms: results.reduce((s, r) => s + r.atomCount, 0),
    totalWritten: results.reduce((s, r) => s + r.written, 0),
  };
}

export async function runForever(opts: PollOpts = {}, signal?: AbortSignal): Promise<void> {
  const root = opts.memoryRoot ?? defaultMemoryRoot();
  const paths = makePaths(root);
  /* eslint-disable no-constant-condition */
  while (true) {
    if (signal?.aborted) return;
    const cfg = await readConfig(paths);
    const intervalMs = Math.max(5, cfg.poll_interval_sec) * 1000;
    try {
      await runOnce(opts);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[tangerine-calendar] poll error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(intervalMs, signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
