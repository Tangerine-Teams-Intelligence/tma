// CLI smoke tests. We invoke `main()` directly with a custom memory root and
// inject a fake keytar so no real keychain mutation occurs.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeytarForTesting } from "../src/auth.js";
import { main } from "../src/cli.js";

class FakeKeytar {
  store = new Map<string, string>();
  k(s: string, a: string) { return `${s}:${a}`; }
  async setPassword(s: string, a: string, p: string) { this.store.set(this.k(s, a), p); }
  async getPassword(s: string, a: string) { return this.store.get(this.k(s, a)) ?? null; }
  async deletePassword(s: string, a: string) { return this.store.delete(this.k(s, a)); }
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tg-slack-cli-"));
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
  });

  afterEach(() => {
    process.stdout.write = origWrite;
    setKeytarForTesting(null);
  });

  it("prints help with no args", async () => {
    const code = await main([]);
    expect(code).toBe(0);
    const out = writes.join("");
    expect(out).toContain("Tangerine — Slack source connector");
    expect(out).toContain("auth set");
    expect(out).toContain("channels add");
    expect(out).toContain("poll");
    expect(out).toContain("watch");
  });

  it("auth status reports no token when empty", async () => {
    const code = await main(["auth", "status"]);
    expect(code).toBe(1);
    expect(writes.join("")).toContain("no token configured");
  });

  it("channels add + list + remove flow (by id)", async () => {
    const root = tmpRoot();
    let code = await main(["channels", "add", "C01ENG", `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("added C01ENG");

    writes.length = 0;
    code = await main(["channels", "add", "C01ENG", `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("already configured");

    writes.length = 0;
    code = await main(["channels", "add", "C02WEB", "--projects=v1,frontend", `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("(projects: v1, frontend)");

    writes.length = 0;
    code = await main(["channels", "list", `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("C01ENG");
    expect(writes.join("")).toContain("C02WEB");

    writes.length = 0;
    code = await main(["channels", "remove", "C01ENG", `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("removed C01ENG");

    writes.length = 0;
    code = await main(["channels", "remove", "C01ENG", `--memory-root=${root}`]);
    expect(code).toBe(1);
    expect(writes.join("")).toContain("not configured");
  });

  it("channels add accepts #name shorthand", async () => {
    const root = tmpRoot();
    const code = await main(["channels", "add", "#eng-v1-launch", `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("added eng-v1-launch");
  });

  it("channels list --remote refuses without token", async () => {
    const code = await main(["channels", "list", "--remote"]);
    expect(code).toBe(1);
    expect(writes.join("")).toContain("no token configured");
  });

  it("unknown command exits non-zero with help", async () => {
    const code = await main(["banana"]);
    expect(code).toBe(1);
    expect(writes.join("")).toContain("unknown command");
  });
});
