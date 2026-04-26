// Atom → memory tree writer.
//
// Layout under <memory>:
//   timeline/<YYYY-MM-DD>.md            chronological feed (one file per UTC day)
//   threads/<thread-id>.md              per-event thread
//   .tangerine/sources/calendar.config.json     calendar list + cursor state
//   .tangerine/sources/calendar.cursor.json     per-calendar last-poll fingerprint
//   .tangerine/sources/calendar.identity.json   email → Tangerine alias
//
// Atoms are appended in YAML-frontmatter + markdown form, separated by `\n---\n`.
// Every atom serializes the 8 Stage 1 AGI hook fields (STAGE1_AGI_HOOKS.md).
//
// Dedup is per-file: before appending, we read the file and skip any atom
// whose `id:` already appears.
//
// TODO(module-a): once `tmi.event_router.EventRouter` lands as a process API,
// swap the direct file writes here for `router.process(atom)`. The router
// will handle fan-out to people/projects/threads/timeline uniformly across
// sources.

import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as os from "node:os";
import type { Atom, IdentityMap, SourceConfig } from "./types.js";
import { defaultConfig } from "./types.js";

export const ATOM_SEPARATOR = "\n---\n";

export interface MemoryPaths {
  root: string;
  timeline(dateUtc: string): string;
  thread(id: string): string;
  configFile(): string;
  cursorFile(): string;
  identityFile(): string;
}

export function defaultMemoryRoot(): string {
  if (process.env.MEMORY_ROOT && process.env.MEMORY_ROOT.length > 0) {
    return process.env.MEMORY_ROOT;
  }
  if (process.env.TARGET_REPO && process.env.TARGET_REPO.length > 0) {
    return join(process.env.TARGET_REPO, "memory");
  }
  return join(os.homedir(), ".tangerine-memory");
}

export function makePaths(root: string): MemoryPaths {
  return {
    root,
    timeline: (date) => join(root, "timeline", `${date}.md`),
    thread: (id) => join(root, "threads", `${id}.md`),
    configFile: () => join(root, ".tangerine", "sources", "calendar.config.json"),
    cursorFile: () => join(root, ".tangerine", "sources", "calendar.cursor.json"),
    identityFile: () => join(root, ".tangerine", "sources", "calendar.identity.json"),
  };
}

function ensureDir(path: string): void {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ----------------------------------------------------------------------
// Config IO

export async function readConfig(paths: MemoryPaths): Promise<SourceConfig> {
  try {
    const raw = await fs.readFile(paths.configFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<SourceConfig>;
    return { ...defaultConfig(), ...parsed, calendars: parsed.calendars ?? [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultConfig();
    }
    throw err;
  }
}

export async function writeConfig(paths: MemoryPaths, cfg: SourceConfig): Promise<void> {
  ensureDir(paths.configFile());
  await fs.writeFile(paths.configFile(), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/** Per-calendar cursor map; the value is the ISO ts of the last poll. */
export interface CursorMap {
  [calendarId: string]: string;
}

export async function readCursors(paths: MemoryPaths): Promise<CursorMap> {
  try {
    const raw = await fs.readFile(paths.cursorFile(), "utf8");
    return JSON.parse(raw) as CursorMap;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export async function writeCursors(paths: MemoryPaths, cursors: CursorMap): Promise<void> {
  ensureDir(paths.cursorFile());
  await fs.writeFile(paths.cursorFile(), JSON.stringify(cursors, null, 2) + "\n", "utf8");
}

export async function readIdentity(paths: MemoryPaths): Promise<IdentityMap> {
  try {
    const raw = await fs.readFile(paths.identityFile(), "utf8");
    return JSON.parse(raw) as IdentityMap;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export async function writeIdentity(paths: MemoryPaths, id: IdentityMap): Promise<void> {
  ensureDir(paths.identityFile());
  await fs.writeFile(paths.identityFile(), JSON.stringify(id, null, 2) + "\n", "utf8");
}

// ----------------------------------------------------------------------
// Atom IO

export function atomToMarkdown(atom: Atom): string {
  const lines: string[] = ["---"];
  lines.push(`id: ${atom.id}`);
  lines.push(`ts: ${atom.ts}`);
  lines.push(`source: ${atom.source}`);
  lines.push(`actor: ${atom.actor}`);
  lines.push(`actors: [${atom.actors.map(yamlStr).join(", ")}]`);
  lines.push(`kind: ${atom.kind}`);
  lines.push(`refs:`);
  if (atom.refs.calendar) {
    lines.push(`  calendar:`);
    lines.push(`    provider: ${yamlStr(atom.refs.calendar.provider)}`);
    lines.push(`    calendar: ${yamlStr(atom.refs.calendar.calendar)}`);
    lines.push(`    uid: ${yamlStr(atom.refs.calendar.uid)}`);
    lines.push(`    slug: ${yamlStr(atom.refs.calendar.slug)}`);
    lines.push(`    start: ${yamlStr(atom.refs.calendar.start)}`);
    lines.push(`    end: ${yamlStr(atom.refs.calendar.end)}`);
    lines.push(`    title: ${yamlStr(atom.refs.calendar.title)}`);
    if (atom.refs.calendar.location) lines.push(`    location: ${yamlStr(atom.refs.calendar.location)}`);
    if (atom.refs.calendar.organizer) lines.push(`    organizer: ${yamlStr(atom.refs.calendar.organizer)}`);
    if (atom.refs.calendar.url) lines.push(`    url: ${yamlStr(atom.refs.calendar.url)}`);
  }
  lines.push(`  meeting: ${atom.refs.meeting === null ? "null" : yamlStr(atom.refs.meeting)}`);
  lines.push(`  decisions: [${atom.refs.decisions.map(yamlStr).join(", ")}]`);
  lines.push(`  people: [${atom.refs.people.map(yamlStr).join(", ")}]`);
  lines.push(`  projects: [${atom.refs.projects.map(yamlStr).join(", ")}]`);
  lines.push(`  threads: [${atom.refs.threads.map(yamlStr).join(", ")}]`);
  if (atom.refs.meetings && atom.refs.meetings.length > 0) {
    lines.push(`  meetings: [${atom.refs.meetings.map(yamlStr).join(", ")}]`);
  }
  lines.push(`status: ${atom.status}`);
  lines.push(`sample: ${atom.sample ? "true" : "false"}`);
  // Stage 1 AGI hook fields — STAGE1_AGI_HOOKS.md, Hook 1.
  lines.push(`embedding: ${atom.agi.embedding === null ? "null" : JSON.stringify(atom.agi.embedding)}`);
  lines.push(`concepts: [${atom.agi.concepts.map(yamlStr).join(", ")}]`);
  lines.push(`confidence: ${atom.agi.confidence}`);
  lines.push(`alternatives: [${atom.agi.alternatives.map(yamlStr).join(", ")}]`);
  lines.push(`source_count: ${atom.agi.source_count}`);
  lines.push(`reasoning_notes: ${atom.agi.reasoning_notes === null ? "null" : yamlStr(atom.agi.reasoning_notes)}`);
  lines.push(`sentiment: ${atom.agi.sentiment === null ? "null" : yamlStr(atom.agi.sentiment)}`);
  lines.push(`importance: ${atom.agi.importance === null ? "null" : atom.agi.importance}`);
  lines.push("---");
  lines.push("");
  lines.push(atom.body);
  lines.push("");
  return lines.join("\n");
}

function yamlStr(s: string): string {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

/** UTC date stamp YYYY-MM-DD from an RFC 3339 ts. */
export function utcDate(ts: string): string {
  return ts.slice(0, 10);
}

async function appendAtomIfNew(filePath: string, atom: Atom): Promise<boolean> {
  ensureDir(filePath);
  const md = atomToMarkdown(atom);
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing.includes(`\nid: ${atom.id}\n`) || existing.startsWith(`---\nid: ${atom.id}\n`)) {
    return false;
  }
  const next = existing.length === 0 ? md : existing.replace(/\s*$/, "") + ATOM_SEPARATOR + md;
  await fs.writeFile(filePath, next, "utf8");
  return true;
}

export interface WriteResult {
  wroteTimeline: boolean;
  wroteThreadFiles: number;
}

export async function writeAtom(paths: MemoryPaths, atom: Atom): Promise<WriteResult> {
  const date = utcDate(atom.ts);
  const wroteTimeline = await appendAtomIfNew(paths.timeline(date), atom);
  let wroteThreadFiles = 0;
  for (const t of atom.refs.threads) {
    const wrote = await appendAtomIfNew(paths.thread(t), atom);
    if (wrote) wroteThreadFiles += 1;
  }
  return { wroteTimeline, wroteThreadFiles };
}

export async function writeAtoms(
  paths: MemoryPaths,
  atoms: Atom[],
): Promise<{ written: number; skipped: number }> {
  let written = 0;
  let skipped = 0;
  const sorted = [...atoms].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const a of sorted) {
    const r = await writeAtom(paths, a);
    if (r.wroteTimeline || r.wroteThreadFiles > 0) written += 1;
    else skipped += 1;
  }
  return { written, skipped };
}

export async function learnIdentities(
  paths: MemoryPaths,
  rawEmails: Iterable<string>,
): Promise<IdentityMap> {
  const id = await readIdentity(paths);
  let dirty = false;
  for (const e of rawEmails) {
    if (!e || id[e]) continue;
    id[e] = e;
    dirty = true;
  }
  if (dirty) await writeIdentity(paths, id);
  return id;
}
