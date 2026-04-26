// Atom → Module A event_router (via tmi.daemon_cli emit-atom subprocess).
//
// Layout under <memory> (written by Module A, not us):
//   timeline/<YYYY-MM-DD>.md          chronological feed
//   threads/<thread-id>.md            per-PR / per-issue feed
//   people/<alias>.md                 Timeline mentions for each person
//   projects/<slug>.md                Timeline mentions for each project
//   .tangerine/timeline.json          atom index
//   .tangerine/sources/github.config.json     repo + cursor state (us)
//   .tangerine/sources/github.identity.json   GitHub login → Tangerine alias (us)
//
// We still own config + identity files (the connector's bookkeeping). All
// timeline / threads / people / projects fan-out is done by Module A's
// event_router, accessed through ``python -m tmi.daemon_cli emit-atom``.
//
// Why the subprocess hop instead of an in-Node atom writer? Single source of
// truth: the canonical id formula, AGI hook validation, on_atom dispatch,
// and entity fan-out all live in Python. Re-implementing them in Node would
// drift. The subprocess cost is fine — emit-atom runs in <50ms and only
// fires once per atom (poll cycles batch-process, not per-row).

import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import * as os from "node:os";
import type { Atom, IdentityMap, SourceConfig } from "./types.js";
import { defaultConfig } from "./types.js";

/** Kept for backward-compat exports; Module A is the writer now. */
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
// Atom IO — routes through Module A via ``tmi.daemon_cli emit-atom``

/** Module-A daemon-CLI invocation. Module A handles fan-out + AGI hook
 *  validation + on_atom dispatch. ``module a wins.``
 *
 *  Override paths in tests via the `routerOverride` parameter to keep them
 *  hermetic (no Python needed). */
export type AtomRouter = (memoryRoot: string, atom: Atom) => Promise<EmitAtomResult>;

export interface EmitAtomResult {
  /** Always 1 if Module A accepted the payload (validates + writes). */
  events: number;
  /** Module A returns 1 if the atom id collided with an existing one. */
  skipped: number;
}

let _routerOverride: AtomRouter | null = null;

/** Tests inject a deterministic router so they don't need Python. */
export function setRouterForTesting(impl: AtomRouter | null): void {
  _routerOverride = impl;
}

/** Read the python binary to invoke. Honors PYTHON_BIN env var. */
function pythonBin(): string {
  return process.env.PYTHON_BIN || "python";
}

/** Invoke ``python -m tmi.daemon_cli emit-atom`` with the atom on stdin.
 *  We use stdin (not --atom-json) because atoms can exceed Windows' command
 *  line length cap when bodies are long. Returns parsed JSON from stdout. */
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
        const parsed = JSON.parse(out) as {
          op?: string;
          events?: number;
          skipped?: number;
        };
        resolve({
          events: parsed.events ?? 0,
          skipped: parsed.skipped ?? 0,
        });
      } catch (e) {
        reject(new Error(`tmi.daemon_cli emit-atom returned non-JSON: ${out.slice(0, 500)}`));
      }
    });
    child.stdin.write(JSON.stringify(atom));
    child.stdin.end();
  });
}

/** Build the JSON payload Module A's emit-atom subcommand expects. */
function atomToPayload(atom: Atom): Record<string, unknown> {
  // Module A's payload contract is a flat dict (see daemon_cli._build_event_from_payload).
  // We pass through everything the connector knows; Module A injects AGI defaults
  // for any missing future-fields via validate_atom().
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
      // github sub-ref isn't in Module A's stock refs vocabulary. We let it
      // travel through; daemon_cli ignores unknown ref keys today and Stage 2
      // can promote the GitHub-specific shape to a typed sub-namespace later.
      github: atom.refs.github,
    },
    // AGI defaults — Module A would inject these too via validate_atom, but
    // sending them explicitly keeps the wire format obvious.
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

/** UTC date stamp YYYY-MM-DD from an RFC 3339 ts. */
export function utcDate(ts: string): string {
  return ts.slice(0, 10);
}

export interface WriteResult {
  /** Module A wrote a fresh entry to the timeline (true) or it was a dup (false). */
  wroteTimeline: boolean;
  /** Always equals refs.threads.length on success — Module A fans out once
   *  per thread / person / project. We surface the threads count here for
   *  back-compat with the old per-thread report. */
  wroteThreadFiles: number;
}

/** Hand a single atom to Module A. */
export async function writeAtom(paths: MemoryPaths, atom: Atom): Promise<WriteResult> {
  const router = _routerOverride ?? ((root: string, a: Atom) => spawnEmitAtom(root, a));
  // Pass the structured atom through the router; payload conversion happens
  // either in spawnEmitAtom (real path) or inside the test override.
  const res = await router(paths.root, atom);
  const wrote = res.events > 0 && res.skipped === 0;
  return {
    wroteTimeline: wrote,
    wroteThreadFiles: wrote ? atom.refs.threads.length : 0,
  };
}

/** Hand a batch of atoms to Module A in chronological order. */
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

/** Internal: exposed for tests that want to inspect the wire payload. */
export function _atomToPayloadForTesting(atom: Atom): Record<string, unknown> {
  return atomToPayload(atom);
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
