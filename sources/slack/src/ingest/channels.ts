// Channel-creation ingest. Light-weight: we list channels once at startup so
// `tangerine-slack channels list --remote` can show the user what's available
// to add. We do NOT emit a `system` atom for every existing channel — that
// would spam the timeline. Only newly-created channels (delta vs cursor)
// produce atoms.

import type { SlackClient } from "../client.js";
import type { Atom } from "../types.js";
import {
  normalizeChannelCreated,
  type NormalizeCtx,
  type RawChannelCreated,
} from "../normalize.js";

export interface IngestChannelsResult {
  atoms: Atom[];
  rawUserIds: Set<string>;
}

interface ChannelItem {
  id: string;
  name: string;
  creator?: string | null;
  created?: number;
  is_archived?: boolean;
}

interface ConversationsListResponse {
  ok: boolean;
  error?: string;
  channels?: ChannelItem[];
  response_metadata?: { next_cursor?: string };
}

/**
 * List channels and emit a `system` atom for any whose `created` is newer
 * than `since` (epoch seconds). The first poll's `since` is `null`, in
 * which case we don't emit anything — only deltas.
 */
export async function ingestNewChannels(
  client: SlackClient,
  ctx: NormalizeCtx,
  sinceEpochSec: number | null,
): Promise<IngestChannelsResult> {
  const atoms: Atom[] = [];
  const rawUserIds = new Set<string>();

  let cursor: string | undefined = undefined;
  for (let page = 0; page < 10; page++) {
    const res = (await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })) as ConversationsListResponse;
    if (!res.ok) {
      throw new Error(`conversations.list failed: ${res.error ?? "unknown"}`);
    }
    for (const c of res.channels ?? []) {
      if (!c.created) continue;
      if (sinceEpochSec !== null && c.created <= sinceEpochSec) continue;
      if (c.creator) rawUserIds.add(c.creator);
      const raw: RawChannelCreated = {
        id: c.id,
        name: c.name,
        creator: c.creator ?? null,
        created: c.created,
      };
      atoms.push(normalizeChannelCreated(raw, ctx));
    }
    cursor = res.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return { atoms, rawUserIds };
}

/** List channels for the CLI `channels list --remote` command. Read-only. */
export async function listRemoteChannels(client: SlackClient): Promise<ChannelItem[]> {
  const out: ChannelItem[] = [];
  let cursor: string | undefined = undefined;
  for (let page = 0; page < 10; page++) {
    const res = (await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })) as ConversationsListResponse;
    if (!res.ok) throw new Error(`conversations.list failed: ${res.error ?? "unknown"}`);
    for (const c of res.channels ?? []) {
      out.push(c);
    }
    cursor = res.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return out;
}
