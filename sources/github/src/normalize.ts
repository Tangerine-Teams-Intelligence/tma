// GitHub event payloads → Tangerine atoms.
//
// We hand-roll the mapping for each event family rather than reading a
// schema. Reasons:
//  - GitHub adds nullable fields constantly; explicit code is easier to debug
//    than a JSON Schema validator that silently drops new fields.
//  - The atom body is a small piece of human-readable markdown — building it
//    inline is clearer than templating.
//
// Each `normalize<X>` function takes the raw GitHub object, the parent ref
// (repo, pr/issue number), and the resolution context (identity map +
// project detection rules), and returns one Atom.
//
// Atom id and kind names follow the Module A canonical schema (Module A
// wins): id is ``evt-<YYYY-MM-DD>-<10-hex>`` from sha256(source|kind|source_id|ts);
// kinds are pr_event / comment / ticket_event / decision (the narrow GitHub
// verb is preserved on refs.github.action). See ``makeAtomId`` below.

import { createHash } from "node:crypto";
import type { Atom, AtomKind, AtomRefs, GithubAction, IdentityMap, SourceConfig } from "./types.js";

export interface NormalizeCtx {
  repo: string; // "org/name"
  identity: IdentityMap;
  config: SourceConfig;
  /** Default thread id factory; each kind builds its own. */
  threadIdForPr(num: number): string;
  threadIdForIssue(num: number): string;
}

export function makeCtx(
  repo: string,
  identity: IdentityMap,
  config: SourceConfig,
): NormalizeCtx {
  const safeRepo = repo.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
  return {
    repo,
    identity,
    config,
    threadIdForPr: (n) => `pr-${safeRepo}-${n}`,
    threadIdForIssue: (n) => `issue-${safeRepo}-${n}`,
  };
}

/** Resolve a GitHub login → Tangerine alias. Unknown logins map to themselves
 *  (caller is responsible for persisting that back to identity.json). */
export function aliasFor(login: string | null | undefined, identity: IdentityMap): string {
  if (!login) return "unknown";
  const mapped = identity[login];
  return mapped && mapped.length > 0 ? mapped : login;
}

/** Find @mentions in a markdown body. Returns aliases (resolved). Excludes the actor. */
export function extractMentions(body: string | null | undefined, identity: IdentityMap): string[] {
  if (!body) return [];
  const out = new Set<string>();
  const re = /(?:^|[^a-zA-Z0-9_-])@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.add(aliasFor(m[1], identity));
  }
  return [...out];
}

/** Extract project tags from labels + title. */
export function extractProjects(
  labels: Array<{ name?: string | null }> | null | undefined,
  title: string | null | undefined,
  cfg: SourceConfig,
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
      const m = re.exec(title);
      if (m && m[1]) out.add(m[1]);
    } catch {
      /* invalid regex in config — silently ignore */
    }
  }
  return [...out];
}

/**
 * Decision sniffing — looks for verbs that strongly imply a settled choice.
 * We mark hits as `kind: decision` so Module C (the inbox) can surface them
 * for human ack. Conservative on purpose; better to miss than false-positive.
 */
const DECISION_RX = /(\bdecided\b|\bagreed\b|\bwe will go with\b|\bwe'll go with\b|\blet's go with\b|\blocked in\b|\bconclusion:|\bgoing with\b)/i;
export function looksLikeDecision(body: string | null | undefined): boolean {
  if (!body) return false;
  return DECISION_RX.test(body);
}

function buildRefs(opts: {
  github: NonNullable<AtomRefs["github"]>;
  people: string[];
  projects: string[];
  threads: string[];
}): AtomRefs {
  return {
    github: opts.github,
    meeting: null,
    decisions: [],
    people: opts.people,
    projects: opts.projects,
    threads: opts.threads,
  };
}

function nowOr(ts: string | null | undefined, fallback: Date = new Date()): string {
  if (ts) {
    // GitHub already returns RFC 3339; force UTC Z form for consistency.
    return new Date(ts).toISOString();
  }
  return fallback.toISOString();
}

/**
 * Module A canonical id: ``evt-<YYYY-MM-DD>-<10-hex>`` from
 * sha256(source|kind|source_id|ts). Same inputs → same id forever.
 *
 * The Python side (``tmi.event_router.make_event_id``) computes this exact
 * same hash; if a connector sends an atom with id="" the daemon recomputes
 * via the same formula. We compute it client-side too so atoms read with a
 * stable id BEFORE they hit the router.
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

/** Build the source_id portion of the canonical id. Stable across polls so
 *  re-ingestion lands on the exact same atom id. */
function ghSourceId(repo: string, kind: string, parts: (string | number)[]): string {
  return `gh:${repo}:${kind}:${parts.join(":")}`;
}

/** Stage 1 AGI defaults — set so atoms read identically before/after they
 *  hop to Module A. Module A's validate_atom() injects these too, but we
 *  set them here so memory.ts can serialise the full schema for connectors
 *  that bypass the router (none today, but the contract is the contract). */
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

// ----------------------------------------------------------------------
// PR

export interface RawPr {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string } | null;
  base?: { ref?: string | null } | null;
  head?: { ref?: string | null } | null;
  labels?: Array<{ name?: string | null }> | null;
  html_url?: string | null;
  created_at: string;
  updated_at?: string | null;
  merged_at?: string | null;
  closed_at?: string | null;
  merged_by?: { login: string } | null;
  merge_commit_sha?: string | null;
  draft?: boolean | null;
}

export function normalizePr(raw: RawPr, ctx: NormalizeCtx): Atom {
  const actor = aliasFor(raw.user?.login, ctx.identity);
  const projects = extractProjects(raw.labels, raw.title, ctx.config);
  const mentions = extractMentions(raw.body, ctx.identity);
  const actors = uniq([actor, ...mentions]);
  const thread = ctx.threadIdForPr(raw.number);
  const base = raw.base?.ref ?? "?";
  const head = raw.head?.ref ?? "?";
  const draftTag = raw.draft ? " (draft)" : "";
  const bodyLine = raw.body ? `\n\n${truncate(raw.body, 800)}` : "";
  const ts = nowOr(raw.created_at);
  const sourceId = ghSourceId(ctx.repo, "pr_event", [raw.number, "opened"]);
  return withAgiDefaults({
    id: makeAtomId("github", "pr_event", sourceId, ts),
    ts,
    source: "github",
    actor,
    actors,
    kind: "pr_event",
    source_id: sourceId,
    refs: buildRefs({
      github: { repo: ctx.repo, pr: raw.number, url: raw.html_url ?? undefined, action: "opened" },
      people: actors,
      projects,
      threads: [thread],
    }),
    status: "active",
    sample: false,
    body:
      `**${actor}** opened PR #${raw.number}${draftTag} (${head} → ${base}): _${escapeMd(raw.title)}_${bodyLine}` +
      (raw.html_url ? `\n\nOriginal at: ${raw.html_url}` : ""),
  });
}

export function normalizePrMerged(raw: RawPr, ctx: NormalizeCtx): Atom {
  const actor = aliasFor(raw.merged_by?.login ?? raw.user?.login, ctx.identity);
  const projects = extractProjects(raw.labels, raw.title, ctx.config);
  const thread = ctx.threadIdForPr(raw.number);
  const ts = nowOr(raw.merged_at);
  const sourceId = ghSourceId(ctx.repo, "pr_event", [raw.number, "merged"]);
  return withAgiDefaults({
    id: makeAtomId("github", "pr_event", sourceId, ts),
    ts,
    source: "github",
    actor,
    actors: [actor],
    kind: "pr_event",
    source_id: sourceId,
    refs: buildRefs({
      github: { repo: ctx.repo, pr: raw.number, url: raw.html_url ?? undefined, action: "merged" },
      people: [actor],
      projects,
      threads: [thread],
    }),
    status: "active",
    sample: false,
    body:
      `**${actor}** merged PR #${raw.number} (${escapeMd(raw.title)}). ` +
      (raw.merge_commit_sha ? `Merge SHA \`${raw.merge_commit_sha.slice(0, 12)}\`.` : "") +
      (raw.html_url ? `\n\nOriginal at: ${raw.html_url}` : ""),
  });
}

export function normalizePrClosed(raw: RawPr, ctx: NormalizeCtx): Atom {
  const actor = aliasFor(raw.user?.login, ctx.identity); // best-effort; GitHub doesn't always tell us who closed
  const projects = extractProjects(raw.labels, raw.title, ctx.config);
  const thread = ctx.threadIdForPr(raw.number);
  const ts = nowOr(raw.closed_at);
  const sourceId = ghSourceId(ctx.repo, "pr_event", [raw.number, "closed"]);
  return withAgiDefaults({
    id: makeAtomId("github", "pr_event", sourceId, ts),
    ts,
    source: "github",
    actor,
    actors: [actor],
    kind: "pr_event",
    source_id: sourceId,
    refs: buildRefs({
      github: { repo: ctx.repo, pr: raw.number, url: raw.html_url ?? undefined, action: "closed" },
      people: [actor],
      projects,
      threads: [thread],
    }),
    status: "active",
    sample: false,
    body:
      `PR #${raw.number} (${escapeMd(raw.title)}) was closed without merge.` +
      (raw.html_url ? `\n\nOriginal at: ${raw.html_url}` : ""),
  });
}

// ----------------------------------------------------------------------
// PR comment

export interface RawComment {
  id: number;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
  html_url?: string | null;
  /** For inline review comments: the path/line/side. */
  path?: string | null;
  /** Distinguishes inline-code-comment (review_comment) vs PR-conversation (issue_comment).
   *  We set this in poll.ts before calling normalize. */
  inline?: boolean;
  /** PR or issue number. */
  parentNumber: number;
  /** "pr" or "issue" — drives kind + thread shape. */
  parentKind: "pr" | "issue";
  /** Title of the parent (for body context). */
  parentTitle?: string | null;
}

export function normalizeComment(raw: RawComment, ctx: NormalizeCtx): Atom {
  const actor = aliasFor(raw.user?.login, ctx.identity);
  const mentions = extractMentions(raw.body, ctx.identity);
  const actors = uniq([actor, ...mentions]);
  const isPr = raw.parentKind === "pr";
  const thread = isPr ? ctx.threadIdForPr(raw.parentNumber) : ctx.threadIdForIssue(raw.parentNumber);
  const parentTag = isPr ? `PR #${raw.parentNumber}` : `Issue #${raw.parentNumber}`;
  const inlineTag = raw.inline && raw.path ? ` on \`${raw.path}\`` : "";
  const titleSuffix = raw.parentTitle ? ` (${escapeMd(raw.parentTitle)})` : "";
  const body = raw.body ? truncate(raw.body, 800) : "_(empty)_";

  // Decision sniff — kind upgrade. Otherwise everything is a Module-A `comment`,
  // regardless of whether it's a PR conversation or issue conversation comment;
  // the parent kind is preserved on refs.github (pr vs issue).
  const kind: AtomKind = looksLikeDecision(raw.body) ? "decision" : "comment";
  const action: GithubAction = "comment_created";
  const sourceId = ghSourceId(ctx.repo, "comment", [isPr ? "pr" : "issue", raw.parentNumber, raw.id]);
  const ts = nowOr(raw.created_at);

  return withAgiDefaults({
    id: makeAtomId("github", kind, sourceId, ts),
    ts,
    source: "github",
    actor,
    actors,
    kind,
    source_id: sourceId,
    refs: buildRefs({
      github: {
        repo: ctx.repo,
        ...(isPr ? { pr: raw.parentNumber } : { issue: raw.parentNumber }),
        comment_id: raw.id,
        url: raw.html_url ?? undefined,
        action,
      },
      people: actors,
      // Comments inherit projects from their parent — caller passes via ctx if known.
      // Here we leave empty and let the caller decorate (poll.ts does this).
      projects: [],
      threads: [thread],
    }),
    status: "active",
    sample: false,
    body:
      `**${actor}** commented on ${parentTag}${inlineTag}${titleSuffix}:\n\n> ${body.split("\n").join("\n> ")}` +
      (raw.html_url ? `\n\nOriginal at: ${raw.html_url}` : ""),
  });
}

// ----------------------------------------------------------------------
// PR review

export interface RawReview {
  id: number;
  body: string | null;
  state: string; // approved | changes_requested | commented | dismissed | pending
  user: { login: string } | null;
  submitted_at?: string | null;
  html_url?: string | null;
  parentNumber: number;
  parentTitle?: string | null;
}

export function normalizeReview(raw: RawReview, ctx: NormalizeCtx): Atom {
  const actor = aliasFor(raw.user?.login, ctx.identity);
  const thread = ctx.threadIdForPr(raw.parentNumber);
  const stateTag = raw.state.toLowerCase();
  const verb =
    stateTag === "approved"
      ? "approved"
      : stateTag === "changes_requested"
        ? "requested changes on"
        : stateTag === "dismissed"
          ? "dismissed their review on"
          : "reviewed";
  const action: GithubAction =
    stateTag === "approved"
      ? "review_approved"
      : stateTag === "changes_requested"
        ? "review_changes_requested"
        : stateTag === "dismissed"
          ? "review_dismissed"
          : "review_commented";
  const titleSuffix = raw.parentTitle ? ` (${escapeMd(raw.parentTitle)})` : "";
  const bodyLine = raw.body ? `\n\n> ${truncate(raw.body, 800).split("\n").join("\n> ")}` : "";
  const ts = nowOr(raw.submitted_at);
  const sourceId = ghSourceId(ctx.repo, "pr_event", [raw.parentNumber, "review", raw.id]);
  return withAgiDefaults({
    id: makeAtomId("github", "pr_event", sourceId, ts),
    ts,
    source: "github",
    actor,
    actors: [actor],
    kind: "pr_event",
    source_id: sourceId,
    refs: buildRefs({
      github: {
        repo: ctx.repo,
        pr: raw.parentNumber,
        review_id: raw.id,
        url: raw.html_url ?? undefined,
        action,
      },
      people: [actor],
      projects: [],
      threads: [thread],
    }),
    status: "active",
    sample: false,
    body:
      `**${actor}** ${verb} PR #${raw.parentNumber}${titleSuffix}.${bodyLine}` +
      (raw.html_url ? `\n\nOriginal at: ${raw.html_url}` : ""),
  });
}

// ----------------------------------------------------------------------
// Issue

export interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string } | null;
  labels?: Array<{ name?: string | null } | string> | null;
  html_url?: string | null;
  created_at: string;
  closed_at?: string | null;
  state_reason?: string | null;
  /** GitHub returns `pull_request` on issues that are actually PRs; we filter those out upstream. */
  pull_request?: unknown;
}

function normalizeLabels(
  labels: RawIssue["labels"],
): Array<{ name?: string | null }> {
  if (!labels) return [];
  return labels.map((l) => (typeof l === "string" ? { name: l } : l));
}

export function normalizeIssue(raw: RawIssue, ctx: NormalizeCtx): Atom {
  const actor = aliasFor(raw.user?.login, ctx.identity);
  const labels = normalizeLabels(raw.labels);
  const projects = extractProjects(labels, raw.title, ctx.config);
  const mentions = extractMentions(raw.body, ctx.identity);
  const actors = uniq([actor, ...mentions]);
  const thread = ctx.threadIdForIssue(raw.number);
  const bodyLine = raw.body ? `\n\n${truncate(raw.body, 800)}` : "";
  const ts = nowOr(raw.created_at);
  const sourceId = ghSourceId(ctx.repo, "ticket_event", [raw.number, "opened"]);
  return withAgiDefaults({
    id: makeAtomId("github", "ticket_event", sourceId, ts),
    ts,
    source: "github",
    actor,
    actors,
    kind: "ticket_event",
    source_id: sourceId,
    refs: buildRefs({
      github: { repo: ctx.repo, issue: raw.number, url: raw.html_url ?? undefined, action: "issue_opened" },
      people: actors,
      projects,
      threads: [thread],
    }),
    status: "active",
    sample: false,
    body:
      `**${actor}** opened Issue #${raw.number}: _${escapeMd(raw.title)}_${bodyLine}` +
      (raw.html_url ? `\n\nOriginal at: ${raw.html_url}` : ""),
  });
}

export function normalizeIssueClosed(raw: RawIssue, ctx: NormalizeCtx): Atom {
  const actor = aliasFor(raw.user?.login, ctx.identity);
  const labels = normalizeLabels(raw.labels);
  const projects = extractProjects(labels, raw.title, ctx.config);
  const thread = ctx.threadIdForIssue(raw.number);
  const reason = raw.state_reason ? ` (reason: ${raw.state_reason})` : "";
  const ts = nowOr(raw.closed_at);
  const sourceId = ghSourceId(ctx.repo, "ticket_event", [raw.number, "closed"]);
  return withAgiDefaults({
    id: makeAtomId("github", "ticket_event", sourceId, ts),
    ts,
    source: "github",
    actor,
    actors: [actor],
    kind: "ticket_event",
    source_id: sourceId,
    refs: buildRefs({
      github: { repo: ctx.repo, issue: raw.number, url: raw.html_url ?? undefined, action: "issue_closed" },
      people: [actor],
      projects,
      threads: [thread],
    }),
    status: "active",
    sample: false,
    body:
      `Issue #${raw.number} (${escapeMd(raw.title)}) was closed${reason}.` +
      (raw.html_url ? `\n\nOriginal at: ${raw.html_url}` : ""),
  });
}

// ----------------------------------------------------------------------
// Helpers

export function slugRepo(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
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
