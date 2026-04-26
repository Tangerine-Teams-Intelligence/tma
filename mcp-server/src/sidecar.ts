/**
 * sidecar.ts — read-only access to the operational sidecar at `<root>/.tangerine/`.
 *
 * The sidecar is computed by the desktop app's daemon (tmi.event_router /
 * tmi.briefs / tmi.cursors) and is *never* written by the MCP server. We
 * just read:
 *
 *   - .tangerine/timeline.json     → atom index
 *   - .tangerine/briefs/<date>.md  → daily brief
 *   - .tangerine/briefs/pending.md → pending alerts
 *   - .tangerine/cursors/<u>.json  → per-user view state
 *
 * The path layout mirrors `src/tmi/event_router.py` (`sidecar_dir`) and
 * `src/tmi/cursors.py`. Note: in the team_repo layout the sidecar lives at
 * `<repo>/.tangerine/` next to `<repo>/memory/`. In the solo layout the
 * sidecar lives at `<home>/.tangerine/` next to `<home>/.tangerine-memory/`.
 *
 * For MCP we standardise on this convention: the sidecar is the **sibling**
 * of the memory root, named `.tangerine`. So if `memory_root =
 * /foo/bar/memory` the sidecar is `/foo/bar/.tangerine`. If `memory_root`
 * itself ends in `.tangerine-memory` (solo mode), the sidecar is
 * `<parent>/.tangerine/`.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Compute the sidecar directory for a memory root. Mirrors
 * `tmi.event_router.sidecar_dir` (`memory_root.parent / ".tangerine"`).
 */
export function sidecarDir(memoryRoot: string): string {
  return path.join(path.dirname(memoryRoot), ".tangerine");
}

export function timelineIndexPath(memoryRoot: string): string {
  return path.join(sidecarDir(memoryRoot), "timeline.json");
}

export function briefsDir(memoryRoot: string): string {
  return path.join(sidecarDir(memoryRoot), "briefs");
}

export function dailyBriefPath(memoryRoot: string, dateIso: string): string {
  return path.join(briefsDir(memoryRoot), `${dateIso}.md`);
}

export function pendingBriefPath(memoryRoot: string): string {
  return path.join(briefsDir(memoryRoot), "pending.md");
}

export function cursorsDir(memoryRoot: string): string {
  return path.join(sidecarDir(memoryRoot), "cursors");
}

export function cursorPath(memoryRoot: string, user: string): string {
  return path.join(cursorsDir(memoryRoot), `${user}.json`);
}

/** Atom record shape stored in `.tangerine/timeline.json`. */
export interface AtomRecord {
  id: string;
  ts: string;
  source: string;
  actor: string;
  actors?: string[];
  kind: string;
  refs?: {
    meeting?: string;
    decisions?: string[];
    people?: string[];
    projects?: string[];
    threads?: string[];
  };
  status?: string;
  lifecycle?: {
    decided?: string;
    review_by?: string;
    owner?: string;
    due?: string;
    closed?: string;
  };
  file?: string;
  line?: number;
  body?: string;
  sample?: boolean;
}

export interface TimelineIndex {
  version: number;
  events: AtomRecord[];
  rebuilt_at?: string;
}

/**
 * Read `.tangerine/timeline.json`. Returns an empty index if missing or
 * unparseable — never throws to the caller. Missing-file is the common case
 * for fresh / solo installs and is silent; parse errors log to stderr.
 */
export async function loadTimelineIndex(memoryRoot: string): Promise<TimelineIndex> {
  const p = timelineIndexPath(memoryRoot);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(
        `[tangerine-mcp] sidecar timeline.json unreadable: ${(err as Error).message}\n`,
      );
    }
    return { version: 1, events: [] };
  }
  try {
    const parsed = JSON.parse(raw) as TimelineIndex;
    if (!parsed || !Array.isArray(parsed.events)) {
      return { version: 1, events: [] };
    }
    parsed.events = parsed.events.filter((r) => r && typeof r.id === "string");
    return parsed;
  } catch (err) {
    process.stderr.write(
      `[tangerine-mcp] sidecar timeline.json malformed: ${(err as Error).message}\n`,
    );
    return { version: 1, events: [] };
  }
}

/**
 * Read a daily brief markdown file if present. Returns null on missing.
 */
export async function readDailyBrief(
  memoryRoot: string,
  dateIso: string,
): Promise<string | null> {
  try {
    return await fs.readFile(dailyBriefPath(memoryRoot, dateIso), "utf8");
  } catch {
    return null;
  }
}

/**
 * Read the pending-alerts markdown file. Returns null if not yet generated.
 */
export async function readPendingBrief(memoryRoot: string): Promise<string | null> {
  try {
    return await fs.readFile(pendingBriefPath(memoryRoot), "utf8");
  } catch {
    return null;
  }
}

export interface CursorRecord {
  user: string;
  last_opened_at: string | null;
  atoms_viewed: Record<string, string>;
  atoms_acked: Record<string, string>;
  atoms_deferred: Record<string, string>;
  thread_cursor: Record<string, string>;
}

/**
 * Read a per-user cursor file. Returns a fresh empty cursor if missing.
 */
export async function loadCursor(
  memoryRoot: string,
  user: string,
): Promise<CursorRecord> {
  const fresh: CursorRecord = {
    user,
    last_opened_at: null,
    atoms_viewed: {},
    atoms_acked: {},
    atoms_deferred: {},
    thread_cursor: {},
  };
  try {
    const raw = await fs.readFile(cursorPath(memoryRoot, user), "utf8");
    const parsed = JSON.parse(raw) as Partial<CursorRecord>;
    return {
      user,
      last_opened_at: parsed.last_opened_at ?? null,
      atoms_viewed: parsed.atoms_viewed ?? {},
      atoms_acked: parsed.atoms_acked ?? {},
      atoms_deferred: parsed.atoms_deferred ?? {},
      thread_cursor: parsed.thread_cursor ?? {},
    };
  } catch {
    return fresh;
  }
}

/**
 * Today's date in YYYY-MM-DD (UTC). MCP server doesn't bind to a TZ — the
 * daemon (Python side) writes briefs in Asia/Shanghai but we just look up
 * by name; if the brief for today exists, we return it.
 */
export function todayIso(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Filter atoms by predicate, sort newest-first, cap to limit.
 */
export function filterAtoms(
  atoms: AtomRecord[],
  pred: (a: AtomRecord) => boolean,
  limit: number,
): AtomRecord[] {
  const out = atoms.filter((a) => !a.sample && pred(a));
  out.sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));
  return out.slice(0, Math.max(0, limit));
}

/**
 * Newest atom in the list (by ts). Returns null on empty.
 */
export function newestAtom(atoms: AtomRecord[]): AtomRecord | null {
  if (atoms.length === 0) return null;
  let best = atoms[0];
  for (const a of atoms) {
    if ((a.ts ?? "") > (best.ts ?? "")) best = a;
  }
  return best;
}
