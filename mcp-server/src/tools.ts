/**
 * tools.ts — MCP tool registry for Tangerine team memory.
 *
 * 7 tools, all returning the AGI envelope (Hook 4 of STAGE1_AGI_HOOKS.md):
 *
 *   1. query_team_memory(query, limit)        — substring search (legacy, now wrapped)
 *   2. get_today_brief()                      — today's daily brief
 *   3. get_my_pending(user)                   — user's open action items
 *   4. get_for_person(name)                   — recent atoms involving a person
 *   5. get_for_project(slug)                  — recent atoms in a project
 *   6. get_thread_state(topic)                — chronological thread atoms + status
 *   7. get_recent_decisions(days)             — decision atoms in the last N days
 *
 * Tools 2–7 read from the `.tangerine/` sidecar populated by the desktop
 * app's daemon (event_router + briefs + cursors). If the sidecar is missing
 * we degrade gracefully — empty data, not an error.
 */

import { promises as fs } from "node:fs";

import { wrap, freshnessSecondsFromIso, type AgiEnvelope } from "./envelope.js";
import {
  walkMemoryRoot,
  searchMemory,
  type SearchHit,
} from "./memory.js";
import {
  loadTimelineIndex,
  loadCursor,
  readDailyBrief,
  readPendingBrief,
  newestAtom,
  filterAtoms,
  todayIso,
  briefsDir,
  type AtomRecord,
} from "./sidecar.js";

// ----------------------------------------------------------------------
// Tool 1: query_team_memory (existing — now envelope-wrapped)

export const QUERY_TOOL_NAME = "query_team_memory";

export const QUERY_TOOL_DEFINITION = {
  name: QUERY_TOOL_NAME,
  description:
    "Search Tangerine team memory (meetings, decisions, people, projects, threads, glossary) for a substring. Returns top matching markdown files with frontmatter, snippet, and content preview. Call this whenever the user asks about prior decisions, what was said in a meeting, who someone is, or anything that might be in team context.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Substring to search across all team memory markdown",
      },
      limit: {
        type: "number",
        description: "Max results to return (1-20). Default 5.",
        default: 5,
        minimum: 1,
        maximum: 20,
      },
    },
    required: ["query"],
  },
} as const;

export interface QueryArgs {
  query: string;
  limit?: number;
}

export interface QueryData {
  query: string;
  root: string;
  searched: number;
  hits: SearchHit[];
}

export async function runQueryTeamMemory(
  root: string,
  args: QueryArgs,
): Promise<AgiEnvelope<QueryData>> {
  const limit = typeof args.limit === "number" ? args.limit : 5;
  const files = await walkMemoryRoot(root);
  const hits = searchMemory(files, args.query, limit);
  // Best-effort freshness: youngest mtime among hit files. Stage 2 will use
  // atom embeddings + concept graph for true semantic freshness.
  let freshness = 0;
  for (const h of hits) {
    const f = files.find((mf) => mf.relPath === h.file);
    if (!f) continue;
    try {
      const stat = await fs.stat(f.absPath);
      const elapsed = Math.floor((Date.now() - stat.mtimeMs) / 1000);
      if (freshness === 0 || elapsed < freshness) freshness = elapsed;
    } catch {
      /* ignore */
    }
  }
  const data: QueryData = {
    query: args.query,
    root,
    searched: files.length,
    hits,
  };
  // No source_atoms: substring search returns files, not atom ids. Stage 2
  // semantic search will populate this.
  return wrap(data, { freshnessSeconds: freshness, sourceAtoms: [] });
}

// ----------------------------------------------------------------------
// Tool 2: get_today_brief

export const TODAY_BRIEF_TOOL_NAME = "get_today_brief";

export const TODAY_BRIEF_TOOL_DEFINITION = {
  name: TODAY_BRIEF_TOOL_NAME,
  description:
    "Return today's team brief — a markdown summary of yesterday's events grouped by kind (decisions, meetings, PR events, comments, ticket events) plus a per-user 'what each member missed' section. If the daemon has not yet written today's brief file, walks the timeline index and returns a substring-extracted summary in the same shape. Call this at the start of any work session so the AI has team context loaded before the user asks anything.",
  inputSchema: {
    type: "object",
    properties: {},
  },
} as const;

export interface TodayBriefData {
  date: string;
  /** Either "brief_file" (read from `.tangerine/briefs/<date>.md`) or "synthesised". */
  origin: "brief_file" | "synthesised" | "empty";
  /** Markdown body. Empty string when origin === "empty". */
  markdown: string;
  /** Atom ids that contributed (synthesised origin only). */
  source_atoms: string[];
}

export async function runGetTodayBrief(
  root: string,
): Promise<AgiEnvelope<TodayBriefData>> {
  const date = todayIso();
  // 1. Try the brief file written by the daemon.
  const brief = await readDailyBrief(root, date);
  if (brief !== null && brief.trim().length > 0) {
    let freshness = 0;
    try {
      const stat = await fs.stat(`${briefsDir(root)}/${date}.md`);
      freshness = Math.floor((Date.now() - stat.mtimeMs) / 1000);
    } catch {
      /* ignore */
    }
    return wrap(
      {
        date,
        origin: "brief_file",
        markdown: brief,
        source_atoms: [],
      } as TodayBriefData,
      { freshnessSeconds: freshness, sourceAtoms: [] },
    );
  }
  // 2. Fallback: walk timeline index for today's events and synthesise a brief.
  const index = await loadTimelineIndex(root);
  const todayEvents = index.events.filter(
    (e) => !e.sample && (e.ts ?? "").startsWith(date),
  );
  if (todayEvents.length === 0) {
    return wrap(
      {
        date,
        origin: "empty",
        markdown: "",
        source_atoms: [],
      } as TodayBriefData,
      {
        freshnessSeconds: freshnessSecondsFromIso(index.rebuilt_at ?? null),
        sourceAtoms: [],
      },
    );
  }
  const md = synthesiseBrief(date, todayEvents);
  return wrap(
    {
      date,
      origin: "synthesised",
      markdown: md,
      source_atoms: todayEvents.map((e) => e.id),
    } as TodayBriefData,
    {
      freshnessSeconds: freshnessSecondsFromIso(
        newestAtom(todayEvents)?.ts ?? null,
      ),
      sourceAtoms: todayEvents.map((e) => e.id),
    },
  );
}

function synthesiseBrief(date: string, events: AtomRecord[]): string {
  const byKind: Record<string, AtomRecord[]> = {};
  for (const e of events) {
    (byKind[e.kind] ??= []).push(e);
  }
  const sections: string[] = [`# Today's Brief — ${date}`, ""];
  sections.push(
    `_Synthesised from ${events.length} timeline event${events.length === 1 ? "" : "s"}._`,
  );
  sections.push("");
  for (const kind of Object.keys(byKind).sort()) {
    sections.push(`## ${kind} (${byKind[kind].length})`);
    sections.push("");
    for (const e of byKind[kind].slice(0, 20)) {
      const time = (e.ts ?? "").slice(11, 16) || "??:??";
      const head = (e.body ?? "").trim().split("\n")[0]?.slice(0, 120) ?? "";
      sections.push(`- ${time} · **${e.actor}** · \`${e.id}\`${head ? ` — ${head}` : ""}`);
    }
    if (byKind[kind].length > 20) {
      sections.push(`- _... ${byKind[kind].length - 20} more_`);
    }
    sections.push("");
  }
  return sections.join("\n").replace(/\n+$/, "\n");
}

// ----------------------------------------------------------------------
// Tool 3: get_my_pending

export const MY_PENDING_TOOL_NAME = "get_my_pending";

export const MY_PENDING_TOOL_DEFINITION = {
  name: MY_PENDING_TOOL_NAME,
  description:
    "Return open action items owned by `user`. An item is 'open' when its lifecycle.owner equals the user AND lifecycle.closed is null. Sorted by due date ascending (most overdue first; items without a due date come last). Call when the user asks 'what do I owe', 'what's on my plate', 'what's overdue', or starts a planning session.",
  inputSchema: {
    type: "object",
    properties: {
      user: {
        type: "string",
        description:
          "User alias (lowercase, e.g. 'daizhe'). Must match the lifecycle.owner field on the action item.",
      },
    },
    required: ["user"],
  },
} as const;

export interface PendingItem {
  id: string;
  ts: string;
  kind: string;
  actor: string;
  source: string;
  due: string | null;
  review_by: string | null;
  body: string;
  refs: AtomRecord["refs"];
  file?: string;
  line?: number;
  /** True if `due < today`. */
  overdue: boolean;
}

export interface MyPendingData {
  user: string;
  count: number;
  items: PendingItem[];
}

export async function runGetMyPending(
  root: string,
  user: string,
): Promise<AgiEnvelope<MyPendingData>> {
  const index = await loadTimelineIndex(root);
  const today = todayIso();
  const items = index.events
    .filter((a) => !a.sample)
    .filter((a) => {
      const lc = a.lifecycle;
      if (!lc) return false;
      if (!lc.owner) return false;
      if (lc.closed) return false;
      return lc.owner.toLowerCase() === user.toLowerCase();
    })
    .map((a): PendingItem => {
      const due = a.lifecycle?.due ?? null;
      return {
        id: a.id,
        ts: a.ts,
        kind: a.kind,
        actor: a.actor,
        source: a.source,
        due,
        review_by: a.lifecycle?.review_by ?? null,
        body: a.body ?? "",
        refs: a.refs ?? {},
        file: a.file,
        line: a.line,
        overdue: !!due && due.slice(0, 10) < today,
      };
    });
  // Sort: overdue first (oldest due date wins), then upcoming, then no due date.
  items.sort((a, b) => {
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    return (b.ts ?? "").localeCompare(a.ts ?? "");
  });
  return wrap(
    { user, count: items.length, items } as MyPendingData,
    {
      freshnessSeconds: freshnessSecondsFromIso(index.rebuilt_at ?? null),
      sourceAtoms: items.map((i) => i.id),
    },
  );
}

// ----------------------------------------------------------------------
// Tool 4: get_for_person

export const FOR_PERSON_TOOL_NAME = "get_for_person";
const PERSON_DAYS = 30;
const PERSON_LIMIT = 20;

export const FOR_PERSON_TOOL_DEFINITION = {
  name: FOR_PERSON_TOOL_NAME,
  description: `Return up to ${PERSON_LIMIT} recent atoms (last ${PERSON_DAYS} days) involving the named person. 'Involving' means the person appears in refs.people OR in the actors list. Sorted newest first. Call when the user asks 'what's <name> been working on', 'catch me up on <name>', or before a 1:1 / sync with that person.`,
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Person alias (lowercase, e.g. 'eric'). Matched case-insensitively against refs.people and actors.",
      },
    },
    required: ["name"],
  },
} as const;

export interface ForPersonData {
  name: string;
  window_days: number;
  count: number;
  atoms: AtomRecord[];
}

export async function runGetForPerson(
  root: string,
  name: string,
): Promise<AgiEnvelope<ForPersonData>> {
  const index = await loadTimelineIndex(root);
  const cutoff = isoDaysAgo(PERSON_DAYS);
  const lower = name.trim().toLowerCase();
  const atoms = filterAtoms(
    index.events,
    (a) => {
      if ((a.ts ?? "") < cutoff) return false;
      const inActors = (a.actors ?? [a.actor]).some((x) => x?.toLowerCase() === lower);
      const inRefs = (a.refs?.people ?? []).some((p) => p.toLowerCase() === lower);
      return inActors || inRefs;
    },
    PERSON_LIMIT,
  );
  return wrap(
    { name, window_days: PERSON_DAYS, count: atoms.length, atoms } as ForPersonData,
    {
      freshnessSeconds: freshnessSecondsFromIso(newestAtom(atoms)?.ts ?? null),
      sourceAtoms: atoms.map((a) => a.id),
    },
  );
}

// ----------------------------------------------------------------------
// Tool 5: get_for_project

export const FOR_PROJECT_TOOL_NAME = "get_for_project";
const PROJECT_DAYS = 30;
const PROJECT_LIMIT = 20;

export const FOR_PROJECT_TOOL_DEFINITION = {
  name: FOR_PROJECT_TOOL_NAME,
  description: `Return up to ${PROJECT_LIMIT} recent atoms (last ${PROJECT_DAYS} days) belonging to the project slug. Matches refs.projects case-insensitively. Sorted newest first. Call when the user mentions a project by slug or asks 'what's the status of <project>'.`,
  inputSchema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description:
          "Project slug (lowercase, hyphenated, e.g. 'v1-launch'). Matched against refs.projects.",
      },
    },
    required: ["slug"],
  },
} as const;

export interface ForProjectData {
  slug: string;
  window_days: number;
  count: number;
  atoms: AtomRecord[];
}

export async function runGetForProject(
  root: string,
  slug: string,
): Promise<AgiEnvelope<ForProjectData>> {
  const index = await loadTimelineIndex(root);
  const cutoff = isoDaysAgo(PROJECT_DAYS);
  const lower = slug.trim().toLowerCase();
  const atoms = filterAtoms(
    index.events,
    (a) =>
      (a.ts ?? "") >= cutoff &&
      (a.refs?.projects ?? []).some((p) => p.toLowerCase() === lower),
    PROJECT_LIMIT,
  );
  return wrap(
    { slug, window_days: PROJECT_DAYS, count: atoms.length, atoms } as ForProjectData,
    {
      freshnessSeconds: freshnessSecondsFromIso(newestAtom(atoms)?.ts ?? null),
      sourceAtoms: atoms.map((a) => a.id),
    },
  );
}

// ----------------------------------------------------------------------
// Tool 6: get_thread_state

export const THREAD_STATE_TOOL_NAME = "get_thread_state";

export const THREAD_STATE_TOOL_DEFINITION = {
  name: THREAD_STATE_TOOL_NAME,
  description:
    "Return all atoms attached to a discussion thread, in chronological order, plus the thread's status (active/closed) and any decisions resolved within it. The thread's narrative file at memory/threads/<topic>.md is also included verbatim if present. Call when the user asks 'where did we land on <topic>' or 'is <topic> still open'.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description:
          "Thread slug (lowercase, hyphenated, e.g. 'pricing-debate'). Matched against refs.threads.",
      },
    },
    required: ["topic"],
  },
} as const;

export interface ThreadStateData {
  topic: string;
  status: "active" | "closed";
  count: number;
  atoms: AtomRecord[];
  decisions_resolved: string[];
  /** Verbatim contents of memory/threads/<topic>.md if it exists. */
  narrative: string | null;
}

export async function runGetThreadState(
  root: string,
  topic: string,
): Promise<AgiEnvelope<ThreadStateData>> {
  const index = await loadTimelineIndex(root);
  const lower = topic.trim().toLowerCase();
  const atoms = index.events
    .filter((a) => !a.sample)
    .filter((a) => (a.refs?.threads ?? []).some((t) => t.toLowerCase() === lower))
    .sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  // Status: closed if any atom carries status === 'closed' OR all newest atoms
  // have lifecycle.closed set. Defaults to 'active'.
  const closed = atoms.some(
    (a) => a.status === "closed" || !!a.lifecycle?.closed,
  );
  const decisionsResolved = Array.from(
    new Set(
      atoms
        .filter((a) => a.kind === "decision")
        .flatMap((a) => a.refs?.decisions ?? []),
    ),
  ).sort();
  // Narrative file lookup. Slug is path-safe (lowercase + hyphens) by convention.
  const safe = lower.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  let narrative: string | null = null;
  try {
    narrative = await fs.readFile(`${root}/threads/${safe}.md`, "utf8");
  } catch {
    narrative = null;
  }
  return wrap(
    {
      topic,
      status: closed ? "closed" : "active",
      count: atoms.length,
      atoms,
      decisions_resolved: decisionsResolved,
      narrative,
    } as ThreadStateData,
    {
      freshnessSeconds: freshnessSecondsFromIso(newestAtom(atoms)?.ts ?? null),
      sourceAtoms: atoms.map((a) => a.id),
    },
  );
}

// ----------------------------------------------------------------------
// Tool 7: get_recent_decisions

export const RECENT_DECISIONS_TOOL_NAME = "get_recent_decisions";
const DECISIONS_DEFAULT_DAYS = 7;
const DECISIONS_MAX = 50;

export const RECENT_DECISIONS_TOOL_DEFINITION = {
  name: RECENT_DECISIONS_TOOL_NAME,
  description: `Return decision atoms (kind == 'decision') from the last N days, newest first, capped at ${DECISIONS_MAX}. Default window is ${DECISIONS_DEFAULT_DAYS} days. Call when the user asks 'what did we decide recently', 'catch me up on the decisions', or at session start to load decision context.`,
  inputSchema: {
    type: "object",
    properties: {
      days: {
        type: "number",
        description: `Lookback window in days. Default ${DECISIONS_DEFAULT_DAYS}.`,
        default: DECISIONS_DEFAULT_DAYS,
        minimum: 1,
        maximum: 365,
      },
    },
  },
} as const;

export interface RecentDecisionsData {
  window_days: number;
  count: number;
  atoms: AtomRecord[];
}

export async function runGetRecentDecisions(
  root: string,
  days: number = DECISIONS_DEFAULT_DAYS,
): Promise<AgiEnvelope<RecentDecisionsData>> {
  const cap = Math.max(1, Math.min(365, Math.floor(days)));
  const cutoff = isoDaysAgo(cap);
  const index = await loadTimelineIndex(root);
  const atoms = filterAtoms(
    index.events,
    (a) => a.kind === "decision" && (a.ts ?? "") >= cutoff,
    DECISIONS_MAX,
  );
  return wrap(
    { window_days: cap, count: atoms.length, atoms } as RecentDecisionsData,
    {
      freshnessSeconds: freshnessSecondsFromIso(newestAtom(atoms)?.ts ?? null),
      sourceAtoms: atoms.map((a) => a.id),
    },
  );
}

// ----------------------------------------------------------------------
// Helpers

function isoDaysAgo(days: number, now: Date = new Date()): string {
  const t = new Date(now.getTime() - days * 86_400_000);
  return t.toISOString();
}

// ----------------------------------------------------------------------
// Public registry

export const ALL_TOOL_DEFINITIONS = [
  QUERY_TOOL_DEFINITION,
  TODAY_BRIEF_TOOL_DEFINITION,
  MY_PENDING_TOOL_DEFINITION,
  FOR_PERSON_TOOL_DEFINITION,
  FOR_PROJECT_TOOL_DEFINITION,
  THREAD_STATE_TOOL_DEFINITION,
  RECENT_DECISIONS_TOOL_DEFINITION,
];

export const TOOL_NAMES = {
  QUERY: QUERY_TOOL_NAME,
  TODAY_BRIEF: TODAY_BRIEF_TOOL_NAME,
  MY_PENDING: MY_PENDING_TOOL_NAME,
  FOR_PERSON: FOR_PERSON_TOOL_NAME,
  FOR_PROJECT: FOR_PROJECT_TOOL_NAME,
  THREAD_STATE: THREAD_STATE_TOOL_NAME,
  RECENT_DECISIONS: RECENT_DECISIONS_TOOL_NAME,
} as const;
