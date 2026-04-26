// Atom → Module A event_router (via tmi.daemon_cli emit-atom subprocess).
//
// Layout under <memory> (Module A writes timeline / threads / people /
// projects; this connector owns config + identity).
//
// Same shape as sources/github/src/memory.ts — see that file for the
// rationale on why we shell out to Python instead of writing in Node.

import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import * as os from "node:os";
import type { Atom, IdentityMap, SourceConfig } from "./types.js";
import { defaultConfig } from "./types.js";

export const ATOM_SEPARATOR = "\n---\n";

export interface MemoryPaths {
  root: string;
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
    configFile: () => join(root, ".tangerine", "sources", "linear.config.json"),
    identityFile: () => join(root, ".tangerine", "sources", "linear.identity.json"),
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
    return { ...defaultConfig(), ...parsed, teams: parsed.teams ?? [] };
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

/** Update the identity map with any unmapped Linear handles encountered.
 *  Self-maps unknowns so atoms still emit with a usable actor; user can
 *  remap later by editing the file. */
export async function learnIdentities(
  paths: MemoryPaths,
  rawHandles: Iterable<string>,
): Promise<IdentityMap> {
  const id = await readIdentity(paths);
  let dirty = false;
  for (const h of rawHandles) {
    if (!h || id[h]) continue;
    id[h] = h;
    dirty = true;
  }
  if (dirty) await writeIdentity(paths, id);
  return id;
}

// ----------------------------------------------------------------------
// Atom IO — routes through Module A via ``tmi.daemon_cli emit-atom``

export type AtomRouter = (memoryRoot: string, atom: Atom) => Promise<EmitAtomResult>;

export interface EmitAtomResult {
  events: number;
  skipped: number;
}

let _routerOverride: AtomRouter | null = null;

export function setRouterForTesting(impl: AtomRouter | null): void {
  _routerOverride = impl;
}

function pythonBin(): string {
  return process.env.PYTHON_BIN || "python";
}

async function spawnEmitAtom(memoryRoot: string, atom: Atom): Promise<EmitAtomResult> {
  return new Promise<EmitAtomResult>((resolve, reject) => {
    const child = spawn(
      pythonBin(),
      ["-m", "tmi.daemon_cli", "emit-atom", "--memory-root", memoryRoot],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => stderrChunks.push(c));
    child.once("error", reject);
    child.once("close", (code) => {
      const out = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const err = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(`tmi.daemon_cli emit-atom exit ${code}: ${err || "(no stderr)"}`));
        return;
      }
      try {
        const parsed = JSON.parse(out) as { events?: number; skipped?: number };
        resolve({ events: parsed.events ?? 0, skipped: parsed.skipped ?? 0 });
      } catch {
        reject(new Error(`tmi.daemon_cli emit-atom returned non-JSON: ${out.slice(0, 500)}`));
      }
    });
    child.stdin.write(JSON.stringify(atomToPayload(atom)));
    child.stdin.end();
  });
}

function atomToPayload(atom: Atom): Record<string, unknown> {
  return {
    id: atom.id,
    ts: atom.ts,
    source: atom.source,
    actor: atom.actor,
    actors: atom.actors,
    kind: atom.kind,
    source_id: atom.source_id,
    body: atom.body,
    status: atom.status,
    sample: atom.sample,
    refs: {
      meeting: atom.refs.meeting,
      decisions: atom.refs.decisions,
      people: atom.refs.people,
      projects: atom.refs.projects,
      threads: atom.refs.threads,
      linear: atom.refs.linear,
    },
    embedding: atom.embedding ?? null,
    concepts: atom.concepts ?? [],
    confidence: atom.confidence ?? 1.0,
    alternatives: atom.alternatives ?? [],
    source_count: atom.source_count ?? 1,
    reasoning_notes: atom.reasoning_notes ?? null,
    sentiment: atom.sentiment ?? null,
    importance: atom.importance ?? null,
  };
}

export interface WriteResult {
  wroteTimeline: boolean;
  wroteThreadFiles: number;
}

export async function writeAtom(paths: MemoryPaths, atom: Atom): Promise<WriteResult> {
  const router = _routerOverride ?? ((root: string, a: Atom) => spawnEmitAtom(root, a));
  const res = await router(paths.root, atom);
  const wrote = res.events > 0 && res.skipped === 0;
  return {
    wroteTimeline: wrote,
    wroteThreadFiles: wrote ? atom.refs.threads.length : 0,
  };
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
    if (r.wroteTimeline) written += 1;
    else skipped += 1;
  }
  return { written, skipped };
}

export function _atomToPayloadForTesting(atom: Atom): Record<string, unknown> {
  return atomToPayload(atom);
}
