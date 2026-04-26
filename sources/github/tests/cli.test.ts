// CLI smoke tests. We invoke `main()` directly with a custom memory root and
// inject a fake keytar so no real keychain mutation occurs.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  return mkdtempSync(join(tmpdir(), "tg-cli-"));
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
    expect(writes.join("")).toContain("Tangerine — GitHub source connector");
    expect(writes.join("")).toContain("auth set");
    expect(writes.join("")).toContain("repos add");
    expect(writes.join("")).toContain("poll");
    expect(writes.join("")).toContain("watch");
  });

  it("auth status reports no token when empty", async () => {
    const code = await main(["auth", "status"]);
    expect(code).toBe(1);
    expect(writes.join("")).toContain("no token configured");
  });

  it("repos add + list + remove flow", async () => {
    const root = tmpRoot();
    let code = await main(["repos", "add", "myorg/api", `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("added myorg/api");

    writes.length = 0;
    code = await main(["repos", "add", "myorg/api", `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("already configured");

    writes.length = 0;
    code = await main(["repos", "add", "myorg/web", "--projects=v1,frontend", `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("(projects: v1, frontend)");

    writes.length = 0;
    code = await main(["repos", "list", `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("myorg/api");
    expect(writes.join("")).toContain("myorg/web");

    writes.length = 0;
    code = await main(["repos", "remove", "myorg/api", `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("removed myorg/api");

    writes.length = 0;
    code = await main(["repos", "remove", "myorg/api", `--memory-root=${root}`]);
    expect(code).toBe(1);
    expect(writes.join("")).toContain("not configured");
  });

  it("repos add rejects bad name", async () => {
    const root = tmpRoot();
    const code = await main(["repos", "add", "bogus", `--memory-root=${root}`]);
    expect(code).toBe(1);
    expect(writes.join("")).toContain("invalid repo name");
  });

  it("unknown command exits non-zero with help", async () => {
    const code = await main(["banana"]);
    expect(code).toBe(1);
    expect(writes.join("")).toContain("unknown command");
  });
});
