// Memory IO + Module-A router integration. Same shape as the github
// connector's memory tests — see that file for the rationale.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makePaths,
  readConfig,
  writeConfig,
  readIdentity,
  writeIdentity,
  learnIdentities,
  writeAtom,
  writeAtoms,
  setRouterForTesting,
  _atomToPayloadForTesting,
  type AtomRouter,
  type EmitAtomResult,
} from "../src/memory.js";
import { defaultConfig, type Atom } from "../src/types.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tg-lin-mem-"));
}

function fakeAtom(overrides: Partial<Atom> = {}): Atom {
  return {
    id: "evt-2026-04-26-aaaaaaaaaa",
    ts: "2026-04-26T09:00:00.000Z",
    source: "linear",
    actor: "eric",
    actors: ["eric", "daizhe"],
    kind: "ticket_event",
    source_id: "linear:ENG:ticket_event:ENG-123:issue_created",
    refs: {
      linear: {
        team_key: "ENG",
        issue_id: "ENG-123",
        issue_uuid: "uuid-issue-eng-123",
        state: "Todo",
        priority: 2,
        url: "https://linear.app/myorg/issue/ENG-123",
        action: "issue_created",
      },
      meeting: null,
      decisions: [],
      people: ["eric", "daizhe"],
      projects: ["v1-launch"],
      threads: ["linear-eng-123"],
    },
    status: "active",
    sample: false,
    body: "**eric** created ENG-123: _Add postgres migration_",
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

function makeStubRouter(): { router: AtomRouter; calls: { root: string; atom: Atom }[] } {
  const seen = new Set<string>();
  const calls: { root: string; atom: Atom }[] = [];
  const router: AtomRouter = async (root, atom): Promise<EmitAtomResult> => {
    calls.push({ root, atom });
    if (seen.has(atom.id)) return { events: 1, skipped: 1 };
    seen.add(atom.id);
    return { events: 1, skipped: 0 };
  };
  return { router, calls };
}

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
    c.teams.push({ uuid: "uuid-1", key: "ENG", name: "Engineering" });
    await writeConfig(paths, c);
    const read = await readConfig(paths);
    expect(read.teams).toHaveLength(1);
    expect(read.teams[0].key).toBe("ENG");
  });
});

describe("identity IO + learning", () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  it("returns empty map when missing", async () => {
    expect(await readIdentity(makePaths(root))).toEqual({});
  });
  it("self-maps unseen handles", async () => {
    const paths = makePaths(root);
    await writeIdentity(paths, { "existing@example.com": "alice" });
    const out = await learnIdentities(paths, ["existing@example.com", "newdev@example.com"]);
    expect(out["existing@example.com"]).toBe("alice");
    expect(out["newdev@example.com"]).toBe("newdev@example.com");
    const persisted = await readIdentity(paths);
    expect(persisted["newdev@example.com"]).toBe("newdev@example.com");
  });
});

describe("payload conversion for Module A emit-atom", () => {
  it("flattens the atom into the JSON shape daemon_cli expects", () => {
    const p = _atomToPayloadForTesting(fakeAtom());
    expect(p.id).toBe("evt-2026-04-26-aaaaaaaaaa");
    expect(p.source).toBe("linear");
    expect(p.kind).toBe("ticket_event");
    expect(p.source_id).toBe("linear:ENG:ticket_event:ENG-123:issue_created");
    const refs = p.refs as Record<string, unknown>;
    expect(refs.threads).toEqual(["linear-eng-123"]);
    expect((refs.linear as Record<string, unknown>).action).toBe("issue_created");
  });
  it("populates all 8 Stage 2 AGI defaults", () => {
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
    expect(r.wroteThreadFiles).toBe(1);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].root).toBe(root);
    expect(stub.calls[0].atom.id).toBe(atom.id);
  });

  it("router-side dedup surfaces as wroteTimeline=false on second call", async () => {
    const paths = makePaths(root);
    await writeAtom(paths, fakeAtom());
    const r = await writeAtom(paths, fakeAtom());
    expect(r.wroteTimeline).toBe(false);
    expect(stub.calls).toHaveLength(2);
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

  it("sorts chronologically before handing to Module A", async () => {
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
