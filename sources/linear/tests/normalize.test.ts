// Normalize: Linear payloads → Module-A canonical atoms.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeIssue,
  normalizeComment,
  classifyIssueAction,
  makeCtx,
  makeAtomId,
  aliasFor,
  extractMentions,
  extractProjects,
  looksLikeDecision,
} from "../src/normalize.js";
import { defaultConfig, type IdentityMap, type TeamConfig } from "../src/types.js";
import type { LinearComment, LinearIssue, LinearUser } from "../src/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

const identity: IdentityMap = {
  "eric@example.com": "eric",
  "daizhe@example.com": "daizhe",
};
const cfg = defaultConfig();
const team: TeamConfig = { uuid: "uuid-team-eng", key: "ENG", name: "Engineering" };
const ctx = makeCtx(team, identity, cfg);

const MODULE_A_ID_RE = /^evt-\d{4}-\d{2}-\d{2}-[a-f0-9]{10}$/;

describe("makeAtomId", () => {
  it("date-prefixed + 10 hex digest", () => {
    const id = makeAtomId("linear", "ticket_event", "x", "2026-04-26T09:00:00Z");
    expect(id).toMatch(MODULE_A_ID_RE);
    expect(id.slice(4, 14)).toBe("2026-04-26");
  });
  it("same inputs → same id (stability)", () => {
    const a = makeAtomId("linear", "ticket_event", "k", "2026-04-26T09:00:00Z");
    const b = makeAtomId("linear", "ticket_event", "k", "2026-04-26T09:00:00Z");
    expect(a).toBe(b);
  });
  it("any input change → different id", () => {
    const base = makeAtomId("linear", "ticket_event", "k", "2026-04-26T09:00:00Z");
    expect(makeAtomId("github", "ticket_event", "k", "2026-04-26T09:00:00Z")).not.toBe(base);
    expect(makeAtomId("linear", "comment", "k", "2026-04-26T09:00:00Z")).not.toBe(base);
    expect(makeAtomId("linear", "ticket_event", "kk", "2026-04-26T09:00:00Z")).not.toBe(base);
    expect(makeAtomId("linear", "ticket_event", "k", "2026-04-26T09:00:01Z")).not.toBe(base);
  });
});

describe("aliasFor", () => {
  it("maps known emails to aliases", () => {
    const u: LinearUser = { id: "u1", email: "eric@example.com" };
    expect(aliasFor(u, identity)).toBe("eric");
  });
  it("falls through to email when unmapped", () => {
    const u: LinearUser = { id: "u2", email: "stranger@example.com" };
    expect(aliasFor(u, identity)).toBe("stranger@example.com");
  });
  it("falls back to displayName then name when no email", () => {
    expect(aliasFor({ id: "u", displayName: "Foo" }, identity)).toBe("Foo");
    expect(aliasFor({ id: "u", name: "Bar" }, identity)).toBe("Bar");
  });
  it("returns 'unknown' for null", () => {
    expect(aliasFor(null, identity)).toBe("unknown");
    expect(aliasFor(undefined, identity)).toBe("unknown");
  });
});

describe("extractMentions", () => {
  it("extracts @handle and resolves through identity", () => {
    const m = extractMentions("ping @daizhe and @eric", { daizhe: "daizhe", eric: "eric" });
    expect(m).toContain("daizhe");
    expect(m).toContain("eric");
  });
  it("does not match email-style @s embedded in text", () => {
    const m = extractMentions("contact me at foo@bar.com about @daizhe", { daizhe: "daizhe" });
    expect(m).toEqual(["daizhe"]);
  });
  it("returns empty for null/empty", () => {
    expect(extractMentions(null, identity)).toEqual([]);
    expect(extractMentions("", identity)).toEqual([]);
  });
});

describe("extractProjects", () => {
  it("pulls from configured label prefix", () => {
    const p = extractProjects([{ id: "1", name: "project:v1" }], null, cfg, team);
    expect(p).toEqual(["v1"]);
  });
  it("pulls from title regex", () => {
    const p = extractProjects([], "[v2] foo", cfg, team);
    expect(p).toEqual(["v2"]);
  });
  it("merges label, title, and team-level projects", () => {
    const teamWithProjects: TeamConfig = { ...team, projects: ["explicit"] };
    const p = extractProjects(
      [{ id: "1", name: "project:label-side" }],
      "[title-side] foo",
      cfg,
      teamWithProjects,
    );
    expect(p.sort()).toEqual(["explicit", "label-side", "title-side"]);
  });
  it("returns [] when nothing matches", () => {
    expect(extractProjects([], "no prefix", cfg, team)).toEqual([]);
  });
});

describe("looksLikeDecision", () => {
  it("flags clear decision verbs", () => {
    expect(looksLikeDecision("we decided to use Postgres")).toBe(true);
    expect(looksLikeDecision("agreed — going with rust")).toBe(true);
    expect(looksLikeDecision("Conclusion: ship it")).toBe(true);
    expect(looksLikeDecision("ship it now")).toBe(true);
  });
  it("does not flag idle chatter", () => {
    expect(looksLikeDecision("I think we should ship it eventually")).toBe(true); // contains "ship it"
    expect(looksLikeDecision("just looking at it")).toBe(false);
    expect(looksLikeDecision(null)).toBe(false);
    expect(looksLikeDecision("")).toBe(false);
  });
});

describe("classifyIssueAction", () => {
  it("first-sight + active state → issue_created", () => {
    const issue: LinearIssue = {
      id: "x", identifier: "ENG-1", title: "x", description: null,
      priority: 0,
      createdAt: "2026-04-26T08:00:00Z",
      updatedAt: "2026-04-26T08:00:00Z",
    };
    expect(classifyIssueAction(issue, null)).toBe("issue_created");
  });
  it("canceledAt set → issue_canceled (regardless of cursor)", () => {
    const issue: LinearIssue = {
      id: "x", identifier: "ENG-2", title: "x", description: null,
      priority: 0,
      createdAt: "2026-04-26T08:00:00Z",
      updatedAt: "2026-04-26T10:00:00Z",
      canceledAt: "2026-04-26T10:00:00Z",
    };
    expect(classifyIssueAction(issue, null)).toBe("issue_canceled");
  });
  it("completedAt set → issue_completed (sticky across polls)", () => {
    const issue: LinearIssue = {
      id: "x", identifier: "ENG-3", title: "x", description: null,
      priority: 0,
      createdAt: "2026-04-26T08:00:00Z",
      updatedAt: "2026-04-26T11:00:00Z",
      completedAt: "2026-04-26T11:00:00Z",
    };
    // Whether the cursor is null, before, equal, or after — completedAt
    // wins. This keeps source_id (and therefore atom id) stable across
    // re-polls, so Module A's dedup-by-id holds.
    expect(classifyIssueAction(issue, null)).toBe("issue_completed");
    expect(classifyIssueAction(issue, "2026-04-26T10:00:00Z")).toBe("issue_completed");
    expect(classifyIssueAction(issue, "2026-04-26T11:00:00Z")).toBe("issue_completed");
    expect(classifyIssueAction(issue, "2026-04-26T12:00:00Z")).toBe("issue_completed");
  });
  it("seen-before active issue → issue_state_changed", () => {
    const issue: LinearIssue = {
      id: "x", identifier: "ENG-4", title: "x", description: null,
      priority: 0,
      createdAt: "2026-04-25T08:00:00Z",
      updatedAt: "2026-04-26T11:00:00Z",
    };
    expect(classifyIssueAction(issue, "2026-04-26T10:00:00Z")).toBe("issue_state_changed");
  });
});

describe("normalizeIssue (created)", () => {
  const raw = fx("issue_created.json") as LinearIssue;
  const a = normalizeIssue(raw, ctx, null);

  it("emits a Module-A canonical id", () => {
    expect(a.id).toMatch(MODULE_A_ID_RE);
  });
  it("kind = ticket_event with action = issue_created", () => {
    expect(a.kind).toBe("ticket_event");
    expect(a.refs.linear?.action).toBe("issue_created");
  });
  it("source_id is namespaced to team + verb", () => {
    expect(a.source_id).toBe("linear:ENG:ticket_event:ENG-123:issue_created");
  });
  it("ts uses createdAt", () => {
    expect(a.ts).toBe("2026-04-26T09:00:00.000Z");
  });
  it("actor resolved from creator email", () => {
    expect(a.actor).toBe("eric");
  });
  it("@mentions resolved into actors", () => {
    expect(a.actors).toContain("daizhe");
  });
  it("project extracted from label prefix and title", () => {
    expect(a.refs.projects.sort()).toEqual(["v1", "v1-launch"]);
  });
  it("thread id is linear-<lowercase identifier>", () => {
    expect(a.refs.threads).toEqual(["linear-eng-123"]);
  });
  it("body opens with actor + identifier + title", () => {
    expect(a.body).toContain("**eric** created ENG-123");
    expect(a.body).toContain("postgres migration");
  });
  it("ships Stage 2 AGI defaults (8 fields)", () => {
    expect(a.embedding).toBeNull();
    expect(a.concepts).toEqual([]);
    expect(a.confidence).toBe(1.0);
    expect(a.alternatives).toEqual([]);
    expect(a.source_count).toBe(1);
    expect(a.reasoning_notes).toBeNull();
    expect(a.sentiment).toBeNull();
    expect(a.importance).toBeNull();
  });
  it("refs.linear includes state + priority + uuid", () => {
    expect(a.refs.linear?.state).toBe("Todo");
    expect(a.refs.linear?.priority).toBe(2);
    expect(a.refs.linear?.issue_uuid).toBe("uuid-issue-eng-123");
  });
});

describe("normalizeIssue (completed → decision sniff)", () => {
  const raw = fx("issue_completed.json") as LinearIssue;
  const a = normalizeIssue(raw, ctx, "2026-04-26T10:00:00Z");

  it("kind upgraded to decision (description matches sniffer)", () => {
    expect(a.kind).toBe("decision");
    expect(a.refs.linear?.action).toBe("issue_completed");
  });
  it("ts uses completedAt", () => {
    expect(a.ts).toBe("2026-04-26T11:00:00.000Z");
  });
  it("body shows completion lead", () => {
    expect(a.body).toContain("**eric** completed ENG-123");
  });
});

describe("normalizeIssue (canceled)", () => {
  const raw = fx("issue_canceled.json") as LinearIssue;
  const a = normalizeIssue(raw, ctx, null);

  it("kind = ticket_event with action = issue_canceled", () => {
    expect(a.kind).toBe("ticket_event");
    expect(a.refs.linear?.action).toBe("issue_canceled");
  });
  it("ts uses canceledAt", () => {
    expect(a.ts).toBe("2026-04-26T10:30:00.000Z");
  });
  it("body shows cancel lead", () => {
    expect(a.body).toContain("canceled ENG-99");
  });
});

describe("normalizeIssue id stability", () => {
  it("same input → same id", () => {
    const raw = fx("issue_created.json") as LinearIssue;
    const a1 = normalizeIssue(raw, ctx, null);
    const a2 = normalizeIssue(raw, ctx, null);
    expect(a1.id).toBe(a2.id);
  });
  it("same issue, different verbs → different ids", () => {
    const created = fx("issue_created.json") as LinearIssue;
    const completed = fx("issue_completed.json") as LinearIssue;
    const a1 = normalizeIssue(created, ctx, null);
    const a2 = normalizeIssue(completed, ctx, "2026-04-26T10:00:00Z");
    expect(a1.id).not.toBe(a2.id);
  });
});

describe("normalizeComment", () => {
  const raw = fx("comment.json") as LinearComment;
  const a = normalizeComment(raw, ctx);

  it("emits a Module-A canonical id", () => {
    expect(a.id).toMatch(MODULE_A_ID_RE);
  });
  it("kind = comment", () => {
    expect(a.kind).toBe("comment");
  });
  it("source_id encodes team + parent issue + comment id", () => {
    expect(a.source_id).toBe("linear:ENG:comment:comment:ENG-123:uuid-comment-987");
  });
  it("attaches to parent issue's thread", () => {
    expect(a.refs.threads).toEqual(["linear-eng-123"]);
  });
  it("body shows blockquoted original text", () => {
    expect(a.body).toContain("> @daizhe");
  });
  it("@mentions resolved into actors", () => {
    expect(a.actors).toContain("daizhe");
  });
});

describe("normalizeComment (decision sniff promotes kind)", () => {
  const raw = fx("comment_decision.json") as LinearComment;
  const a = normalizeComment(raw, ctx);
  it("kind upgraded to decision", () => {
    expect(a.kind).toBe("decision");
  });
  it("source_id reflects the upgraded kind", () => {
    expect(a.source_id).toContain("decision:");
  });
});
