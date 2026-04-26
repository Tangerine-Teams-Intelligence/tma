/**
 * memory.test.ts — unit tests for the memory layer:
 *   - root resolution priority (--root > env > home default)
 *   - missing root returns [] (no crash)
 *   - frontmatter parsed via gray-matter
 *   - search is case-insensitive substring, ranked by match count
 *   - readMemoryFile rejects path-traversal attempts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  resolveMemoryRoot,
  walkMemoryRoot,
  searchMemory,
  readMemoryFile,
  MAX_FILES,
} from "../src/memory.js";

let tmpRoot: string;

const FILE_A = `---
title: Pricing $20/seat 3 seat min
date: 2026-04-25
source: meeting
---

We need to lock pricing before HN launch. I'm thinking $20/seat with 3 seat
minimum. David agrees. Let's commit and stop iterating.
`;

const FILE_B = `---
title: Whisper hosting decision
date: 2026-04-24
source: decision
---

Switched from OpenAI Whisper API to bundled local faster-whisper. Pricing
implications minor. Whisper runs locally now.
`;

const FILE_C = `# Plain markdown, no frontmatter

This file is about cabbages and onions, nothing else.
`;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tangerine-mem-test-"));
  await fs.mkdir(path.join(tmpRoot, "decisions"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, "meetings"), { recursive: true });
  await fs.writeFile(
    path.join(tmpRoot, "decisions", "pricing-20-seat.md"),
    FILE_A,
  );
  await fs.writeFile(
    path.join(tmpRoot, "decisions", "whisper-hosting.md"),
    FILE_B,
  );
  await fs.writeFile(path.join(tmpRoot, "meetings", "veggies.md"), FILE_C);
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.TANGERINE_MEMORY_ROOT;
});

describe("resolveMemoryRoot", () => {
  it("prefers --root flag over env and default", () => {
    process.env.TANGERINE_MEMORY_ROOT = "/from/env";
    const r = resolveMemoryRoot("/from/flag");
    expect(r).toBe(path.resolve("/from/flag"));
  });

  it("falls back to TANGERINE_MEMORY_ROOT env", () => {
    process.env.TANGERINE_MEMORY_ROOT = path.join(tmpRoot);
    const r = resolveMemoryRoot();
    expect(r).toBe(path.resolve(tmpRoot));
  });

  it("defaults to ~/.tangerine-memory when nothing set", () => {
    const r = resolveMemoryRoot();
    expect(r).toBe(path.join(os.homedir(), ".tangerine-memory"));
  });

  it("treats empty/whitespace --root as unset", () => {
    process.env.TANGERINE_MEMORY_ROOT = path.join(tmpRoot);
    const r = resolveMemoryRoot("   ");
    expect(r).toBe(path.resolve(tmpRoot));
  });
});

describe("walkMemoryRoot", () => {
  it("returns empty array for missing root (no crash)", async () => {
    const files = await walkMemoryRoot(
      path.join(tmpRoot, "definitely-not-here-12345"),
    );
    expect(files).toEqual([]);
  });

  it("walks all .md files and parses frontmatter", async () => {
    const files = await walkMemoryRoot(tmpRoot);
    expect(files).toHaveLength(3);
    const byRel = Object.fromEntries(files.map((f) => [f.relPath, f]));
    expect(byRel["decisions/pricing-20-seat.md"]).toBeDefined();
    expect(byRel["decisions/pricing-20-seat.md"].frontmatter.title).toBe(
      "Pricing $20/seat 3 seat min",
    );
    expect(byRel["decisions/pricing-20-seat.md"].title).toBe(
      "Pricing $20/seat 3 seat min",
    );
    // body should not include the frontmatter --- block
    expect(byRel["decisions/pricing-20-seat.md"].body).not.toContain("source: meeting");
    expect(byRel["meetings/veggies.md"].frontmatter).toEqual({});
    expect(byRel["meetings/veggies.md"].title).toBe("veggies");
  });

  it("uses forward-slash relative paths even on Windows", async () => {
    const files = await walkMemoryRoot(tmpRoot);
    for (const f of files) {
      expect(f.relPath).not.toContain("\\");
    }
  });

  it("respects MAX_FILES cap (sanity, not exhaustive)", () => {
    expect(MAX_FILES).toBeGreaterThanOrEqual(1000);
  });

  it("skips dotfiles and node_modules", async () => {
    const dotDir = path.join(tmpRoot, ".hidden");
    await fs.mkdir(dotDir, { recursive: true });
    await fs.writeFile(path.join(dotDir, "secret.md"), "should not be walked");
    const nm = path.join(tmpRoot, "node_modules");
    await fs.mkdir(nm, { recursive: true });
    await fs.writeFile(path.join(nm, "junk.md"), "should not be walked");
    try {
      const files = await walkMemoryRoot(tmpRoot);
      const paths = files.map((f) => f.relPath);
      expect(paths.some((p) => p.includes(".hidden"))).toBe(false);
      expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    } finally {
      await fs.rm(dotDir, { recursive: true, force: true });
      await fs.rm(nm, { recursive: true, force: true });
    }
  });
});

describe("searchMemory", () => {
  it("returns matches case-insensitively", async () => {
    const files = await walkMemoryRoot(tmpRoot);
    const hits = searchMemory(files, "pricing", 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const titles = hits.map((h) => h.title);
    expect(titles).toContain("Pricing $20/seat 3 seat min");
    // first hit should be the file with more matches
    expect(hits[0].matches).toBeGreaterThanOrEqual(hits[hits.length - 1].matches);
  });

  it("ranks by descending match count", async () => {
    const files = await walkMemoryRoot(tmpRoot);
    const hits = searchMemory(files, "whisper", 5);
    // file B has multiple "Whisper" mentions
    expect(hits[0].file).toBe("decisions/whisper-hosting.md");
    expect(hits[0].matches).toBeGreaterThan(1);
  });

  it("returns [] for empty query", async () => {
    const files = await walkMemoryRoot(tmpRoot);
    expect(searchMemory(files, "", 5)).toEqual([]);
    expect(searchMemory(files, "   ", 5)).toEqual([]);
  });

  it("respects limit (capped at 20)", async () => {
    const files = await walkMemoryRoot(tmpRoot);
    const hits = searchMemory(files, "the", 1);
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it("returns snippet around match with ellipsis", async () => {
    const files = await walkMemoryRoot(tmpRoot);
    const hits = searchMemory(files, "$20/seat", 5);
    expect(hits[0].snippet).toContain("$20/seat");
  });

  it("includes content_preview capped at 4000 chars", async () => {
    const files = await walkMemoryRoot(tmpRoot);
    const hits = searchMemory(files, "pricing", 5);
    expect(hits[0].content_preview.length).toBeLessThanOrEqual(4000);
  });

  it("performance: 100 files of ~5KB each in under 100ms", async () => {
    const perfRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "tangerine-mem-perf-"),
    );
    try {
      const body = "lorem ipsum dolor sit amet ".repeat(180); // ~5KB
      const dir = path.join(perfRoot, "bulk");
      await fs.mkdir(dir, { recursive: true });
      for (let i = 0; i < 100; i++) {
        await fs.writeFile(
          path.join(dir, `file-${i}.md`),
          `---\ntitle: file ${i}\n---\n${body}\n${
            i % 7 === 0 ? "haystack-needle here\n" : ""
          }`,
        );
      }
      const files = await walkMemoryRoot(perfRoot);
      expect(files).toHaveLength(100);
      const t0 = performance.now();
      const hits = searchMemory(files, "haystack-needle", 10);
      const elapsed = performance.now() - t0;
      expect(hits.length).toBeGreaterThan(0);
      // Spec target: < 100ms. Allow 250ms slack for shared CI hardware.
      expect(elapsed).toBeLessThan(250);
    } finally {
      await fs.rm(perfRoot, { recursive: true, force: true });
    }
  });
});

describe("readMemoryFile", () => {
  it("reads a file and parses frontmatter", async () => {
    const f = await readMemoryFile(tmpRoot, "decisions/pricing-20-seat.md");
    expect(f).not.toBeNull();
    expect(f!.frontmatter.title).toBe("Pricing $20/seat 3 seat min");
    expect(f!.body).toContain("HN launch");
  });

  it("returns null for missing file", async () => {
    const f = await readMemoryFile(tmpRoot, "decisions/nope.md");
    expect(f).toBeNull();
  });

  it("rejects path-traversal attempts", async () => {
    const f = await readMemoryFile(tmpRoot, "../../etc/passwd");
    expect(f).toBeNull();
  });

  it("strips leading slashes from relative path", async () => {
    const f = await readMemoryFile(tmpRoot, "/decisions/pricing-20-seat.md");
    expect(f).not.toBeNull();
  });
});
