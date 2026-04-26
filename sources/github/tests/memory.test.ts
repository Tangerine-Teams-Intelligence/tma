// Memory writer: timeline + thread file emission, dedup, identity learning.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
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
  atomToMarkdown,
  utcDate,
} from "../src/memory.js";
import { defaultConfig, type Atom } from "../src/types.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tg-mem-"));
}

function fakeAtom(overrides: Partial<Atom> = {}): Atom {
  return {
    id: "evt-gh-myorg-api-pr-47-opened",
    ts: "2026-04-26T09:00:00.000Z",
    source: "github",
    actor: "eric",
    actors: ["eric", "daizhe"],
    kind: "pr_opened",
    refs: {
      github: { repo: "myorg/api", pr: 47, url: "https://github.com/myorg/api/pull/47" },
      meeting: null,
      decisions: [],
      people: ["eric", "daizhe"],
      projects: ["v1-launch"],
      threads: ["pr-myorg-api-47"],
    },
    status: "active",
    sample: false,
    body: "**eric** opened PR #47 (eric/pg-migration → main): _postgres-migration_",
    ...overrides,
  };
}

describe("atomToMarkdown", () => {
  it("renders required frontmatter keys", () => {
    const md = atomToMarkdown(fakeAtom());
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("id: evt-gh-myorg-api-pr-47-opened");
    expect(md).toContain("source: github");
    expect(md).toContain("kind: pr_opened");
    expect(md).toContain("actor: eric");
    expect(md).toContain("actors: [eric, daizhe]");
    expect(md).toContain("threads: [pr-myorg-api-47]");
    expect(md).toContain("projects: [v1-launch]");
    expect(md).toContain("status: active");
    expect(md).toContain("sample: false");
    expect(md).toContain("**eric** opened PR #47");
  });
  it("emits null literal for meeting when unset", () => {
    const md = atomToMarkdown(fakeAtom());
    expect(md).toContain("meeting: null");
  });
});

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

describe("writeAtom — timeline + thread", () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  it("writes to both timeline and thread files", async () => {
    const paths = makePaths(root);
    const r = await writeAtom(paths, fakeAtom());
    expect(r.wroteTimeline).toBe(true);
    expect(r.wroteThreadFiles).toBe(1);
    const t = readFileSync(paths.timeline("2026-04-26"), "utf8");
    const th = readFileSync(paths.thread("pr-myorg-api-47"), "utf8");
    expect(t).toContain("evt-gh-myorg-api-pr-47-opened");
    expect(th).toContain("evt-gh-myorg-api-pr-47-opened");
  });

  it("is idempotent — second write is a no-op", async () => {
    const paths = makePaths(root);
    await writeAtom(paths, fakeAtom());
    const r2 = await writeAtom(paths, fakeAtom());
    expect(r2.wroteTimeline).toBe(false);
    expect(r2.wroteThreadFiles).toBe(0);
    const t = readFileSync(paths.timeline("2026-04-26"), "utf8");
    // The id should appear exactly once.
    const occurrences = (t.match(/evt-gh-myorg-api-pr-47-opened/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("writes a fresh atom into existing file with separator", async () => {
    const paths = makePaths(root);
    await writeAtom(paths, fakeAtom());
    await writeAtom(paths, fakeAtom({ id: "evt-gh-myorg-api-pr-47-comment-12345", kind: "pr_comment" }));
    const t = readFileSync(paths.timeline("2026-04-26"), "utf8");
    expect(t).toContain("evt-gh-myorg-api-pr-47-opened");
    expect(t).toContain("evt-gh-myorg-api-pr-47-comment-12345");
    // Two `---` opens.
    const opens = (t.match(/^---$/gm) ?? []).length;
    expect(opens).toBeGreaterThanOrEqual(4); // 2 atoms × open + close
  });

  it("groups by ts UTC date", async () => {
    const paths = makePaths(root);
    await writeAtom(paths, fakeAtom());
    await writeAtom(paths, fakeAtom({ id: "evt-x", ts: "2026-04-27T01:00:00.000Z", refs: { ...fakeAtom().refs, threads: ["pr-myorg-api-99"] } }));
    expect(existsSync(paths.timeline("2026-04-26"))).toBe(true);
    expect(existsSync(paths.timeline("2026-04-27"))).toBe(true);
  });
});

describe("writeAtoms batch", () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  it("counts written vs skipped (dedup)", async () => {
    const paths = makePaths(root);
    const a1 = fakeAtom();
    const a2 = fakeAtom({ id: "evt-2", ts: "2026-04-26T09:30:00.000Z" });
    const first = await writeAtoms(paths, [a1, a2]);
    expect(first.written).toBe(2);
    expect(first.skipped).toBe(0);
    const second = await writeAtoms(paths, [a1, a2]);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(2);
  });
});
