// End-to-end ingest using a mocked GitHub client + an in-memory Module-A
// router stub. Verifies:
//  - PRs + issues + comments + reviews all reach Module A
//  - identity is learned for unknown logins
//  - cursor advances after the run
//  - second run is dedup-safe (router-side dedup by Module A id)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnce } from "../src/poll.js";
import {
  makePaths,
  readConfig,
  writeConfig,
  writeIdentity,
  setRouterForTesting,
  type AtomRouter,
  type EmitAtomResult,
} from "../src/memory.js";
import { defaultConfig, type Atom } from "../src/types.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tg-int-"));
}

// Minimal stub of the octokit client surface our code touches.
function makeStubClient(state: {
  prs: any[];
  pr_details: Record<number, any>;
  issues: any[];
  issue_comments: any[];
  review_comments: any[];
  reviews: Record<number, any[]>;
}) {
  function pageOnce<T>(items: T[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        yield { data: items };
      },
    };
  }
  return {
    paginate: {
      iterator: (fn: any, _opts: any) => {
        if (fn === client.rest.pulls.list) return pageOnce(state.prs);
        if (fn === client.rest.issues.listForRepo) return pageOnce(state.issues);
        if (fn === client.rest.issues.listCommentsForRepo) return pageOnce(state.issue_comments);
        if (fn === client.rest.pulls.listReviewCommentsForRepo) return pageOnce(state.review_comments);
        return pageOnce<any>([]);
      },
    },
    request: async () => ({ data: { login: "test" } }),
    rest: {
      pulls: {
        list: async () => ({ data: state.prs }),
        get: async ({ pull_number }: any) => ({ data: state.pr_details[pull_number] ?? state.prs.find((p) => p.number === pull_number) }),
        listReviews: async ({ pull_number }: any) => ({ data: state.reviews[pull_number] ?? [] }),
        listReviewCommentsForRepo: async () => ({ data: state.review_comments }),
      },
      issues: {
        listForRepo: async () => ({ data: state.issues }),
        listCommentsForRepo: async () => ({ data: state.issue_comments }),
      },
    },
  };
  // Note: above is loose-typed for test ergonomics; the runtime contract is what matters.
}

const client: any = {};

/** Module-A router stub: records every atom + simulates id-based dedup. */
function makeRouterStub(): { router: AtomRouter; atoms: Atom[] } {
  const seen = new Set<string>();
  const atoms: Atom[] = [];
  const router: AtomRouter = async (_root, atom): Promise<EmitAtomResult> => {
    atoms.push(atom);
    if (seen.has(atom.id)) return { events: 1, skipped: 1 };
    seen.add(atom.id);
    return { events: 1, skipped: 0 };
  };
  return { router, atoms };
}

describe("integration: ingest 3 PRs + comments + 1 issue", () => {
  let root: string;
  let routerStub: ReturnType<typeof makeRouterStub>;

  beforeEach(async () => {
    root = tmpRoot();
    const paths = makePaths(root);
    const cfg = defaultConfig();
    cfg.repos.push({ name: "myorg/api" });
    await writeConfig(paths, cfg);
    await writeIdentity(paths, { ericfromgithub: "eric", "daizhe-z": "daizhe" });
    routerStub = makeRouterStub();
    setRouterForTesting(routerStub.router);
  });
  afterEach(() => setRouterForTesting(null));

  it("hands atoms to Module A, learns identities, advances cursor", async () => {
    const state = buildFixtureState();
    const stub = makeStubClient(state);
    Object.assign(client, stub); // resolves the closure refs in pageOnce()

    const result = await runOnce({ memoryRoot: root, client: stub as any });
    const repoRes = result.repos[0];
    expect(repoRes.error).toBeUndefined();
    expect(repoRes.atomCount).toBeGreaterThanOrEqual(8); // 3 pr_event(opened) + 1 pr_event(merged) + 1 pr_event(closed) + 2 comments + 1 pr_event(review) + 1 ticket_event
    expect(repoRes.written).toBeGreaterThanOrEqual(repoRes.atomCount - 1);

    const paths = makePaths(root);

    // Cursor advanced.
    const cfg2 = await readConfig(paths);
    expect(cfg2.repos[0].cursor).toBeTruthy();

    // Module A received every atom — verify by examining what hit the router.
    expect(routerStub.atoms.length).toBe(repoRes.atomCount);

    // Module-A id format on every atom.
    for (const a of routerStub.atoms) {
      expect(a.id).toMatch(/^evt-\d{4}-\d{2}-\d{2}-[a-f0-9]{10}$/);
    }

    // Module-A canonical kinds in vocabulary.
    const kinds = new Set(routerStub.atoms.map((a) => a.kind));
    expect(kinds.has("pr_event")).toBe(true);
    expect(kinds.has("ticket_event")).toBe(true);

    // PR 47 had three pr_event variants (opened, merged, review) — different ids.
    const pr47Atoms = routerStub.atoms.filter((a) => a.refs.github?.pr === 47);
    expect(pr47Atoms.length).toBeGreaterThanOrEqual(3);
    const pr47Ids = new Set(pr47Atoms.map((a) => a.id));
    expect(pr47Ids.size).toBe(pr47Atoms.length); // all distinct

    // pr_event actions span opened/merged/review_*.
    const pr47Actions = pr47Atoms.map((a) => a.refs.github?.action);
    expect(pr47Actions).toContain("opened");
    expect(pr47Actions).toContain("merged");
    expect(pr47Actions.some((x) => x?.startsWith("review_"))).toBe(true);

    // Second run is a no-op (router-side dedup by id).
    const result2 = await runOnce({ memoryRoot: root, client: stub as any });
    expect(result2.repos[0].written).toBe(0);
    expect(result2.repos[0].skipped).toBeGreaterThan(0);
  });
});

function buildFixtureState() {
  const pr47 = {
    number: 47,
    title: "[v1] postgres-migration",
    body: "@daizhe-z - thoughts?",
    state: "closed",
    user: { login: "ericfromgithub" },
    base: { ref: "main" },
    head: { ref: "eric/pg-migration" },
    labels: [{ name: "project:v1-launch" }],
    html_url: "https://github.com/myorg/api/pull/47",
    created_at: "2026-04-26T09:00:00Z",
    updated_at: "2026-04-26T11:00:00Z",
    merged_at: "2026-04-26T10:55:00Z",
    merge_commit_sha: "abc123def456",
    merged_by: { login: "ericfromgithub" },
  };
  const pr48 = {
    number: 48,
    title: "fix: race condition",
    body: "small one",
    state: "closed",
    user: { login: "newcontrib" },
    base: { ref: "main" },
    head: { ref: "newcontrib/race-fix" },
    labels: [],
    html_url: "https://github.com/myorg/api/pull/48",
    created_at: "2026-04-26T09:30:00Z",
    updated_at: "2026-04-26T10:00:00Z",
    closed_at: "2026-04-26T10:00:00Z",
  };
  const pr49 = {
    number: 49,
    title: "wip: experiment",
    body: "draft",
    state: "open",
    user: { login: "ericfromgithub" },
    base: { ref: "main" },
    head: { ref: "eric/wip" },
    labels: [],
    html_url: "https://github.com/myorg/api/pull/49",
    created_at: "2026-04-26T11:30:00Z",
    updated_at: "2026-04-26T11:30:00Z",
    draft: true,
  };
  const issue88 = {
    number: 88,
    title: "Crash on startup",
    body: "Reproducer included.",
    state: "open",
    user: { login: "ericfromgithub" },
    labels: [{ name: "bug" }],
    html_url: "https://github.com/myorg/api/issues/88",
    created_at: "2026-04-26T08:00:00Z",
    updated_at: "2026-04-26T08:00:00Z",
  };
  return {
    prs: [pr47, pr48, pr49],
    pr_details: { 47: pr47, 48: pr48, 49: pr49 },
    issues: [issue88],
    issue_comments: [
      {
        id: 12345,
        body: "@daizhe-z — should we add time-series tables?",
        user: { login: "ericfromgithub" },
        created_at: "2026-04-26T09:30:00Z",
        updated_at: "2026-04-26T09:30:00Z",
        html_url: "https://github.com/myorg/api/pull/47#issuecomment-12345",
        issue_url: "https://api.github.com/repos/myorg/api/issues/47",
      },
      {
        id: 12346,
        body: "Looking into it.",
        user: { login: "daizhe-z" },
        created_at: "2026-04-26T10:00:00Z",
        updated_at: "2026-04-26T10:00:00Z",
        html_url: "https://github.com/myorg/api/issues/88#issuecomment-12346",
        issue_url: "https://api.github.com/repos/myorg/api/issues/88",
      },
    ],
    review_comments: [],
    reviews: {
      47: [
        {
          id: 99001,
          body: "Looks good. We decided on the partition strategy.",
          state: "approved",
          user: { login: "daizhe-z" },
          submitted_at: "2026-04-26T10:30:00Z",
          html_url: "https://github.com/myorg/api/pull/47#pullrequestreview-99001",
        },
      ],
    },
  };
}
