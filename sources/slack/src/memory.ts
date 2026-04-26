// Atom → memory tree writer.
//
// Layout under <memory>:
//   timeline/<YYYY-MM-DD>.md          chronological feed (one file per UTC day)
//   threads/<thread-id>.md            per-Slack-thread feed
//   .tangerine/sources/slack.config.json     channel + cursor state
//   .tangerine/sources/slack.cursor.json     per-channel last-poll cursor
//   .tangerine/sources/slack.identity.json   Slack user id → Tangerine alias
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
// sources. We pre-emptively call `routeViaPython()` from poll.ts when a
// `--event-router` flag is set, so the swap is a 5-line change.

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
    configFile: () => join(root, ".tangerine", "sources", "slack.config.json"),
    cursorFile: () => join(root, ".tangerine", "sources", "slack.cursor.json"),
    identityFile: () => join(root, ".tangerine", "sources", "slack.identity.json"),
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
    return { ...defaultConfig(), ...parsed, channels: parsed.channels ?? [] };
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

/** Per-channel cursor map; persisted alongside config so a deleted config
 *  doesn't replay an entire channel's history. */
export interface CursorMap {
  /** channel id → last seen ts (slack ts string) */
  [channelId: string]: string;
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
  // Hand-rolled YAML — the schema is small, fixed, and we want stable output.
  const lines: string[] = ["---"];
  lines.push(`id: ${atom.id}`);
  lines.push(`ts: ${atom.ts}`);
  lines.push(`source: ${atom.source}`);
  lines.push(`actor: ${atom.actor}`);
  lines.push(`actors: [${atom.actors.map(yamlStr).join(", ")}]`);
  lines.push(`kind: ${atom.kind}`);
  lines.push(`refs:`);
  if (atom.refs.slack) {
    lines.push(`  slack:`);
    if (atom.refs.slack.team) lines.push(`    team: ${yamlStr(atom.refs.slack.team)}`);
    lines.push(`    channel: ${yamlStr(atom.refs.slack.channel)}`);
    if (atom.refs.slack.channel_name) lines.push(`    channel_name: ${yamlStr(atom.refs.slack.channel_name)}`);
    if (atom.refs.slack.message_ts) lines.push(`    message_ts: ${yamlStr(atom.refs.slack.message_ts)}`);
    if (atom.refs.slack.thread_ts) lines.push(`    thread_ts: ${yamlStr(atom.refs.slack.thread_ts)}`);
    if (atom.refs.slack.reaction) lines.push(`    reaction: ${yamlStr(atom.refs.slack.reaction)}`);
    if (atom.refs.slack.url) lines.push(`    url: ${yamlStr(atom.refs.slack.url)}`);
  }
  lines.push(`  meeting: ${atom.refs.meeting === null ? "null" : yamlStr(atom.refs.meeting)}`);
  lines.push(`  decisions: [${atom.refs.decisions.map(yamlStr).join(", ")}]`);
  lines.push(`  people: [${atom.refs.people.map(yamlStr).join(", ")}]`);
  lines.push(`  projects: [${atom.refs.projects.map(yamlStr).join(", ")}]`);
  lines.push(`  threads: [${atom.refs.threads.map(yamlStr).join(", ")}]`);
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
  // Quote anything that's not pure word characters to keep YAML happy.
  if (/^[a-zA-Z0-9_./:@-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

/** UTC date stamp YYYY-MM-DD from an RFC 3339 ts. */
export function utcDate(ts: string): string {
  return ts.slice(0, 10);
}

/**
 * Append an atom to a file unless its id is already present. Returns true if
 * we wrote something, false if it was a dup. Idempotent across runs.
 */
async function appendAtomIfNew(filePath: string, atom: Atom): Promise<boolean> {
  ensureDir(filePath);
  const md = atomToMarkdown(atom);
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // Cheap dedup — atoms are line-prefixed by `id: <atom.id>`.
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

/** Write atom to its day's timeline file AND each thread file in refs.threads. */
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

/** Write a batch of atoms. Identity learning happens via `learnIdentities()`. */
export async function writeAtoms(
  paths: MemoryPaths,
  atoms: Atom[],
): Promise<{ written: number; skipped: number }> {
  let written = 0;
  let skipped = 0;
  // Sort chronologically so timeline files stay ordered.
  const sorted = [...atoms].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const a of sorted) {
    const r = await writeAtom(paths, a);
    if (r.wroteTimeline || r.wroteThreadFiles > 0) written += 1;
    else skipped += 1;
  }
  return { written, skipped };
}

/**
 * Update identity map with any unmapped Slack user ids encountered. We map
 * the id to itself by default — user can later remap by editing the file.
 */
export async function learnIdentities(
  paths: MemoryPaths,
  rawUserIds: Iterable<string>,
): Promise<IdentityMap> {
  const id = await readIdentity(paths);
  let dirty = false;
  for (const u of rawUserIds) {
    if (!u || id[u]) continue;
    id[u] = u;
    dirty = true;
  }
  if (dirty) await writeIdentity(paths, id);
  return id;
}
