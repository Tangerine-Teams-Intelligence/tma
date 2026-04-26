// Memory I/O — config + identity + Module-A router integration.
//
// We don't shell out to Python in unit tests. setRouterForTesting() injects
// a deterministic in-memory router that records every emit-atom call so
// assertions can verify the exact JSON payload Module A would receive.
// The integration test (integration.test.ts) exercises the full flow with
// the same stub.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makePaths,
  writeAtom,
  writeAtoms,
  readConfig,
  writeConfig,
  readIdentity,
  writeIdentity,
  learnIdentities,
  setRouterForTesting,
  utcDate,
  _atomToPayloadForTesting,
  type AtomRouter,
  type EmitAtomResult,
} from "../src/memory.js";
import { defaultConfig, type Atom } from "../src/types.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tg-mem-"));
}

function fakeAtom(overrides: Partial<Atom> = {}): Atom {
  return {
    id: "evt-2026-04-26-aaaaaaaaaa",
    ts: "2026-04-26T09:00:00.000Z",
    source: "github",
    actor: "eric",
    actors: ["eric", "daizhe"],
    kind: "pr_event",
    source_id: "gh:myorg/api:pr_event:47:opened",
    refs: {
      github: { repo: "myorg/api", pr: 47, url: "https://github.com/myorg/api/pull/47", action: "opened" },
      meeting: null,
      decisions: [],
      people: ["eric", "daizhe"],
      projects: ["v1-launch"],
      threads: ["pr-myorg-api-47"],
    },
    status: "active",
    sample: false,
    body: "**eric** opened PR #47 (eric/pg-migration → main): _postgres-migration_",
    embedding: null,
    concepts: [],
    confidence: 1.0,
    alternatives: [],
    source_count: 1,
    reasoning_notes: null,
    sentiment: null,
    importance: null,
    ...overrides,
  };
}

/** Stub router — records calls in-memory + simulates Module-A dedup by id. */
function makeStubRouter(): { router: AtomRouter; calls: { root: string; atom: Atom }[] } {
  const seenIds = new Set<string>();
  const calls: { root: string; atom: Atom }[] = [];
  const router: AtomRouter = async (root, atom): Promise<EmitAtomResult> => {
    calls.push({ root, atom });
    if (seenIds.has(atom.id)) return { events: 1, skipped: 1 };
    seenIds.add(atom.id);
    return { events: 1, skipped: 0 };
  };
  return { router, calls };
}

describe("utcDate", () => {
  it("extracts YYYY-MM-DD prefix", () => {
    expect(utcDate("2026-04-26T09:30:00.000Z")).toBe("2026-04-26");
  });
});

describe("config IO", () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  it("returns defaults when no file exists", async () => {
    const c = await readConfig(makePaths(root));
    expect(c).toEqual(defaultConfig());
  });
  it("round-trips through writeConfig", async () => {
    const paths = makePaths(root);
    const c = defaultConfig();
    c.repos.push({ name: "foo/bar", projects: ["x"] });
    await writeConfig(paths, c);
    const read = await readConfig(paths);
    expect(read.repos).toHaveLength(1);
    expect(read.repos[0].name).toBe("foo/bar");
  });
});

describe("identity IO + learning", () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  it("returns empty map when missing", async () => {
    expect(await readIdentity(makePaths(root))).toEqual({});
  });
  it("self-maps unseen logins", async () => {
    const paths = makePaths(root);
    await writeIdentity(paths, { existing: "alice" });
    const out = await learnIdentities(paths, ["existing", "newdev", "newdev"]);
    expect(out.existing).toBe("alice");
    expect(out.newdev).toBe("newdev");
    const persisted = await readIdentity(paths);
    expect(persisted.newdev).toBe("newdev");
  });
});

describe("payload conversion for Module A emit-atom", () => {
  it("flattens the atom into the JSON shape daemon_cli expects", () => {
    const p = _atomToPayloadForTesting(fakeAtom());
    expect(p.id).toBe("evt-2026-04-26-aaaaaaaaaa");
    expect(p.source).toBe("github");
    expect(p.kind).toBe("pr_event");
    expect(p.source_id).toBe("gh:myorg/api:pr_event:47:opened");
    // refs become a plain object — Module A reads sub-keys.
    const refs = p.refs as Record<string, unknown>;
    expect(refs.threads).toEqual(["pr-myorg-api-47"]);
    expect(refs.people).toEqual(["eric", "daizhe"]);
    expect(refs.projects).toEqual(["v1-launch"]);
    expect((refs.github as Record<string, unknown>).action).toBe("opened");
  });
  it("populates all 8 Stage 2 AGI defaults if missing", () => {
    const p = _atomToPayloadForTesting(fakeAtom({ embedding: undefined as unknown as null }));
    expect(p.embedding).toBeNull();
    expect(p.concepts).toEqual([]);
    expect(p.confidence).toBe(1.0);
    expect(p.alternatives).toEqual([]);
    expect(p.source_count).toBe(1);
    expect(p.reasoning_notes).toBeNull();
    expect(p.sentiment).toBeNull();
    expect(p.importance).toBeNull();
  });
});

describe("writeAtom — Module A integration", () => {
  let root: string;
  let stub: ReturnType<typeof makeStubRouter>;

  beforeEach(() => {
    root = tmpRoot();
    stub = makeStubRouter();
    setRouterForTesting(stub.router);
  });
  afterEach(() => setRouterForTesting(null));

  it("hands the atom to Module A's router", async () => {
    const paths = makePaths(root);
    const atom = fakeAtom();
    const r = await writeAtom(paths, atom);
    expect(r.wroteTimeline).toBe(true);
    expect(r.wroteThreadFiles).toBe(1); // refs.threads.length
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].root).toBe(root);
    expect(stub.calls[0].atom.id).toBe(atom.id);
  });

  it("router-side dedup surfaces as skipped on second call", async () => {
    const paths = makePaths(root);
    await writeAtom(paths, fakeAtom());
    const r = await writeAtom(paths, fakeAtom());
    expect(r.wroteTimeline).toBe(false);
    expect(stub.calls).toHaveLength(2);  // both calls reach Module A
  });

  it("multiple threads → wroteThreadFiles count matches", async () => {
    const paths = makePaths(root);
    const atom = fakeAtom({
      refs: {
        ...fakeAtom().refs,
        threads: ["pr-myorg-api-47", "epic-postgres"],
      },
    });
    const r = await writeAtom(paths, atom);
    expect(r.wroteThreadFiles).toBe(2);
  });
});

describe("writeAtoms batch", () => {
  let root: string;
  let stub: ReturnType<typeof makeStubRouter>;

  beforeEach(() => {
    root = tmpRoot();
    stub = makeStubRouter();
    setRouterForTesting(stub.router);
  });
  afterEach(() => setRouterForTesting(null));

  it("counts written vs skipped (router-side dedup)", async () => {
    const paths = makePaths(root);
    const a1 = fakeAtom();
    const a2 = fakeAtom({ id: "evt-2026-04-26-bbbbbbbbbb", ts: "2026-04-26T09:30:00.000Z" });
    const first = await writeAtoms(paths, [a1, a2]);
    expect(first.written).toBe(2);
    expect(first.skipped).toBe(0);
    const second = await writeAtoms(paths, [a1, a2]);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it("sorts by ts before handing to Module A", async () => {
    const paths = makePaths(root);
    const later = fakeAtom({ id: "evt-2026-04-27-aaaaaaaaaa", ts: "2026-04-27T08:00:00.000Z" });
    const earlier = fakeAtom({ id: "evt-2026-04-26-bbbbbbbbbb", ts: "2026-04-26T08:00:00.000Z" });
    await writeAtoms(paths, [later, earlier]);
    expect(stub.calls.map((c) => c.atom.id)).toEqual([
      "evt-2026-04-26-bbbbbbbbbb",
      "evt-2026-04-27-aaaaaaaaaa",
    ]);
  });
});
