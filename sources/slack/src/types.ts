// Atom schema (sources/README.md) + Slack-specific helpers.
//
// Slack atoms cover four event families today:
//   - message in a channel              → kind: comment
//   - reply in a thread                 → kind: comment
//   - channel_created                   → kind: system
//   - pin_added                         → kind: decision (pins ≈ resolutions)
// Plus one importance-only signal:
//   - reaction_added with ⭐            → bumps atom.importance to 0.75
//
// Every atom carries the 8 Stage 1 AGI hook fields (STAGE1_AGI_HOOKS.md).
// Stage 1 always emits the documented defaults so Stage 2 can plug in
// reasoning loops without a schema migration.

export type AtomKind =
  | "comment"
  | "system"
  | "decision";

export interface AtomSlackRef {
  /** Slack workspace team id, e.g. "T01ABCDEFGH". */
  team?: string;
  /** Channel id, e.g. "C012ABCDEFG". */
  channel: string;
  /** Channel name (without leading #). Helpful for humans. */
  channel_name?: string;
  /** Message ts, the canonical id within a channel ("1714134567.123456"). */
  message_ts?: string;
  /** Thread root ts (== message_ts when the message starts a thread). */
  thread_ts?: string;
  /** Reaction emoji (only set on reaction-driven importance atoms). */
  reaction?: string;
  /** Permalink back to slack. */
  url?: string;
}

export interface AtomRefs {
  slack?: AtomSlackRef;
  meeting: string | null;
  decisions: string[];
  people: string[];
  projects: string[];
  threads: string[];
}

/**
 * The 8 Stage-1 AGI hook fields (STAGE1_AGI_HOOKS.md, Hook 1). Every atom
 * carries them — Stage 1 fills the documented defaults, Stage 2 reasoning
 * loops mutate them.
 */
export interface AgiHooks {
  embedding: number[] | null;        // Stage 2: vector[1536]
  concepts: string[];                // Stage 2: NER + concept resolution
  confidence: number;                // Stage 1: 1.0 (raw)
  alternatives: string[];            // Stage 2: ambiguous interpretations
  source_count: number;              // Stage 1: 1
  reasoning_notes: string | null;    // Stage 2: reasoning loop annotations
  sentiment: string | null;          // Stage 2: tone analysis
  importance: number | null;         // Stage 2: 0-1 priority. Slack ⭐ may set.
}

export interface Atom {
  id: string;
  ts: string; // RFC 3339 UTC
  source: "slack";
  actor: string;
  actors: string[];
  kind: AtomKind;
  refs: AtomRefs;
  status: "active" | "superseded" | "archived";
  sample: boolean;
  body: string; // markdown body (no frontmatter delimiters)
  agi: AgiHooks;
}

/** Channel configuration entry. */
export interface ChannelConfig {
  /** Slack channel id. */
  id: string;
  /** Channel name (without #). */
  name?: string;
  /** Optional project tag(s) attached to every atom from this channel. */
  projects?: string[];
  /** Most-recent ts (Slack ts string) we've ingested for this channel. */
  cursor?: string;
}

/** Auth mode — bot token (xoxb-) is default; user token (xoxp-) is opt-in. */
export type AuthMode = "bot" | "user";

export interface SourceConfig {
  schema_version: 1;
  poll_interval_sec: number;
  channels: ChannelConfig[];
  auth_mode: AuthMode;
  /**
   * Reaction emoji that signals "this matters" — bumps atom.importance.
   * Defaults to "star" (⭐). Could be configured per-team.
   */
  importance_reaction: string;
  /**
   * If set, ⭐ reactions on existing messages bump atom.importance to this value.
   * Stage 1 hook: lets the importance field actually be non-null.
   */
  importance_boost: number;
}

export type IdentityMap = Record<string, string>;

/** Default config for a fresh install. */
export function defaultConfig(): SourceConfig {
  return {
    schema_version: 1,
    poll_interval_sec: 60,
    channels: [],
    auth_mode: "bot",
    importance_reaction: "star",
    importance_boost: 0.75,
  };
}

/** Defaults for every atom's AGI hook block. STAGE1_AGI_HOOKS.md Hook 1. */
export function defaultAgi(): AgiHooks {
  return {
    embedding: null,
    concepts: [],
    confidence: 1.0,
    alternatives: [],
    source_count: 1,
    reasoning_notes: null,
    sentiment: null,
    importance: null,
  };
}
