// Polling loop. Per channel:
//   1. fetch new messages + thread replies since cursor
//   2. fetch any new channels (delta vs cursor)
//   3. write atoms (dedup by id at write time)
//   4. advance cursor to max(ts) we observed
//
// One-shot mode (`runOnce`) does steps 1–4 once. Daemon mode (`runForever`)
// loops with config.poll_interval_sec between iterations.
//
// Thread / project decoration:
//   - Each Slack thread → 1 Tangerine thread `slack-<channel>-<thread_ts>`
//   - Channel name → optional project tag (configurable; see normalize.ts)

import type { SlackClient } from "./client.js";
import { makeClient } from "./client.js";
import { getToken } from "./auth.js";
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
import type { Atom, ChannelConfig } from "./types.js";
import { makeCtx } from "./normalize.js";
import { ingestMessages } from "./ingest/messages.js";
import { ingestNewChannels } from "./ingest/channels.js";

export interface PollOpts {
  memoryRoot?: string;
  /** If supplied, use instead of reading the keychain. Tests use this. */
  token?: string;
  /** Override client (tests). */
  client?: SlackClient;
  /** dry-run: do everything except write atoms or advance cursors. */
  dryRun?: boolean;
}

export interface ChannelPollResult {
  channel: string;
  channelName?: string;
  atomCount: number;
  written: number;
  skipped: number;
  newCursor: string | null;
  error?: string;
}

export interface PollResult {
  channels: ChannelPollResult[];
  totalAtoms: number;
  totalWritten: number;
  rateLimitRetryAfter: number | null;
}

async function getClient(opts: PollOpts): Promise<SlackClient> {
  if (opts.client) return opts.client;
  const token = opts.token ?? (await getToken("bot")) ?? (await getToken("user"));
  if (!token) {
    throw new Error("No Slack token configured. Run `tangerine-slack auth set` first.");
  }
  return makeClient(token);
}

async function pollOneChannel(
  client: SlackClient,
  paths: MemoryPaths,
  channel: ChannelConfig,
  dryRun: boolean,
): Promise<ChannelPollResult> {
  const cfg = await readConfig(paths);
  const identity = await readIdentity(paths);
  const cursors = await readCursors(paths);
  const ctx = makeCtx({ id: channel.id, name: channel.name }, identity, cfg);

  const since = cursors[channel.id] ?? channel.cursor ?? null;
  let newCursor = since;
  const allRawUserIds = new Set<string>();
  const atoms: Atom[] = [];

  try {
    const msgRes = await ingestMessages(client, channel, ctx, since);
    atoms.push(...msgRes.atoms);
    msgRes.rawUserIds.forEach((u) => allRawUserIds.add(u));
    if (msgRes.newCursor && (newCursor === null || msgRes.newCursor > newCursor)) {
      newCursor = msgRes.newCursor;
    }
  } catch (err) {
    return {
      channel: channel.id,
      channelName: channel.name,
      atomCount: atoms.length,
      written: 0,
      skipped: 0,
      newCursor,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Repo-level project tagging from config — splice into every atom.
  if (channel.projects && channel.projects.length > 0) {
    for (const a of atoms) {
      const merged = new Set([...a.refs.projects, ...channel.projects]);
      a.refs.projects = [...merged];
    }
  }

  if (!dryRun) {
    await learnIdentities(paths, allRawUserIds);
  }

  let written = 0;
  let skipped = 0;
  if (!dryRun) {
    const w = await writeAtoms(paths, atoms);
    written = w.written;
    skipped = w.skipped;
    // Advance cursor.
    const fresh = await readCursors(paths);
    if (newCursor) fresh[channel.id] = newCursor;
    await writeCursors(paths, fresh);
  }

  return {
    channel: channel.id,
    channelName: channel.name,
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
  const client = await getClient(opts);

  const channelResults: ChannelPollResult[] = [];
  for (const c of cfg.channels) {
    const res = await pollOneChannel(client, paths, c, opts.dryRun ?? false);
    channelResults.push(res);
  }

  // Channel-creation deltas (one cycle per poll).
  // We use a cursor stored as ".__channels_created_at" in the cursor map.
  if (cfg.channels.length > 0) {
    try {
      const cursors = await readCursors(paths);
      const sinceKey = "__channels_created_at__";
      const sinceEpoch = cursors[sinceKey] ? Number(cursors[sinceKey]) : null;
      const ctx = makeCtx({ id: "__system__", name: undefined }, await readIdentity(paths), cfg);
      const ch = await ingestNewChannels(client, ctx, sinceEpoch);
      if (ch.atoms.length > 0 && !opts.dryRun) {
        await writeAtoms(paths, ch.atoms);
      }
      // Advance cursor to "now" so we don't replay the same channel-list snapshot.
      if (!opts.dryRun) {
        const fresh = await readCursors(paths);
        fresh[sinceKey] = String(Math.floor(Date.now() / 1000));
        await writeCursors(paths, fresh);
      }
    } catch {
      // Non-fatal — channel discovery is best-effort.
    }
  }

  return {
    channels: channelResults,
    totalAtoms: channelResults.reduce((s, r) => s + r.atomCount, 0),
    totalWritten: channelResults.reduce((s, r) => s + r.written, 0),
    rateLimitRetryAfter: null,
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
      console.error(`[tangerine-slack] poll error: ${err instanceof Error ? err.message : String(err)}`);
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
