// Atom → memory tree writer.
//
// Layout under <memory>:
//   timeline/<YYYY-MM-DD>.md          chronological feed (one file per UTC day)
//   threads/<thread-id>.md            per-PR / per-issue feed
//   .tangerine/sources/github.config.json     repo + cursor state
//   .tangerine/sources/github.identity.json   GitHub login → Tangerine alias
//
// Atoms are appended in YAML-frontmatter + markdown form, separated by `\n---\n`.
//
// Dedup is per-file: before appending, we read the file and skip any atom whose
// `id:` already appears. Cheap-but-correct for the scales we care about
// (thousands of atoms per repo per month).
//
// TODO(module-a): once `tmi.event_router.EventRouter` lands in src/tmi/, swap
// the direct file writes here for `router.process(atom)`. The router will
// handle fan-out to people/projects/threads/timeline uniformly across sources.

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
    configFile: () => join(root, ".tangerine", "sources", "github.config.json"),
    identityFile: () => join(root, ".tangerine", "sources", "github.identity.json"),
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
    return { ...defaultConfig(), ...parsed, repos: parsed.repos ?? [] };
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
  if (atom.refs.github) {
    lines.push(`  github:`);
    lines.push(`    repo: ${yamlStr(atom.refs.github.repo)}`);
    if (atom.refs.github.pr !== undefined) lines.push(`    pr: ${atom.refs.github.pr}`);
    if (atom.refs.github.issue !== undefined) lines.push(`    issue: ${atom.refs.github.issue}`);
    if (atom.refs.github.comment_id !== undefined) lines.push(`    comment_id: ${atom.refs.github.comment_id}`);
    if (atom.refs.github.review_id !== undefined) lines.push(`    review_id: ${atom.refs.github.review_id}`);
    if (atom.refs.github.url) lines.push(`    url: ${yamlStr(atom.refs.github.url)}`);
  }
  lines.push(`  meeting: ${atom.refs.meeting === null ? "null" : yamlStr(atom.refs.meeting)}`);
  lines.push(`  decisions: [${atom.refs.decisions.map(yamlStr).join(", ")}]`);
  lines.push(`  people: [${atom.refs.people.map(yamlStr).join(", ")}]`);
  lines.push(`  projects: [${atom.refs.projects.map(yamlStr).join(", ")}]`);
  lines.push(`  threads: [${atom.refs.threads.map(yamlStr).join(", ")}]`);
  lines.push(`status: ${atom.status}`);
  lines.push(`sample: ${atom.sample ? "true" : "false"}`);
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
  // Cheap dedup — atoms are line-prefixed by `id: <atom.id>`. Check that exact line.
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

/**
 * Write a batch of atoms. Returns counts. Identity learning: any actor we
 * haven't seen before gets a self-mapping appended to the identity map.
 */
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
 * Update identity map with any unmapped GitHub logins encountered. We map
 * the login to itself by default — user can later remap by editing the file.
 */
export async function learnIdentities(
  paths: MemoryPaths,
  rawLogins: Iterable<string>,
): Promise<IdentityMap> {
  const id = await readIdentity(paths);
  let dirty = false;
  for (const login of rawLogins) {
    if (!login || id[login]) continue;
    id[login] = login;
    dirty = true;
  }
  if (dirty) await writeIdentity(paths, id);
  return id;
}
