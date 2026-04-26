// Channel-message ingest. Per channel:
//   1. conversations.history       — top-level messages since cursor
//   2. for each parent w/ replies, conversations.replies — thread replies
//   3. emit one atom per message (root or reply)
//
// Cursor is the largest `ts` we've seen for the channel; we pass it as
// `oldest` on the next poll. Slack ts strings sort lexicographically as long
// as the integer part is the same width — they always are (10 digits since
// 2001), so string compare works.

import type { SlackClient } from "../client.js";
import type { Atom, ChannelConfig } from "../types.js";
import {
  normalizeMessage,
  normalizePin,
  type NormalizeCtx,
  type RawMessage,
  type RawPin,
} from "../normalize.js";

export interface IngestMessagesResult {
  atoms: Atom[];
  rawUserIds: Set<string>;
  /** Newest ts we observed; advance the per-channel cursor to this. */
  newCursor: string | null;
}

interface SlackMessageItem {
  type?: string;
  subtype?: string | null;
  ts: string;
  user?: string | null;
  text?: string | null;
  thread_ts?: string | null;
  reply_count?: number;
  reactions?: Array<{ name: string; count: number; users?: string[] }>;
  pinned_to?: string[];
  permalink?: string | null;
  team?: string | null;
}

interface ConversationsHistoryResponse {
  ok: boolean;
  error?: string;
  messages?: SlackMessageItem[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

interface ConversationsRepliesResponse {
  ok: boolean;
  error?: string;
  messages?: SlackMessageItem[];
  has_more?: boolean;
}

/** Map Slack subtypes we want to silently ignore (joins, leaves, etc.). */
const SKIP_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_archive",
  "channel_unarchive",
]);

function shouldKeep(m: SlackMessageItem): boolean {
  if (!m.ts) return false;
  if (m.type && m.type !== "message") return false;
  if (m.subtype && SKIP_SUBTYPES.has(m.subtype)) return false;
  return true;
}

function importanceFromReactions(
  m: SlackMessageItem,
  importanceReaction: string,
  importanceBoost: number,
): number | null {
  if (!m.reactions) return null;
  for (const r of m.reactions) {
    if (r.name === importanceReaction && r.count > 0) {
      return importanceBoost;
    }
  }
  return null;
}

export async function ingestMessages(
  client: SlackClient,
  channel: ChannelConfig,
  ctx: NormalizeCtx,
  since: string | null,
): Promise<IngestMessagesResult> {
  const atoms: Atom[] = [];
  const rawUserIds = new Set<string>();
  let newCursor: string | null = since;

  // Slack `oldest` is exclusive (well, `inclusive: false` by default), so we
  // pass our last-seen ts directly. First poll uses `null` → fetches recent.
  let cursor: string | undefined = undefined;
  // Pagination — keep walking until Slack runs out of messages.
  // Cap at 20 pages per poll to keep one cycle bounded.
  for (let page = 0; page < 20; page++) {
    const args: Record<string, unknown> = {
      channel: ctx.channel.id,
      limit: 100,
      inclusive: false,
    };
    if (since) args.oldest = since;
    if (cursor) args.cursor = cursor;
    // The WebClient's typed signatures require explicit `channel`, but our
    // `args` object always carries it; cast through `as never` to bypass the
    // structural-narrowing the lib does on optional pagination args.
    const res = (await (client.conversations.history as unknown as (a: Record<string, unknown>) => Promise<ConversationsHistoryResponse>)(args)) as ConversationsHistoryResponse;
    if (!res.ok) {
      throw new Error(`conversations.history failed: ${res.error ?? "unknown"}`);
    }
    const messages = res.messages ?? [];
    for (const m of messages) {
      if (!shouldKeep(m)) continue;
      if (m.user) rawUserIds.add(m.user);
      if (newCursor === null || m.ts > newCursor) newCursor = m.ts;

      // Importance bump from configured reaction (⭐ by default).
      const importance = importanceFromReactions(
        m,
        ctx.config.importance_reaction,
        ctx.config.importance_boost,
      );
      const localCtx: NormalizeCtx = importance != null ? { ...ctx, importanceOverride: importance } : ctx;

      const raw: RawMessage = {
        type: m.type,
        subtype: m.subtype ?? null,
        ts: m.ts,
        user: m.user ?? null,
        text: m.text ?? null,
        thread_ts: m.thread_ts ?? null,
        permalink: m.permalink ?? null,
        team: m.team ?? null,
      };
      atoms.push(normalizeMessage(raw, localCtx));

      // If this message is the parent of a thread, fetch replies.
      if ((m.reply_count ?? 0) > 0 && m.thread_ts !== null) {
        const repliesRes = (await client.conversations.replies({
          channel: ctx.channel.id,
          ts: m.ts,
          limit: 200,
          ...(since ? { oldest: since, inclusive: false } : {}),
        })) as ConversationsRepliesResponse;
        if (!repliesRes.ok) continue;
        for (const r of repliesRes.messages ?? []) {
          if (!shouldKeep(r)) continue;
          if (r.ts === m.ts) continue; // we already emitted the root
          if (r.user) rawUserIds.add(r.user);
          if (newCursor === null || r.ts > newCursor) newCursor = r.ts;
          const replyImportance = importanceFromReactions(
            r,
            ctx.config.importance_reaction,
            ctx.config.importance_boost,
          );
          const replyCtx: NormalizeCtx = replyImportance != null ? { ...ctx, importanceOverride: replyImportance } : ctx;
          atoms.push(
            normalizeMessage(
              {
                type: r.type,
                subtype: r.subtype ?? null,
                ts: r.ts,
                user: r.user ?? null,
                text: r.text ?? null,
                thread_ts: r.thread_ts ?? null,
                permalink: r.permalink ?? null,
                team: r.team ?? null,
              },
              replyCtx,
            ),
          );
        }
      }

      // Pin detection — `pinned_to` is an array of channel ids the message is
      // pinned to. If our channel is in there, emit a `decision` atom.
      if (Array.isArray(m.pinned_to) && m.pinned_to.includes(ctx.channel.id)) {
        const pin: RawPin = {
          pinned_ts: m.ts,
          pinned_by: m.user ?? null,
          message: {
            type: m.type,
            subtype: m.subtype ?? null,
            ts: m.ts,
            user: m.user ?? null,
            text: m.text ?? null,
            thread_ts: m.thread_ts ?? null,
            permalink: m.permalink ?? null,
          },
        };
        atoms.push(normalizePin(pin, ctx));
      }
    }
    if (!res.has_more) break;
    cursor = res.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  return { atoms, rawUserIds, newCursor };
}
