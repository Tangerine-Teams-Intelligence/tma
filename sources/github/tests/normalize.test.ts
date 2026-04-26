// Normalize: GitHub payloads → atoms. Loads real fixtures.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizePr,
  normalizePrMerged,
  normalizePrClosed,
  normalizeComment,
  normalizeReview,
  normalizeIssue,
  normalizeIssueClosed,
  makeCtx,
  extractMentions,
  extractProjects,
  looksLikeDecision,
  aliasFor,
  slugRepo,
  type RawPr,
  type RawComment,
  type RawReview,
  type RawIssue,
} from "../src/normalize.js";
import { defaultConfig, type IdentityMap } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

const identity: IdentityMap = { ericfromgithub: "eric", "daizhe-z": "daizhe" };
const cfg = defaultConfig();
const ctx = makeCtx("myorg/api", identity, cfg);

describe("alias resolution", () => {
  it("maps known github logins to tangerine aliases", () => {
    expect(aliasFor("ericfromgithub", identity)).toBe("eric");
    expect(aliasFor("daizhe-z", identity)).toBe("daizhe");
  });
  it("returns the raw login when unknown", () => {
    expect(aliasFor("strangerdanger", identity)).toBe("strangerdanger");
  });
  it("returns 'unknown' for null/empty", () => {
    expect(aliasFor(null, identity)).toBe("unknown");
    expect(aliasFor(undefined, identity)).toBe("unknown");
    expect(aliasFor("", identity)).toBe("unknown");
  });
});

describe("mention extraction", () => {
  it("extracts @mentions and resolves them", () => {
    const m = extractMentions("ping @daizhe-z and @ericfromgithub", identity);
    expect(m).toContain("daizhe");
    expect(m).toContain("eric");
    expect(m.length).toBe(2);
  });
  it("handles email/non-mention @ symbols", () => {
    const m = extractMentions("contact me at foo@bar.com about @daizhe-z", identity);
    // foo@bar should NOT match because the @ isn't preceded by ws/start
    expect(m).toEqual(["daizhe"]);
  });
  it("returns [] for null/empty", () => {
    expect(extractMentions(null, identity)).toEqual([]);
    expect(extractMentions("", identity)).toEqual([]);
  });
  it("dedups", () => {
    const m = extractMentions("@daizhe-z hi @daizhe-z again", identity);
    expect(m).toEqual(["daizhe"]);
  });
});

describe("project extraction", () => {
  it("pulls projects from configured label prefix", () => {
    const p = extractProjects([{ name: "project:v1-launch" }, { name: "bug" }], null, cfg);
    expect(p).toEqual(["v1-launch"]);
  });
  it("pulls projects from title regex", () => {
    const p = extractProjects([], "[v2] new feature", cfg);
    expect(p).toEqual(["v2"]);
  });
  it("merges label + title sources", () => {
    const p = extractProjects([{ name: "project:foo" }], "[bar] thing", cfg);
    expect(p.sort()).toEqual(["bar", "foo"]);
  });
  it("returns [] when nothing matches", () => {
    expect(extractProjects([], "no prefix", cfg)).toEqual([]);
  });
});

describe("decision sniffer", () => {
  it("flags clear decision verbs", () => {
    expect(looksLikeDecision("we decided to use Postgres")).toBe(true);
    expect(looksLikeDecision("agreed — going with rust")).toBe(true);
    expect(looksLikeDecision("we'll go with the partition strategy")).toBe(true);
    expect(looksLikeDecision("Let's go with yaml")).toBe(true);
    expect(looksLikeDecision("Conclusion: ship it")).toBe(true);
  });
  it("does not flag idle chatter", () => {
    expect(looksLikeDecision("I think we should ship it")).toBe(false);
    expect(looksLikeDecision("any thoughts on this?")).toBe(false);
    expect(looksLikeDecision(null)).toBe(false);
    expect(looksLikeDecision("")).toBe(false);
  });
});

describe("slugRepo", () => {
  it("makes filesystem-safe slugs", () => {
    expect(slugRepo("MyOrg/API")).toBe("myorg-api");
    expect(slugRepo("a.b/c.d_e")).toBe("a-b-c-d-e");
  });
});

describe("normalizePr", () => {
  const raw = fixtures("pr_opened.json") as RawPr;
  const a = normalizePr(raw, ctx);

  it("emits the right id, kind, source", () => {
    expect(a.id).toBe("evt-gh-myorg-api-pr-47-opened");
    expect(a.kind).toBe("pr_opened");
    expect(a.source).toBe("github");
  });
  it("normalizes ts to UTC RFC 3339", () => {
    expect(a.ts).toBe("2026-04-26T09:00:00.000Z");
  });
  it("resolves the actor alias", () => {
    expect(a.actor).toBe("eric");
  });
  it("includes mentioned actors", () => {
    expect(a.actors).toContain("eric");
    expect(a.actors).toContain("daizhe");
    expect(a.actors).toContain("hongyu"); // unmapped — falls through as raw login
  });
  it("attaches github refs", () => {
    expect(a.refs.github).toEqual({
      repo: "myorg/api",
      pr: 47,
      url: "https://github.com/myorg/api/pull/47",
    });
  });
  it("detects projects from labels and title", () => {
    expect(a.refs.projects.sort()).toEqual(["v1", "v1-launch"]);
  });
  it("creates the per-PR thread", () => {
    expect(a.refs.threads).toEqual(["pr-myorg-api-47"]);
  });
  it("body opens with the actor + PR number + title", () => {
    expect(a.body).toContain("**eric** opened PR #47");
    expect(a.body).toContain("postgres-migration");
    expect(a.body).toContain("eric/pg-migration → main");
    expect(a.body).toContain("Original at: https://github.com/myorg/api/pull/47");
  });
});

describe("normalizePrMerged", () => {
  const raw = fixtures("pr_merged.json") as RawPr;
  const a = normalizePrMerged(raw, ctx);
  it("uses merged_at as ts and merger as actor", () => {
    expect(a.kind).toBe("pr_merged");
    expect(a.ts).toBe("2026-04-26T10:55:00.000Z");
    expect(a.actor).toBe("eric");
  });
  it("includes truncated merge SHA in body", () => {
    expect(a.body).toContain("abc123def456");
  });
});

describe("normalizePrClosed", () => {
  it("emits pr_closed when not merged", () => {
    const raw = { ...fixtures("pr_merged.json"), merged_at: null, merge_commit_sha: null, closed_at: "2026-04-26T11:00:00Z" } as RawPr;
    const a = normalizePrClosed(raw, ctx);
    expect(a.kind).toBe("pr_closed");
    expect(a.body).toContain("closed without merge");
  });
});

describe("normalizeComment (PR conversation)", () => {
  const c = fixtures("pr_comment.json") as Omit<RawComment, "parentNumber" | "parentKind">;
  const raw: RawComment = { ...c, parentNumber: 47, parentKind: "pr", parentTitle: "postgres-migration" };
  const a = normalizeComment(raw, ctx);

  it("emits stable id with comment_id", () => {
    expect(a.id).toBe("evt-gh-myorg-api-pr-47-comment-12345");
  });
  it("kind = pr_comment", () => {
    expect(a.kind).toBe("pr_comment");
  });
  it("attaches ref to the parent PR thread", () => {
    expect(a.refs.threads).toEqual(["pr-myorg-api-47"]);
  });
  it("body shows blockquoted original text", () => {
    expect(a.body).toContain("> @daizhe");
  });
  it("@mentions resolved into actors", () => {
    expect(a.actors).toContain("eric");
    expect(a.actors).toContain("daizhe");
  });
});

describe("normalizeComment (decision sniff upgrades kind)", () => {
  const raw: RawComment = {
    id: 999,
    body: "we decided to use yaml",
    user: { login: "daizhe-z" },
    created_at: "2026-04-26T09:00:00Z",
    parentNumber: 88,
    parentKind: "issue",
  };
  const a = normalizeComment(raw, ctx);
  it("kind upgraded to decision", () => {
    expect(a.kind).toBe("decision");
  });
});

describe("normalizeReview", () => {
  const raw = fixtures("pr_review.json") as Omit<RawReview, "parentNumber">;
  const r: RawReview = { ...raw, parentNumber: 47, parentTitle: "postgres-migration" };
  const a = normalizeReview(r, ctx);
  it("kind = pr_review and includes verb form", () => {
    expect(a.kind).toBe("pr_review");
    expect(a.body).toContain("approved PR #47");
  });
  it("changes_requested gets the right verb", () => {
    const a2 = normalizeReview({ ...r, state: "changes_requested" }, ctx);
    expect(a2.body).toContain("requested changes on PR #47");
  });
});

describe("normalizeIssue", () => {
  const raw = fixtures("issue_opened.json") as RawIssue;
  const a = normalizeIssue(raw, ctx);
  it("kind = issue_opened", () => {
    expect(a.kind).toBe("issue_opened");
  });
  it("string labels work too", () => {
    expect(a.refs.projects).toContain("reliability");
  });
  it("uses issue thread id", () => {
    expect(a.refs.threads).toEqual(["issue-myorg-api-88"]);
  });
});

describe("normalizeIssueClosed", () => {
  const raw = fixtures("issue_closed.json") as RawIssue;
  const a = normalizeIssueClosed(raw, ctx);
  it("kind = issue_closed and includes reason", () => {
    expect(a.kind).toBe("issue_closed");
    expect(a.body).toContain("(reason: completed)");
  });
});
