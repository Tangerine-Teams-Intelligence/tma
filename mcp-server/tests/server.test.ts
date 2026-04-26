/**
 * server.test.ts — integration test that spawns the built MCP server as a
 * subprocess and exercises the JSONRPC protocol over stdio.
 *
 * Verifies (Stage 1, Hook 4):
 *   - tools/list returns all 7 tools
 *   - every tools/call response is wrapped in the AGI envelope
 *   - resources/list / resources/read still work
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

let tmpRepo: string;
let tmpRoot: string;
let child: ChildProcessWithoutNullStreams;
let buffer = "";
const pending = new Map<number, (msg: unknown) => void>();

const today = (() => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
})();

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

  // Mirror the team-repo layout: <repo>/memory + <repo>/.tangerine.
  tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), "tangerine-mcp-int-"));
  tmpRoot = path.join(tmpRepo, "memory");
  const sidecar = path.join(tmpRepo, ".tangerine");
  const briefs = path.join(sidecar, "briefs");
  await fs.mkdir(path.join(tmpRoot, "decisions"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, "threads"), { recursive: true });
  await fs.mkdir(briefs, { recursive: true });
  await fs.writeFile(
    path.join(tmpRoot, "decisions", "pricing-20-seat.md"),
    FIXTURE_FILE,
  );
  // Seed a synthetic timeline.json so the proactive tools have data.
  const index = {
    version: 1,
    rebuilt_at: new Date().toISOString(),
    events: [
      {
        id: "evt-2026-04-25-int1234567",
        ts: `${today}T09:00:00+08:00`,
        source: "meeting",
        actor: "daizhe",
        actors: ["daizhe", "david"],
        kind: "decision",
        refs: {
          decisions: ["pricing-20-seat"],
          people: ["daizhe", "david"],
          projects: ["v1-launch"],
          threads: ["pricing-debate"],
        },
        status: "active",
        lifecycle: { decided: today, owner: "daizhe", due: today },
        body: "Pricing locked at $20/seat",
        file: `memory/timeline/${today}.md`,
        line: 5,
      },
    ],
  };
  await fs.writeFile(
    path.join(sidecar, "timeline.json"),
    JSON.stringify(index, null, 2),
  );
  await fs.writeFile(
    path.join(briefs, `${today}.md`),
    `# Daily Brief — ${today}\n\nLocked pricing.\n`,
  );
  await fs.writeFile(
    path.join(tmpRoot, "threads", "pricing-debate.md"),
    `---\ntopic: pricing-debate\n---\n\nThread narrative.\n`,
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
  if (tmpRepo) {
    await fs.rm(tmpRepo, { recursive: true, force: true });
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

function payloadOf(res: any): any {
  return JSON.parse(res.result.content[0].text);
}

function assertEnvelope(payload: any) {
  expect(payload).toHaveProperty("data");
  expect(payload).toHaveProperty("confidence", 1.0);
  expect(payload).toHaveProperty("freshness_seconds");
  expect(payload).toHaveProperty("source_atoms");
  expect(payload).toHaveProperty("alternatives");
  expect(payload).toHaveProperty("reasoning_notes", null);
  expect(Array.isArray(payload.source_atoms)).toBe(true);
  expect(Array.isArray(payload.alternatives)).toBe(true);
  expect(typeof payload.freshness_seconds).toBe("number");
}

describe("MCP stdio server (integration)", () => {
  it("tools/list returns 7 tools", async () => {
    const res = await rpc("tools/list", {});
    expect(res.result).toBeDefined();
    expect(Array.isArray(res.result.tools)).toBe(true);
    expect(res.result.tools).toHaveLength(7);
    const names = res.result.tools.map((t: any) => t.name);
    for (const expected of [
      "query_team_memory",
      "get_today_brief",
      "get_my_pending",
      "get_for_person",
      "get_for_project",
      "get_thread_state",
      "get_recent_decisions",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("query_team_memory returns envelope-wrapped hits", async () => {
    const res = await rpc("tools/call", {
      name: "query_team_memory",
      arguments: { query: "pricing", limit: 5 },
    });
    expect(res.result.isError).toBeFalsy();
    const payload = payloadOf(res);
    assertEnvelope(payload);
    expect(payload.data.query).toBe("pricing");
    expect(payload.data.hits.length).toBeGreaterThan(0);
  });

  it("query_team_memory rejects empty query", async () => {
    const res = await rpc("tools/call", {
      name: "query_team_memory",
      arguments: { query: "" },
    });
    expect(res.result.isError).toBe(true);
  });

  it("get_today_brief returns envelope-wrapped brief", async () => {
    const res = await rpc("tools/call", {
      name: "get_today_brief",
      arguments: {},
    });
    expect(res.result.isError).toBeFalsy();
    const payload = payloadOf(res);
    assertEnvelope(payload);
    expect(payload.data.date).toBe(today);
    expect(payload.data.markdown).toContain(today);
  });

  it("get_my_pending returns envelope + items list", async () => {
    const res = await rpc("tools/call", {
      name: "get_my_pending",
      arguments: { user: "daizhe" },
    });
    expect(res.result.isError).toBeFalsy();
    const payload = payloadOf(res);
    assertEnvelope(payload);
    expect(payload.data.user).toBe("daizhe");
    expect(payload.data.items.length).toBeGreaterThan(0);
    expect(payload.source_atoms.length).toBeGreaterThan(0);
  });

  it("get_my_pending rejects empty user", async () => {
    const res = await rpc("tools/call", {
      name: "get_my_pending",
      arguments: { user: "" },
    });
    expect(res.result.isError).toBe(true);
  });

  it("get_for_person returns envelope + atoms list", async () => {
    const res = await rpc("tools/call", {
      name: "get_for_person",
      arguments: { name: "daizhe" },
    });
    expect(res.result.isError).toBeFalsy();
    const payload = payloadOf(res);
    assertEnvelope(payload);
    expect(payload.data.name).toBe("daizhe");
    expect(payload.data.window_days).toBe(30);
  });

  it("get_for_project returns envelope", async () => {
    const res = await rpc("tools/call", {
      name: "get_for_project",
      arguments: { slug: "v1-launch" },
    });
    expect(res.result.isError).toBeFalsy();
    const payload = payloadOf(res);
    assertEnvelope(payload);
    expect(payload.data.slug).toBe("v1-launch");
  });

  it("get_thread_state returns envelope + decisions_resolved", async () => {
    const res = await rpc("tools/call", {
      name: "get_thread_state",
      arguments: { topic: "pricing-debate" },
    });
    expect(res.result.isError).toBeFalsy();
    const payload = payloadOf(res);
    assertEnvelope(payload);
    expect(payload.data.topic).toBe("pricing-debate");
    expect(payload.data.status).toBe("active");
    expect(payload.data.decisions_resolved).toContain("pricing-20-seat");
    expect(payload.data.narrative).toContain("Thread narrative");
  });

  it("get_recent_decisions returns envelope + clamps days", async () => {
    const res = await rpc("tools/call", {
      name: "get_recent_decisions",
      arguments: { days: 7 },
    });
    expect(res.result.isError).toBeFalsy();
    const payload = payloadOf(res);
    assertEnvelope(payload);
    expect(payload.data.window_days).toBe(7);
  });

  it("unknown tool returns isError", async () => {
    const res = await rpc("tools/call", {
      name: "definitely_not_a_tool",
      arguments: {},
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
