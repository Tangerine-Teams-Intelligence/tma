/**
 * server.test.ts — integration test that spawns the built MCP server as a
 * subprocess and exercises the JSONRPC protocol over stdio.
 *
 * Verifies:
 *   - tools/list returns query_team_memory with the expected input schema
 *   - tools/call query_team_memory returns matching hits as JSON text
 *   - resources/list returns the synthetic root + per-file entries
 *   - resources/read serves a specific file
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const CLI_PATH = path.join(PKG_ROOT, "dist", "cli.js");

let tmpRoot: string;
let child: ChildProcessWithoutNullStreams;
let buffer = "";
const pending = new Map<number, (msg: unknown) => void>();

const FIXTURE_FILE = `---
title: Pricing $20/seat 3 seat min
date: 2026-04-25
source: meeting
---

We need to lock pricing before HN launch. I'm thinking $20/seat with 3 seat
minimum. David agrees. Let's commit and stop iterating.
`;

beforeAll(async () => {
  // Build sanity: dist/cli.js must exist (CI pipeline runs npm run build first).
  try {
    await fs.access(CLI_PATH);
  } catch {
    throw new Error(
      `Expected built CLI at ${CLI_PATH}. Run \`npm run build\` first.`,
    );
  }

  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tangerine-mcp-int-"));
  await fs.mkdir(path.join(tmpRoot, "decisions"), { recursive: true });
  await fs.writeFile(
    path.join(tmpRoot, "decisions", "pricing-20-seat.md"),
    FIXTURE_FILE,
  );

  child = spawn(process.execPath, [CLI_PATH, "--root", tmpRoot], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === "number") {
          const cb = pending.get(msg.id);
          if (cb) {
            pending.delete(msg.id);
            cb(msg);
          }
        }
      } catch {
        // ignore non-JSON lines (shouldn't happen — server logs to stderr)
      }
    }
  });

  // Capture stderr only if a test fails (vitest will print).
  child.stderr.setEncoding("utf8");
  let stderrBuf = "";
  child.stderr.on("data", (chunk: string) => {
    stderrBuf += chunk;
    if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
  });

  // Initialize handshake (MCP requires initialize before any other request).
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0.0.0" },
  });
  // initialized notification (no id, no response expected)
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }) + "\n",
  );
});

afterAll(async () => {
  if (child && !child.killed) {
    child.kill();
  }
  if (tmpRoot) {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

let nextId = 1;
function rpc(method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    child.stdin.write(frame);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }
    }, 5000);
  });
}

describe("MCP stdio server (integration)", () => {
  it("tools/list returns query_team_memory", async () => {
    const res = await rpc("tools/list", {});
    expect(res.result).toBeDefined();
    expect(Array.isArray(res.result.tools)).toBe(true);
    const tool = res.result.tools.find(
      (t: any) => t.name === "query_team_memory",
    );
    expect(tool).toBeDefined();
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.properties.query.type).toBe("string");
    expect(tool.inputSchema.required).toContain("query");
  });

  it("tools/call query_team_memory returns matching hits", async () => {
    const res = await rpc("tools/call", {
      name: "query_team_memory",
      arguments: { query: "pricing", limit: 5 },
    });
    expect(res.result).toBeDefined();
    expect(res.result.isError).toBeFalsy();
    const text = res.result.content[0].text as string;
    const payload = JSON.parse(text);
    expect(payload.query).toBe("pricing");
    expect(payload.searched).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(payload.hits)).toBe(true);
    expect(payload.hits.length).toBeGreaterThan(0);
    expect(payload.hits[0].file).toBe("decisions/pricing-20-seat.md");
    expect(payload.hits[0].title).toBe("Pricing $20/seat 3 seat min");
    expect(payload.hits[0].snippet).toContain("$20/seat");
  });

  it("tools/call rejects empty query", async () => {
    const res = await rpc("tools/call", {
      name: "query_team_memory",
      arguments: { query: "" },
    });
    expect(res.result.isError).toBe(true);
  });

  it("resources/list returns root index plus per-file entries", async () => {
    const res = await rpc("resources/list", {});
    expect(res.result).toBeDefined();
    const uris = (res.result.resources as Array<{ uri: string }>).map(
      (r) => r.uri,
    );
    expect(uris).toContain("team-memory://");
    expect(uris).toContain("team-memory://decisions/pricing-20-seat.md");
  });

  it("resources/read serves a specific file", async () => {
    const res = await rpc("resources/read", {
      uri: "team-memory://decisions/pricing-20-seat.md",
    });
    expect(res.result).toBeDefined();
    const c = res.result.contents[0];
    expect(c.mimeType).toBe("text/markdown");
    expect(c.text).toContain("HN launch");
    expect(c.text).toContain("title: Pricing $20/seat 3 seat min");
  });

  it("resources/read on root returns JSON index", async () => {
    const res = await rpc("resources/read", { uri: "team-memory://" });
    expect(res.result.contents[0].mimeType).toBe("application/json");
    const payload = JSON.parse(res.result.contents[0].text);
    expect(payload.count).toBeGreaterThanOrEqual(1);
    expect(payload.files[0].file).toBe("decisions/pricing-20-seat.md");
  });
});
