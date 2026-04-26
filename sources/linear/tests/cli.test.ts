// CLI smoke tests. We invoke main() directly with an injected stub Linear
// client + fake keytar so no real Linear calls happen and no real keychain
// mutation occurs.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeytarForTesting } from "../src/auth.js";
import { main } from "../src/cli.js";
import { setRouterForTesting } from "../src/memory.js";
import type { LinearLike, LinearTeam } from "../src/client.js";

class FakeKeytar {
  store = new Map<string, string>();
  k(s: string, a: string): string { return `${s}:${a}`; }
  async setPassword(s: string, a: string, p: string): Promise<void> { this.store.set(this.k(s, a), p); }
  async getPassword(s: string, a: string): Promise<string | null> { return this.store.get(this.k(s, a)) ?? null; }
  async deletePassword(s: string, a: string): Promise<boolean> { return this.store.delete(this.k(s, a)); }
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tg-lin-cli-"));
}

function stubLinear(teams: LinearTeam[]): LinearLike {
  return {
    async viewer() { return { id: "u-test", email: "test@example.com" }; },
    async listTeams() { return teams; },
    async listIssuesForTeam() { return []; },
    async listCommentsForTeam() { return []; },
  };
}

describe("cli (in-process)", () => {
  let writes: string[] = [];
  let origWrite: any;
  let fake: FakeKeytar;

  beforeEach(() => {
    writes = [];
    origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: any) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as any;
    fake = new FakeKeytar();
    setKeytarForTesting(fake);
    // Stub the router so even if poll runs accidentally it doesn't shell out.
    setRouterForTesting(async () => ({ events: 1, skipped: 0 }));
  });

  afterEach(() => {
    process.stdout.write = origWrite;
    setKeytarForTesting(null);
    setRouterForTesting(null);
  });

  it("prints help with no args", async () => {
    const code = await main([]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("Tangerine — Linear source connector");
    expect(writes.join("")).toContain("auth set");
    expect(writes.join("")).toContain("teams add");
    expect(writes.join("")).toContain("poll");
    expect(writes.join("")).toContain("watch");
  });

  it("auth status reports no token when empty", async () => {
    const code = await main(["auth", "status"]);
    expect(code).toBe(1);
    expect(writes.join("")).toContain("no token configured");
  });

  it("teams list errors clearly when no PAT configured", async () => {
    const code = await main(["teams", "list"], { client: undefined });
    expect(code).toBe(1);
    expect(writes.join("")).toContain("No Linear PAT configured");
  });

  it("teams list shows teams from stub client", async () => {
    const root = tmpRoot();
    await fake.setPassword("tangerine-linear", "default", "lin_test");
    const teams: LinearTeam[] = [
      { id: "uuid-eng", key: "ENG", name: "Engineering" },
      { id: "uuid-dsgn", key: "DSGN", name: "Design" },
    ];
    const code = await main(
      ["teams", "list", `--memory-root=${root}`],
      { client: stubLinear(teams) },
    );
    expect(code).toBe(0);
    expect(writes.join("")).toContain("ENG");
    expect(writes.join("")).toContain("Engineering");
    expect(writes.join("")).toContain("DSGN");
  });

  it("teams add resolves a key into the UUID and persists", async () => {
    const root = tmpRoot();
    await fake.setPassword("tangerine-linear", "default", "lin_test");
    const teams: LinearTeam[] = [
      { id: "uuid-eng", key: "ENG", name: "Engineering" },
    ];

    let code = await main(
      ["teams", "add", "ENG", `--memory-root=${root}`],
      { client: stubLinear(teams) },
    );
    expect(code).toBe(0);
    expect(writes.join("")).toContain("added ENG (Engineering)");

    writes.length = 0;
    code = await main(
      ["teams", "add", "ENG", `--memory-root=${root}`],
      { client: stubLinear(teams) },
    );
    expect(code).toBe(0);
    expect(writes.join("")).toContain("already configured");
  });

  it("teams add accepts UUID as well as key", async () => {
    const root = tmpRoot();
    await fake.setPassword("tangerine-linear", "default", "lin_test");
    const teams: LinearTeam[] = [
      { id: "uuid-eng", key: "ENG", name: "Engineering" },
    ];
    const code = await main(
      ["teams", "add", "uuid-eng", `--memory-root=${root}`],
      { client: stubLinear(teams) },
    );
    expect(code).toBe(0);
    expect(writes.join("")).toContain("added ENG");
  });

  it("teams add with --projects records the tag list", async () => {
    const root = tmpRoot();
    await fake.setPassword("tangerine-linear", "default", "lin_test");
    const teams: LinearTeam[] = [
      { id: "uuid-eng", key: "ENG", name: "Engineering" },
    ];
    const code = await main(
      ["teams", "add", "ENG", "--projects=v1,backend", `--memory-root=${root}`],
      { client: stubLinear(teams) },
    );
    expect(code).toBe(0);
    expect(writes.join("")).toContain("projects=[v1,backend]");
  });

  it("teams add rejects unknown team name", async () => {
    const root = tmpRoot();
    await fake.setPassword("tangerine-linear", "default", "lin_test");
    const teams: LinearTeam[] = [
      { id: "uuid-eng", key: "ENG", name: "Engineering" },
    ];
    const code = await main(
      ["teams", "add", "GHOST", `--memory-root=${root}`],
      { client: stubLinear(teams) },
    );
    expect(code).toBe(1);
    expect(writes.join("")).toContain("team not found");
  });

  it("teams remove unsubscribes a configured team", async () => {
    const root = tmpRoot();
    await fake.setPassword("tangerine-linear", "default", "lin_test");
    const teams: LinearTeam[] = [
      { id: "uuid-eng", key: "ENG", name: "Engineering" },
    ];
    await main(
      ["teams", "add", "ENG", `--memory-root=${root}`],
      { client: stubLinear(teams) },
    );

    writes.length = 0;
    let code = await main(["teams", "remove", "ENG", `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("removed ENG");

    writes.length = 0;
    code = await main(["teams", "remove", "ENG", `--memory-root=${root}`]);
    expect(code).toBe(1);
    expect(writes.join("")).toContain("not configured");
  });

  it("unknown command exits non-zero with help", async () => {
    const code = await main(["banana"]);
    expect(code).toBe(1);
    expect(writes.join("")).toContain("unknown command");
  });
});
