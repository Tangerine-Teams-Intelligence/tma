// Slack event payloads → Tangerine atoms.
//
// We hand-roll the mapping for each event family rather than reading a
// schema. Reasons:
//  - Slack adds nullable fields constantly; explicit code is easier to debug
//    than a JSON Schema validator that silently drops new fields.
//  - The atom body is a small piece of human-readable markdown — building it
//    inline is clearer than templating.
//
// Each `normalize<X>` function takes the raw Slack object, the parent ref
// (channel id+name), and the resolution context (identity map + project
// detection rules), and returns one Atom.

import {
  defaultAgi,
  type Atom,
  type AtomKind,
  type AtomRefs,
  type AgiHooks,
  type IdentityMap,
  type SourceConfig,
} from "./types.js";

export interface NormalizeCtx {
  channel: { id: string; name?: string };
  identity: IdentityMap;
  config: SourceConfig;
  /** Default thread id factory; each kind builds its own. */
  threadIdFor(channelId: string, threadTs: string): string;
  /** Optional importance bump from a ⭐ reaction (set during reaction ingest). */
  importanceOverride?: number | null;
}

export function makeCtx(
  channel: { id: string; name?: string },
  identity: IdentityMap,
  config: SourceConfig,
): NormalizeCtx {
  return {
    channel,
    identity,
    config,
    threadIdFor: (cid, threadTs) => `slack-${cid.toLowerCase()}-${threadTs.replace(".", "-")}`,
  };
}

/** Resolve a Slack user id → Tangerine alias. Unknown ids map to themselves
 *  (caller is responsible for persisting that back to identity.json). */
export function aliasFor(userId: string | null | undefined, identity: IdentityMap): string {
  if (!userId) return "unknown";
  const mapped = identity[userId];
  return mapped && mapped.length > 0 ? mapped : userId;
}

/**
 * Find <@U…> mentions in slack message text. Returns aliases (resolved).
 * Excludes the actor.
 */
export function extractMentions(text: string | null | undefined, identity: IdentityMap): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const re = /<@(U[A-Z0-9]+)(?:\|[^>]+)?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.add(aliasFor(m[1], identity));
  }
  return [...out];
}

/**
 * Simple project detection from the channel name. e.g. `#eng-v1-launch` →
 * project `v1-launch` (the part after the leading prefix). The project map
 * lives in config; for now we just strip a leading `eng-`/`proj-` prefix.
 *
 * Configurable mapping is the obvious Stage 2 follow-up; for now this is the
 * minimal viable channel→project link the README describes.
 */
export function projectsForChannel(channelName: string | undefined, _cfg: SourceConfig): string[] {
  if (!channelName) return [];
  // Strip common prefixes; surface the remainder as a project tag.
  const stripped = channelName.replace(/^(eng|proj|prj|team)[-_]/, "");
  if (stripped && stripped !== channelName) {
    return [stripped];
  }
  return [];
}

/**
 * Decision sniffing — looks for verbs that strongly imply a settled choice.
 * Mirrors the GitHub source's regex so cross-source decisions surface
 * consistently in Module C (the inbox).
 */
const DECISION_RX = /(\bdecided\b|\bagreed\b|\bwe will go with\b|\bwe'll go with\b|\blet's go with\b|\blocked in\b|\bconclusion:|\bgoing with\b)/i;
export function looksLikeDecision(body: string | null | undefined): boolean {
  if (!body) return false;
  return DECISION_RX.test(body);
}

function buildRefs(opts: {
  slack: NonNullable<AtomRefs["slack"]>;
  people: string[];
  projects: string[];
  threads: string[];
}): AtomRefs {
  return {
    slack: opts.slack,
    meeting: null,
    decisions: [],
    people: opts.people,
    projects: opts.projects,
    threads: opts.threads,
  };
}

function buildAgi(overrides: Partial<AgiHooks> = {}): AgiHooks {
  return { ...defaultAgi(), ...overrides };
}

/** Slack ts (e.g. "1714134567.123456") → RFC 3339 UTC. */
export function slackTsToIso(ts: string | null | undefined, fallback: Date = new Date()): string {
  if (!ts) return fallback.toISOString();
  const seconds = Number(String(ts).split(".")[0]);
  if (!Number.isFinite(seconds)) return fallback.toISOString();
  return new Date(seconds * 1000).toISOString();
}

// ----------------------------------------------------------------------
// Message (channel post or thread reply)

export interface RawMessage {
  type?: string;            // typically "message"
  subtype?: string | null;  // "channel_join", "bot_message", etc.
  ts: string;
  user: string | null;
  text: string | null;
  thread_ts?: string | null;
  permalink?: string | null;
  team?: string | null;
}

export function normalizeMessage(raw: RawMessage, ctx: NormalizeCtx): Atom {
  const actor = aliasFor(raw.user, ctx.identity);
  const mentions = extractMentions(raw.text, ctx.identity);
  const actors = uniq([actor, ...mentions]);
  const threadTs = raw.thread_ts ?? raw.ts;
  const thread = ctx.threadIdFor(ctx.channel.id, threadTs);
  const projects = projectsForChannel(ctx.channel.name, ctx.config);
  const isReply = !!raw.thread_ts && raw.thread_ts !== raw.ts;
  const channelTag = ctx.channel.name ? `#${ctx.channel.name}` : ctx.channel.id;
  const text = (raw.text ?? "").trim();
  const body = text ? truncate(text, 1500) : "_(empty)_";
  const idTs = raw.ts.replace(".", "-");

  // Decision sniff — kind upgrade.
  const kind: AtomKind = looksLikeDecision(text) ? "decision" : "comment";

  return {
    id: `evt-slack-${ctx.channel.id.toLowerCase()}-msg-${idTs}`,
    ts: slackTsToIso(raw.ts),
    source: "slack",
    actor,
    actors,
    kind,
    refs: buildRefs({
      slack: {
        team: raw.team ?? undefined,
        channel: ctx.channel.id,
        channel_name: ctx.channel.name,
        message_ts: raw.ts,
        thread_ts: threadTs,
        url: raw.permalink ?? undefined,
      },
      people: actors,
      projects,
      threads: [thread],
    }),
    status: "active",
    sample: false,
    body:
      `**${actor}** ${isReply ? "replied in" : "posted in"} ${channelTag}:\n\n> ${body.split("\n").join("\n> ")}` +
      (raw.permalink ? `\n\nOriginal at: ${raw.permalink}` : ""),
    agi: buildAgi({ importance: ctx.importanceOverride ?? null }),
  };
}

// ----------------------------------------------------------------------
// Channel created

export interface RawChannelCreated {
  id: string;
  name: string;
  creator: string | null;
  created: number; // epoch seconds
}

export function normalizeChannelCreated(raw: RawChannelCreated, ctx: NormalizeCtx): Atom {
  const actor = aliasFor(raw.creator, ctx.identity);
  const ts = new Date(raw.created * 1000).toISOString();
  return {
    id: `evt-slack-${raw.id.toLowerCase()}-channel-created`,
    ts,
    source: "slack",
    actor,
    actors: [actor],
    kind: "system",
    refs: buildRefs({
      slack: { channel: raw.id, channel_name: raw.name },
      people: [actor],
      projects: projectsForChannel(raw.name, ctx.config),
      threads: [`slack-${raw.id.toLowerCase()}-channel`],
    }),
    status: "active",
    sample: false,
    body: `Channel **#${raw.name}** was created by **${actor}**.`,
    agi: buildAgi(),
  };
}

// ----------------------------------------------------------------------
// Pin added — promote to decision

export interface RawPin {
  /** id of the pinning event (timestamp). */
  pinned_ts: string;
  /** The message that was pinned. */
  message: RawMessage;
  /** Who did the pinning. */
  pinned_by: string | null;
}

export function normalizePin(raw: RawPin, ctx: NormalizeCtx): Atom {
  const pinner = aliasFor(raw.pinned_by, ctx.identity);
  const author = aliasFor(raw.message.user, ctx.identity);
  const text = (raw.message.text ?? "").trim();
  const body = text ? truncate(text, 1500) : "_(empty pinned message)_";
  const threadTs = raw.message.thread_ts ?? raw.message.ts;
  const thread = ctx.threadIdFor(ctx.channel.id, threadTs);
  const channelTag = ctx.channel.name ? `#${ctx.channel.name}` : ctx.channel.id;
  const idTs = raw.message.ts.replace(".", "-");

  return {
    id: `evt-slack-${ctx.channel.id.toLowerCase()}-pin-${idTs}`,
    ts: slackTsToIso(raw.pinned_ts),
    source: "slack",
    actor: pinner,
    actors: uniq([pinner, author]),
    kind: "decision",
    refs: buildRefs({
      slack: {
        channel: ctx.channel.id,
        channel_name: ctx.channel.name,
        message_ts: raw.message.ts,
        thread_ts: threadTs,
        url: raw.message.permalink ?? undefined,
      },
      people: uniq([pinner, author]),
      projects: projectsForChannel(ctx.channel.name, ctx.config),
      threads: [thread],
    }),
    status: "active",
    sample: false,
    body:
      `**${pinner}** pinned a message by **${author}** in ${channelTag}:\n\n> ${body.split("\n").join("\n> ")}` +
      (raw.message.permalink ? `\n\nOriginal at: ${raw.message.permalink}` : ""),
    // Pinned messages are explicitly important — flag accordingly so Module C
    // can rank them above raw chatter even before Stage 2 lands.
    agi: buildAgi({ importance: 0.85 }),
  };
}

// ----------------------------------------------------------------------
// Helpers

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
