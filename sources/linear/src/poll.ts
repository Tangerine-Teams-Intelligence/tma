// Polling loop. Per team:
//   1. fetch issues since cursor
//   2. fetch comments since cursor
//   3. write atoms (Module A handles dedup at the router by canonical id)
//   4. advance cursor to max(updatedAt) we observed
//
// Linear webhooks are a v2 feature (faster than poll, but requires the user
// to host an HTTP endpoint and configure a webhook in Linear's settings).
// Polling is the default ingest mode; webhook lives in src/ingest/ if we
// add it later, parallel to sources/github/src/ingest/webhook.ts.

import type { LinearLike } from "./client.js";
import { makeClient, rateLimitBackoffMs } from "./client.js";
import { getToken } from "./auth.js";
import {
  defaultMemoryRoot,
  makePaths,
  readConfig,
  readIdentity,
  writeConfig,
  writeAtoms,
  learnIdentities,
  type MemoryPaths,
} from "./memory.js";
import type { Atom, TeamConfig } from "./types.js";
import { makeCtx } from "./normalize.js";
import { ingestIssues } from "./ingest/issues.js";
import { ingestComments } from "./ingest/comments.js";

export interface PollOpts {
  memoryRoot?: string;
  /** If supplied, use instead of reading the keychain. Tests use this. */
  token?: string;
  /** Override client (tests). */
  client?: LinearLike;
  /** dry-run: do everything except write atoms or advance cursors. */
  dryRun?: boolean;
}

export interface TeamPollResult {
  team: string;
  atomCount: number;
  written: number;
  skipped: number;
  newCursor: string | null;
  error?: string;
}

export interface PollResult {
  teams: TeamPollResult[];
  totalAtoms: number;
  totalWritten: number;
  rateLimitRemaining: number | null;
}

async function getClient(opts: PollOpts): Promise<LinearLike> {
  if (opts.client) return opts.client;
  const token = opts.token ?? (await getToken());
  if (!token) {
    throw new Error("No Linear PAT configured. Run `tangerine-linear auth set`.");
  }
  return makeClient(token);
}

/** Decorate downstream atoms (comments) with their parent issue's projects.
 *  We use the issue refs.linear.issue_id as the join key. */
function decorateProjects(atoms: Atom[]): void {
  const projByIssue = new Map<string, string[]>();
  for (const a of atoms) {
    if (a.kind === "ticket_event" && a.refs.linear?.issue_id) {
      projByIssue.set(a.refs.linear.issue_id, a.refs.projects);
    }
  }
  for (const a of atoms) {
    if (a.refs.projects.length > 0) continue;
    const issueId = a.refs.linear?.issue_id;
    if (!issueId) continue;
    const p = projByIssue.get(issueId);
    if (p && p.length > 0) a.refs.projects = [...p];
  }
}

async function pollOneTeam(
  client: LinearLike,
  paths: MemoryPaths,
  team: TeamConfig,
  dryRun: boolean,
): Promise<TeamPollResult> {
  const cfg = await readConfig(paths);
  const identity = await readIdentity(paths);
  const ctx = makeCtx(team, identity, cfg);

  const since = team.cursor ?? null;
  let cursor = since;
  const allRawHandles = new Set<string>();
  const atoms: Atom[] = [];

  try {
    const issuesRes = await ingestIssues(client, ctx, since);
    atoms.push(...issuesRes.atoms);
    issuesRes.rawHandles.forEach((h) => allRawHandles.add(h));
    if (issuesRes.newCursor && (cursor === null || issuesRes.newCursor > cursor)) cursor = issuesRes.newCursor;

    const commentsRes = await ingestComments(client, ctx, since);
    atoms.push(...commentsRes.atoms);
    commentsRes.rawHandles.forEach((h) => allRawHandles.add(h));
    if (commentsRes.newCursor && (cursor === null || commentsRes.newCursor > cursor)) cursor = commentsRes.newCursor;
  } catch (err) {
    return {
      team: team.key,
      atomCount: atoms.length,
      written: 0,
      skipped: 0,
      newCursor: cursor,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  decorateProjects(atoms);

  if (!dryRun) {
    await learnIdentities(paths, allRawHandles);
  }

  let written = 0;
  let skipped = 0;
  if (!dryRun) {
    const w = await writeAtoms(paths, atoms);
    written = w.written;
    skipped = w.skipped;
    const fresh = await readConfig(paths);
    fresh.teams = fresh.teams.map((t) => (t.uuid === team.uuid ? { ...t, cursor: cursor ?? t.cursor } : t));
    await writeConfig(paths, fresh);
  }

  return {
    team: team.key,
    atomCount: atoms.length,
    written,
    skipped,
    newCursor: cursor,
  };
}

export async function runOnce(opts: PollOpts = {}): Promise<PollResult> {
  const root = opts.memoryRoot ?? defaultMemoryRoot();
  const paths = makePaths(root);
  const cfg = await readConfig(paths);
  const client = await getClient(opts);

  const teamResults: TeamPollResult[] = [];
  for (const t of cfg.teams) {
    const res = await pollOneTeam(client, paths, t, opts.dryRun ?? false);
    teamResults.push(res);
  }

  return {
    teams: teamResults,
    totalAtoms: teamResults.reduce((s, r) => s + r.atomCount, 0),
    totalWritten: teamResults.reduce((s, r) => s + r.written, 0),
    rateLimitRemaining: null,
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
      const r = await runOnce(opts);
      const back = rateLimitBackoffMs(r.rateLimitRemaining, null);
      if (back > 0) await sleep(back, signal);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[tangerine-linear] poll error: ${err instanceof Error ? err.message : String(err)}`);
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
