// Polling loop. Per repo:
//   1. fetch PRs since cursor
//   2. fetch issues since cursor
//   3. fetch comments since cursor
//   4. fetch reviews for the PRs we just touched
//   5. write atoms (dedup by id at write time)
//   6. advance cursor to max(updated_at) we observed
//
// One-shot mode (`runOnce`) does steps 1–6 once. Daemon mode (`runForever`)
// loops with config.poll_interval_sec between iterations and respects rate
// limit signals.
//
// Decoration: comments + reviews don't carry repo-level project tags. We
// decorate them after the fact using the parent PR/issue's projects.

import type { GhClient } from "./client.js";
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
import type { Atom, RepoConfig } from "./types.js";
import { makeCtx } from "./normalize.js";
import { ingestPrs } from "./ingest/prs.js";
import { ingestIssues } from "./ingest/issues.js";
import { ingestComments } from "./ingest/comments.js";
import { ingestReviewsForPrs } from "./ingest/reviews.js";

export interface PollOpts {
  memoryRoot?: string;
  /** If supplied, use instead of reading the keychain. Tests use this. */
  token?: string;
  /** Override client (tests). */
  client?: GhClient;
  /** dry-run: do everything except write atoms or advance cursors. */
  dryRun?: boolean;
}

export interface RepoPollResult {
  repo: string;
  atomCount: number;
  written: number;
  skipped: number;
  newCursor: string | null;
  error?: string;
}

export interface PollResult {
  repos: RepoPollResult[];
  totalAtoms: number;
  totalWritten: number;
  rateLimitRemaining: number | null;
}

async function getClient(opts: PollOpts): Promise<GhClient> {
  if (opts.client) return opts.client;
  const token = opts.token ?? (await getToken());
  if (!token) {
    // Public-read mode — caller (CLI) opts in via TANGERINE_GH_PUBLIC=1.
    // Useful for first-run "kick the tires" against open-source repos.
    if (process.env.TANGERINE_GH_PUBLIC === "1") {
      return makeClient("");
    }
    throw new Error("No GitHub token configured. Run `tangerine-github auth set` (or set TANGERINE_GH_PUBLIC=1 for public-only).");
  }
  return makeClient(token);
}

/** Decorate downstream atoms (comments/reviews) with their parent's projects. */
function decorateProjects(atoms: Atom[]): void {
  const projByThread = new Map<string, string[]>();
  // First pass: build thread → projects from parent atoms (pr_opened, issue_opened).
  for (const a of atoms) {
    if (a.kind === "pr_opened" || a.kind === "issue_opened") {
      for (const t of a.refs.threads) {
        projByThread.set(t, a.refs.projects);
      }
    }
  }
  // Second pass: fill empty projects on children.
  for (const a of atoms) {
    if (a.refs.projects.length > 0) continue;
    const merged = new Set<string>();
    for (const t of a.refs.threads) {
      const p = projByThread.get(t);
      if (p) p.forEach((x) => merged.add(x));
    }
    if (merged.size > 0) a.refs.projects = [...merged];
  }
}

async function pollOneRepo(
  client: GhClient,
  paths: MemoryPaths,
  repo: RepoConfig,
  dryRun: boolean,
): Promise<RepoPollResult> {
  const [owner, name] = repo.name.split("/");
  if (!owner || !name) {
    return { repo: repo.name, atomCount: 0, written: 0, skipped: 0, newCursor: null, error: "invalid repo name (want owner/repo)" };
  }

  const cfg = await readConfig(paths);
  const identity = await readIdentity(paths);
  const ctx = makeCtx(repo.name, identity, cfg);
  // Apply repo-level project tagging before extraction does its work.
  if (repo.projects && repo.projects.length > 0) {
    // We bake repo.projects into config-level project_label_prefix + title regex,
    // but the simplest path is to splice them in after normalization. See decorate below.
  }

  const since = repo.cursor ?? null;
  let cursor = since;
  let allRawLogins = new Set<string>();
  const atoms: Atom[] = [];

  try {
    const prRes = await ingestPrs(client, owner, name, ctx, since);
    atoms.push(...prRes.atoms);
    prRes.rawLogins.forEach((l) => allRawLogins.add(l));
    if (prRes.newCursor && (cursor === null || prRes.newCursor > cursor)) cursor = prRes.newCursor;

    const issueRes = await ingestIssues(client, owner, name, ctx, since);
    atoms.push(...issueRes.atoms);
    issueRes.rawLogins.forEach((l) => allRawLogins.add(l));
    if (issueRes.newCursor && (cursor === null || issueRes.newCursor > cursor)) cursor = issueRes.newCursor;

    const commentRes = await ingestComments(client, owner, name, ctx, since);
    atoms.push(...commentRes.atoms);
    commentRes.rawLogins.forEach((l) => allRawLogins.add(l));
    if (commentRes.newCursor && (cursor === null || commentRes.newCursor > cursor)) cursor = commentRes.newCursor;

    // Reviews: only for the PRs we observed.
    const candidatePrs = prRes.atoms
      .filter((a) => a.kind === "pr_opened")
      .map((a) => ({ number: a.refs.github!.pr!, title: extractTitle(a.body) }));
    const reviewRes = await ingestReviewsForPrs(client, owner, name, ctx, candidatePrs, since);
    atoms.push(...reviewRes.atoms);
    reviewRes.rawLogins.forEach((l) => allRawLogins.add(l));
    if (reviewRes.newCursor && (cursor === null || reviewRes.newCursor > cursor)) cursor = reviewRes.newCursor;
  } catch (err) {
    return {
      repo: repo.name,
      atomCount: atoms.length,
      written: 0,
      skipped: 0,
      newCursor: cursor,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Repo-level project tagging from config — splice into every atom.
  if (repo.projects && repo.projects.length > 0) {
    for (const a of atoms) {
      const merged = new Set([...a.refs.projects, ...repo.projects]);
      a.refs.projects = [...merged];
    }
  }
  decorateProjects(atoms);

  // Identity learning (always — even on dry-run? — yes; it's not output).
  if (!dryRun) {
    await learnIdentities(paths, allRawLogins);
  }

  let written = 0;
  let skipped = 0;
  if (!dryRun) {
    const w = await writeAtoms(paths, atoms);
    written = w.written;
    skipped = w.skipped;
    // Advance cursor.
    const fresh = await readConfig(paths);
    fresh.repos = fresh.repos.map((r) => (r.name === repo.name ? { ...r, cursor: cursor ?? r.cursor } : r));
    await writeConfig(paths, fresh);
  } else {
    // For dry-run, "written" counts atoms that aren't dups in the existing files.
    // We don't actually look — surface 0 to make the distinction obvious.
    written = 0;
    skipped = 0;
  }

  return {
    repo: repo.name,
    atomCount: atoms.length,
    written,
    skipped,
    newCursor: cursor,
  };
}

function extractTitle(body: string): string | undefined {
  // pr_opened body starts with: **actor** opened PR #N (h → b): _Title_…
  const m = /_(.+?)_/.exec(body);
  return m?.[1];
}

export async function runOnce(opts: PollOpts = {}): Promise<PollResult> {
  const root = opts.memoryRoot ?? defaultMemoryRoot();
  const paths = makePaths(root);
  const cfg = await readConfig(paths);
  const client = await getClient(opts);

  const repoResults: RepoPollResult[] = [];
  for (const r of cfg.repos) {
    const res = await pollOneRepo(client, paths, r, opts.dryRun ?? false);
    repoResults.push(res);
  }

  return {
    repos: repoResults,
    totalAtoms: repoResults.reduce((s, r) => s + r.atomCount, 0),
    totalWritten: repoResults.reduce((s, r) => s + r.written, 0),
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
      // Backoff if any repo signaled rate trouble (poll-level estimate).
      const back = rateLimitBackoffMs(r.rateLimitRemaining, null);
      if (back > 0) await sleep(back, signal);
    } catch (err) {
      // Log but don't crash the daemon; next iteration will retry.
      // eslint-disable-next-line no-console
      console.error(`[tangerine-github] poll error: ${err instanceof Error ? err.message : String(err)}`);
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
