// Linear payloads → Tangerine atoms.
//
// Atom id and kind names follow the Module A canonical schema:
//   id is `evt-<YYYY-MM-DD>-<10-hex>` from sha256(source|kind|source_id|ts)
//   kind ∈ {ticket_event, comment, decision} (Module A vocabulary)
//
// The narrow Linear verb (issue_created vs issue_state_changed vs ...) is
// preserved on refs.linear.action so downstream UX still tells them apart.

import { createHash } from "node:crypto";
import type {
  Atom,
  AtomKind,
  AtomRefs,
  IdentityMap,
  LinearAction,
  SourceConfig,
  TeamConfig,
} from "./types.js";
import type { LinearComment, LinearIssue, LinearLabel, LinearUser } from "./client.js";

export interface NormalizeCtx {
  team: TeamConfig;
  identity: IdentityMap;
  config: SourceConfig;
  /** Per-issue thread id factory: `linear-<TEAMKEY>-<num>`. */
  threadIdForIssue(identifier: string): string;
}

export function makeCtx(
  team: TeamConfig,
  identity: IdentityMap,
  config: SourceConfig,
): NormalizeCtx {
  return {
    team,
    identity,
    config,
    threadIdForIssue: (id) => `linear-${id.toLowerCase()}`,
  };
}

/**
 * Module A canonical id: ``evt-<YYYY-MM-DD>-<10-hex>`` from
 * sha256(source|kind|source_id|ts). Same inputs → same id forever.
 */
export function makeAtomId(
  source: string,
  kind: string,
  sourceId: string,
  ts: string,
): string {
  const datePart = /^\d{4}-\d{2}-\d{2}/.exec(ts)?.[0] ?? new Date().toISOString().slice(0, 10);
  const digest = createHash("sha256").update(`${source}|${kind}|${sourceId}|${ts}`).digest("hex");
  return `evt-${datePart}-${digest.slice(0, 10)}`;
}

function lnSourceId(teamKey: string, kind: string, parts: (string | number)[]): string {
  return `linear:${teamKey}:${kind}:${parts.join(":")}`;
}

function withAgiDefaults<T extends object>(atom: T): T {
  const a = atom as Record<string, unknown>;
  if (a.embedding === undefined) a.embedding = null;
  if (a.concepts === undefined) a.concepts = [];
  if (a.confidence === undefined) a.confidence = 1.0;
  if (a.alternatives === undefined) a.alternatives = [];
  if (a.source_count === undefined) a.source_count = 1;
  if (a.reasoning_notes === undefined) a.reasoning_notes = null;
  if (a.sentiment === undefined) a.sentiment = null;
  if (a.importance === undefined) a.importance = null;
  return atom;
}

export function aliasFor(user: LinearUser | null | undefined, identity: IdentityMap): string {
  if (!user) return "unknown";
  const candidate = user.email ?? user.displayName ?? user.name ?? user.id;
  const mapped = identity[candidate];
  return mapped && mapped.length > 0 ? mapped : candidate;
}

/** @mention extraction. Linear's mention syntax is `@username` (display name)
 *  in markdown bodies. */
export function extractMentions(body: string | null | undefined, identity: IdentityMap): string[] {
  if (!body) return [];
  const out = new Set<string>();
  const re = /(?:^|[^a-zA-Z0-9_-])@([a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,38})?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const handle = m[1];
    const mapped = identity[handle];
    out.add(mapped && mapped.length > 0 ? mapped : handle);
  }
  return [...out];
}

export function extractProjects(
  labels: LinearLabel[] | null | undefined,
  title: string | null | undefined,
  cfg: SourceConfig,
  team: TeamConfig,
): string[] {
  const out = new Set<string>();
  const prefix = cfg.project_label_prefix;
  for (const l of labels ?? []) {
    if (!l?.name) continue;
    if (prefix && l.name.startsWith(prefix)) {
      out.add(l.name.slice(prefix.length));
    }
  }
  if (title && cfg.project_title_regex) {
    try {
      const re = new RegExp(cfg.project_title_regex);
      const mm = re.exec(title);
      if (mm && mm[1]) out.add(mm[1]);
    } catch {
      /* invalid regex — ignore */
    }
  }
  for (const p of team.projects ?? []) out.add(p);
  return [...out];
}

const DECISION_RX = /(\bdecided\b|\bagreed\b|\bwe will go with\b|\bwe'll go with\b|\blet's go with\b|\blocked in\b|\bconclusion:|\bgoing with\b|\bship it\b)/i;
export function looksLikeDecision(body: string | null | undefined): boolean {
  if (!body) return false;
  return DECISION_RX.test(body);
}

function buildRefs(opts: {
  linear: NonNullable<AtomRefs["linear"]>;
  people: string[];
  projects: string[];
  threads: string[];
}): AtomRefs {
  return {
    linear: opts.linear,
    meeting: null,
    decisions: [],
    people: opts.people,
    projects: opts.projects,
    threads: opts.threads,
  };
}

function nowOr(ts: string | null | undefined, fallback: Date = new Date()): string {
  if (ts) return new Date(ts).toISOString();
  return fallback.toISOString();
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function escapeMd(s: string): string {
  return s.replace(/\r?\n+/g, " ").trim();
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

// ----------------------------------------------------------------------
// Issue events

/** What kind of issue event this Linear issue represents now. We diff the
 *  fresh issue against any prior cursor / state to pick the verb, but for
 *  Stage 1 we keep it simple: created / completed / canceled get their own
 *  verbs; everything else (state moves, assignee changes, edits) collapses
 *  to issue_state_changed. */
export type IssueAction = Extract<LinearAction,
  "issue_created" | "issue_state_changed" | "issue_completed" | "issue_canceled">;

/** Decide which verb best describes the current state of an issue.
 *
 *  Linear's lifecycle timestamps are sticky: once `completedAt` or
 *  `canceledAt` is set, it stays set. So the canonical "event" for a closed
 *  issue is always its terminal verb, regardless of how many times we've
 *  re-seen it via polling. This keeps the source_id stable across polls →
 *  Module A dedups correctly. */
export function classifyIssueAction(issue: LinearIssue, since: string | null): IssueAction {
  if (issue.canceledAt) return "issue_canceled";
  if (issue.completedAt) return "issue_completed";
  if (since === null || issue.createdAt > since) return "issue_created";
  return "issue_state_changed";
}

export function normalizeIssue(raw: LinearIssue, ctx: NormalizeCtx, since: string | null): Atom {
  const action: IssueAction = classifyIssueAction(raw, since);
  const actor = aliasFor(raw.creator ?? raw.assignee ?? null, ctx.identity);
  const labels = raw.labels?.nodes ?? [];
  const projects = extractProjects(labels, raw.title, ctx.config, ctx.team);
  const mentions = extractMentions(raw.description ?? null, ctx.identity);
  const assignee = aliasFor(raw.assignee ?? null, ctx.identity);
  const actors = uniq([actor, assignee, ...mentions].filter((x) => x !== "unknown"));
  const thread = ctx.threadIdForIssue(raw.identifier);

  // Pick the relevant timestamp for this verb.
  const ts =
    action === "issue_canceled" && raw.canceledAt
      ? nowOr(raw.canceledAt)
      : action === "issue_completed" && raw.completedAt
        ? nowOr(raw.completedAt)
        : action === "issue_created"
          ? nowOr(raw.createdAt)
          : nowOr(raw.updatedAt);

  // Decision sniff on completion.
  let kind: AtomKind = "ticket_event";
  if (action === "issue_completed" && looksLikeDecision(raw.description ?? null)) {
    kind = "decision";
  }

  const sourceId = lnSourceId(ctx.team.key, kind, [raw.identifier, action]);
  const verbHuman: Record<IssueAction, string> = {
    issue_created: "created",
    issue_state_changed: "updated",
    issue_completed: "completed",
    issue_canceled: "canceled",
  };
  const desc = raw.description ? `\n\n${truncate(raw.description, 800)}` : "";
  const stateName = raw.state?.name ?? "?";
  const lead =
    action === "issue_created"
      ? `**${actor}** created ${raw.identifier}: _${escapeMd(raw.title)}_${desc}`
      : action === "issue_completed"
        ? `**${actor}** completed ${raw.identifier} (${escapeMd(raw.title)}).`
        : action === "issue_canceled"
          ? `**${actor}** canceled ${raw.identifier} (${escapeMd(raw.title)}).`
          : `**${actor}** ${verbHuman[action]} ${raw.identifier} → state \`${stateName}\` (${escapeMd(raw.title)}).`;

  return withAgiDefaults({
    id: makeAtomId("linear", kind, sourceId, ts),
    ts,
    source: "linear",
    actor,
    actors: actors.length ? actors : [actor],
    kind,
    source_id: sourceId,
    refs: buildRefs({
      linear: {
        team_key: ctx.team.key,
        issue_id: raw.identifier,
        issue_uuid: raw.id,
        project_uuid: raw.project?.id,
        project_name: raw.project?.name,
        state: raw.state?.name,
        priority: raw.priority,
        url: raw.url,
        action,
      },
      people: actors.length ? actors : [actor],
      projects,
      threads: [thread],
    }),
    status: "active",
    sample: false,
    body: lead + (raw.url ? `\n\nOriginal at: ${raw.url}` : ""),
  });
}

// ----------------------------------------------------------------------
// Comments

export function normalizeComment(raw: LinearComment, ctx: NormalizeCtx): Atom {
  const actor = aliasFor(raw.user ?? null, ctx.identity);
  const mentions = extractMentions(raw.body, ctx.identity);
  const actors = uniq([actor, ...mentions].filter((x) => x !== "unknown"));
  const issueId = raw.issue?.identifier ?? "??-?";
  const thread = ctx.threadIdForIssue(issueId);
  const titleSuffix = raw.issue?.title ? ` (${escapeMd(raw.issue.title)})` : "";
  const body = raw.body ? truncate(raw.body, 800) : "_(empty)_";

  const kind: AtomKind = looksLikeDecision(raw.body) ? "decision" : "comment";
  const action: LinearAction = "comment_created";
  const sourceId = lnSourceId(ctx.team.key, kind, ["comment", issueId, raw.id]);
  const ts = nowOr(raw.createdAt);

  return withAgiDefaults({
    id: makeAtomId("linear", kind, sourceId, ts),
    ts,
    source: "linear",
    actor,
    actors: actors.length ? actors : [actor],
    kind,
    source_id: sourceId,
    refs: buildRefs({
      linear: {
        team_key: ctx.team.key,
        issue_id: issueId,
        issue_uuid: raw.issue?.id,
        comment_uuid: raw.id,
        url: raw.url,
        action,
      },
      people: actors.length ? actors : [actor],
      // Comments inherit projects from their parent — caller (poll.ts) decorates.
      projects: [],
      threads: [thread],
    }),
    status: "active",
    sample: false,
    body:
      `**${actor}** commented on ${issueId}${titleSuffix}:\n\n> ${body.split("\n").join("\n> ")}` +
      (raw.url ? `\n\nOriginal at: ${raw.url}` : ""),
  });
}
