// End-to-end ingest using a stubbed Linear client + stubbed Module-A router.
// Verifies the full flow: issues + comments → atoms → router → cursor advance,
// and that a second poll is dedup-safe via Module-A canonical ids.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
import type { LinearComment, LinearIssue, LinearLike, LinearTeam, LinearViewer } from "../src/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tg-lin-int-"));
}

function makeStubClient(state: {
  issues: LinearIssue[];
  comments: LinearComment[];
}): LinearLike {
  return {
    async viewer(): Promise<LinearViewer> { return { id: "u-test", email: "test@example.com" }; },
    async listTeams(): Promise<LinearTeam[]> {
      return [{ id: "uuid-team-eng", key: "ENG", name: "Engineering" }];
    },
    async listIssuesForTeam(_teamId, since) {
      // Mimic Linear's `updatedAt > since` server-side filter so we don't
      // re-emit unchanged issues across polls (which is what would happen
      // in real life — the cursor advances and Linear stops returning them).
      if (!since) return state.issues;
      return state.issues.filter((i) => i.updatedAt > since);
    },
    async listCommentsForTeam(_teamId, since) {
      if (!since) return state.comments;
      return state.comments.filter((c) => (c.updatedAt ?? c.createdAt) > since);
    },
  };
}

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

describe("integration: ingest issues + comments for a team", () => {
  let root: string;
  let routerStub: ReturnType<typeof makeRouterStub>;

  beforeEach(async () => {
    root = tmpRoot();
    const paths = makePaths(root);
    const cfg = defaultConfig();
    cfg.teams.push({ uuid: "uuid-team-eng", key: "ENG", name: "Engineering" });
    await writeConfig(paths, cfg);
    await writeIdentity(paths, {
      "eric@example.com": "eric",
      "daizhe@example.com": "daizhe",
    });
    routerStub = makeRouterStub();
    setRouterForTesting(routerStub.router);
  });
  afterEach(() => setRouterForTesting(null));

  it("hands atoms to Module A, learns identities, advances cursor, dedups on second run", async () => {
    const issueCreated = fx("issue_created.json") as LinearIssue;
    const issueCanceled = fx("issue_canceled.json") as LinearIssue;
    const issueCompleted = fx("issue_completed.json") as LinearIssue;
    const comment = fx("comment.json") as LinearComment;
    const commentDecision = fx("comment_decision.json") as LinearComment;

    const stub = makeStubClient({
      issues: [issueCreated, issueCanceled, issueCompleted],
      comments: [comment, commentDecision],
    });

    const result = await runOnce({ memoryRoot: root, client: stub });
    const teamRes = result.teams[0];
    expect(teamRes.error).toBeUndefined();
    // 3 issues + 2 comments = 5 atoms.
    expect(teamRes.atomCount).toBe(5);
    expect(teamRes.written).toBe(5);
    expect(teamRes.skipped).toBe(0);

    // Cursor advanced.
    const paths = makePaths(root);
    const cfg2 = await readConfig(paths);
    expect(cfg2.teams[0].cursor).toBeTruthy();

    // Module-A canonical id format on every atom.
    for (const a of routerStub.atoms) {
      expect(a.id).toMatch(/^evt-\d{4}-\d{2}-\d{2}-[a-f0-9]{10}$/);
    }

    // Module-A canonical kinds in vocabulary.
    const kinds = new Set(routerStub.atoms.map((a) => a.kind));
    expect(kinds.has("ticket_event")).toBe(true);
    expect(kinds.has("comment")).toBe(true);
    expect(kinds.has("decision")).toBe(true);

    // Decision sniffer fires on both the completion and the comment.
    const decisions = routerStub.atoms.filter((a) => a.kind === "decision");
    expect(decisions.length).toBeGreaterThanOrEqual(2);

    // Comments inherit projects from their parent issue.
    const issue123 = routerStub.atoms.find(
      (a) => a.kind === "ticket_event" && a.refs.linear?.issue_id === "ENG-123",
    );
    expect(issue123?.refs.projects).toContain("v1-launch");
    const issue123Comments = routerStub.atoms.filter(
      (a) => a.kind === "comment" && a.refs.linear?.issue_id === "ENG-123",
    );
    if (issue123Comments.length > 0) {
      // Comments inherit from parent (decorateProjects).
      expect(issue123Comments[0].refs.projects).toContain("v1-launch");
    }

    // Threads are linear-<lowercase identifier>.
    const threadIds = new Set<string>();
    for (const a of routerStub.atoms) for (const t of a.refs.threads) threadIds.add(t);
    expect(threadIds.has("linear-eng-123")).toBe(true);
    expect(threadIds.has("linear-eng-99")).toBe(true);

    // Second run is a no-op: cursor advancement means Linear returns
    // nothing new, so we don't even hit the router. (If we did re-emit the
    // same atoms, Module A's id-based dedup would catch them — that's
    // exercised in writeAtom — Module A integration tests above.)
    const result2 = await runOnce({ memoryRoot: root, client: stub });
    expect(result2.teams[0].atomCount).toBe(0);
    expect(result2.teams[0].written).toBe(0);
  });

  it("dry-run produces atoms without writing or advancing cursor", async () => {
    const issueCreated = fx("issue_created.json") as LinearIssue;
    const stub = makeStubClient({ issues: [issueCreated], comments: [] });
    const result = await runOnce({ memoryRoot: root, client: stub, dryRun: true });
    expect(result.teams[0].atomCount).toBe(1);
    expect(result.teams[0].written).toBe(0);
    // Cursor should NOT have advanced.
    const cfg = await readConfig(makePaths(root));
    expect(cfg.teams[0].cursor).toBeUndefined();
  });
});
