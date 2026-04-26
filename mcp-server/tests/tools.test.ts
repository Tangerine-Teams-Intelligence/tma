/**
 * tools.test.ts — unit tests for the 6 new proactive tools + envelope-wrapped
 * query_team_memory.
 *
 * Builds a synthetic memory root + sidecar (.tangerine/timeline.json,
 * briefs/<today>.md, threads/<topic>.md) so we exercise the same code paths
 * that hit live data, but in a hermetic temp dir.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  runQueryTeamMemory,
  runGetTodayBrief,
  runGetMyPending,
  runGetForPerson,
  runGetForProject,
  runGetThreadState,
  runGetRecentDecisions,
  ALL_TOOL_DEFINITIONS,
  TOOL_NAMES,
} from "../src/tools.js";

let tmpRoot: string;
let sidecarPath: string;
let briefsPath: string;
let threadsPath: string;

const today = (() => {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
})();

const yesterday = (() => {
  const d = new Date(Date.now() - 86_400_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
})();

beforeAll(async () => {
  // Layout mirrors the team-repo: <tmpdir>/repo/{memory, .tangerine}/
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "tangerine-mcp-tools-"));
  tmpRoot = path.join(repo, "memory");
  sidecarPath = path.join(repo, ".tangerine");
  briefsPath = path.join(sidecarPath, "briefs");
  threadsPath = path.join(tmpRoot, "threads");
  await fs.mkdir(tmpRoot, { recursive: true });
  await fs.mkdir(sidecarPath, { recursive: true });
  await fs.mkdir(briefsPath, { recursive: true });
  await fs.mkdir(threadsPath, { recursive: true });
  await fs.mkdir(path.join(tmpRoot, "decisions"), { recursive: true });

  // Seed a memory file so query_team_memory has something to find.
  await fs.writeFile(
    path.join(tmpRoot, "decisions", "pricing-20-seat.md"),
    `---\ntitle: Pricing $20/seat\n---\n\nWe locked $20/seat with 3 seat min.\n`,
  );

  // Seed timeline.json with hand-built atoms exercising every tool.
  const index = {
    version: 1,
    rebuilt_at: new Date().toISOString(),
    events: [
      // 1. Today: a pricing decision owned by daizhe (open action item).
      {
        id: "evt-2026-04-25-aaaaaaaaaa",
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
        body: "Pricing locked at $20/seat with 3 seat min",
        file: `memory/timeline/${today}.md`,
        line: 5,
      },
      // 2. Today: a closed action item (should NOT show up in pending).
      {
        id: "evt-2026-04-25-bbbbbbbbbb",
        ts: `${today}T10:00:00+08:00`,
        source: "meeting",
        actor: "daizhe",
        actors: ["daizhe"],
        kind: "comment",
        refs: { people: ["daizhe"] },
        status: "active",
        lifecycle: {
          owner: "daizhe",
          due: today,
          closed: `${today}T10:30:00+08:00`,
        },
        body: "Bought the domain",
        file: `memory/timeline/${today}.md`,
        line: 12,
      },
      // 3. Yesterday: a pr_event by eric on v1-launch.
      {
        id: "evt-2026-04-24-cccccccccc",
        ts: `${yesterday}T14:30:00+08:00`,
        source: "github",
        actor: "eric",
        actors: ["eric", "daizhe"],
        kind: "pr_event",
        refs: { people: ["daizhe", "eric"], projects: ["v1-launch"] },
        status: "active",
        body: "Merged PR #47 — postgres migration",
        file: `memory/timeline/${yesterday}.md`,
        line: 5,
      },
      // 4. Yesterday: a thread comment on the same pricing-debate.
      {
        id: "evt-2026-04-24-dddddddddd",
        ts: `${yesterday}T11:00:00+08:00`,
        source: "slack",
        actor: "david",
        actors: ["david"],
        kind: "comment",
        refs: { threads: ["pricing-debate"], people: ["david"] },
        status: "active",
        body: "I think $25 is the right number actually",
        file: `memory/timeline/${yesterday}.md`,
        line: 3,
      },
      // 5. Sample atom — should be EXCLUDED from all aggregates.
      {
        id: "evt-2026-04-24-eeeeeeeeee",
        ts: `${yesterday}T08:00:00+08:00`,
        source: "system",
        actor: "system",
        actors: ["system"],
        kind: "decision",
        refs: { projects: ["v1-launch"] },
        status: "active",
        sample: true,
        body: "Sample seed — must not surface",
        file: `memory/timeline/${yesterday}.md`,
        line: 1,
      },
      // 6. Old decision (45 days back) — should be excluded from
      //    recent_decisions(7) but included for recent_decisions(60).
      {
        id: "evt-2025-old-ffffffffff",
        ts: oldIso(45),
        source: "meeting",
        actor: "daizhe",
        actors: ["daizhe"],
        kind: "decision",
        refs: { decisions: ["legacy-call"] },
        status: "active",
        body: "Long-ago decision",
        file: `memory/timeline/old.md`,
        line: 1,
      },
      // 7. Overdue action for daizhe (due 5 days ago, not closed).
      {
        id: "evt-2026-04-20-7777777777",
        ts: oldIso(5),
        source: "linear",
        actor: "daizhe",
        actors: ["daizhe"],
        kind: "ticket_event",
        refs: { people: ["daizhe"], projects: ["v1-launch"] },
        status: "active",
        lifecycle: { owner: "daizhe", due: dateDaysAgo(5) },
        body: "Implement onboarding flow",
        file: `memory/timeline/old.md`,
        line: 5,
      },
    ],
  };
  await fs.writeFile(
    path.join(sidecarPath, "timeline.json"),
    JSON.stringify(index, null, 2),
  );

  // Seed today's brief markdown.
  await fs.writeFile(
    path.join(briefsPath, `${today}.md`),
    `---\nbrief_date: ${today}\n---\n\n# Daily Brief — ${today}\n\nLocked pricing at $20/seat.\n`,
  );

  // Seed a thread narrative file.
  await fs.writeFile(
    path.join(threadsPath, "pricing-debate.md"),
    `---\ntopic: pricing-debate\ntitle: Pricing debate\n---\n\nLong-running pricing thread.\n`,
  );
});

afterAll(async () => {
  if (tmpRoot) {
    await fs.rm(path.dirname(tmpRoot), { recursive: true, force: true });
  }
});

function oldIso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

function dateDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

// ----------------------------------------------------------------------
// Registry sanity

describe("ALL_TOOL_DEFINITIONS", () => {
  it("exposes exactly 7 tools", () => {
    expect(ALL_TOOL_DEFINITIONS).toHaveLength(7);
  });

  it("every tool has a name + description + inputSchema", () => {
    for (const t of ALL_TOOL_DEFINITIONS) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("includes the 6 new tool names", () => {
    const names = ALL_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toContain(TOOL_NAMES.QUERY);
    expect(names).toContain(TOOL_NAMES.TODAY_BRIEF);
    expect(names).toContain(TOOL_NAMES.MY_PENDING);
    expect(names).toContain(TOOL_NAMES.FOR_PERSON);
    expect(names).toContain(TOOL_NAMES.FOR_PROJECT);
    expect(names).toContain(TOOL_NAMES.THREAD_STATE);
    expect(names).toContain(TOOL_NAMES.RECENT_DECISIONS);
  });
});

// ----------------------------------------------------------------------
// Envelope shape — every tool returns it

describe("AGI envelope on every tool", () => {
  it("query_team_memory wraps in envelope", async () => {
    const env = await runQueryTeamMemory(tmpRoot, { query: "pricing" });
    expect(env).toHaveProperty("data");
    expect(env).toHaveProperty("confidence", 1.0);
    expect(env).toHaveProperty("freshness_seconds");
    expect(env).toHaveProperty("source_atoms");
    expect(env).toHaveProperty("alternatives", []);
    expect(env).toHaveProperty("reasoning_notes", null);
  });

  it("get_today_brief wraps in envelope", async () => {
    const env = await runGetTodayBrief(tmpRoot);
    expect(env.confidence).toBe(1.0);
    expect(Array.isArray(env.source_atoms)).toBe(true);
  });

  it("get_my_pending wraps in envelope", async () => {
    const env = await runGetMyPending(tmpRoot, "daizhe");
    expect(env.confidence).toBe(1.0);
    expect(env.alternatives).toEqual([]);
  });

  it("get_for_person wraps in envelope", async () => {
    const env = await runGetForPerson(tmpRoot, "eric");
    expect(env.confidence).toBe(1.0);
  });

  it("get_for_project wraps in envelope", async () => {
    const env = await runGetForProject(tmpRoot, "v1-launch");
    expect(env.confidence).toBe(1.0);
  });

  it("get_thread_state wraps in envelope", async () => {
    const env = await runGetThreadState(tmpRoot, "pricing-debate");
    expect(env.confidence).toBe(1.0);
  });

  it("get_recent_decisions wraps in envelope", async () => {
    const env = await runGetRecentDecisions(tmpRoot, 7);
    expect(env.confidence).toBe(1.0);
  });
});

// ----------------------------------------------------------------------
// Per-tool behavior

describe("query_team_memory", () => {
  it("returns hits for an obvious substring", async () => {
    const env = await runQueryTeamMemory(tmpRoot, { query: "$20/seat" });
    expect(env.data.hits.length).toBeGreaterThan(0);
    expect(env.data.hits[0].file).toBe("decisions/pricing-20-seat.md");
  });
});

describe("get_today_brief", () => {
  it("returns the brief file when daemon has written it", async () => {
    const env = await runGetTodayBrief(tmpRoot);
    expect(env.data.origin).toBe("brief_file");
    expect(env.data.markdown).toContain(`Daily Brief — ${today}`);
  });

  it("synthesises when brief file is missing", async () => {
    // Move brief file aside and rerun.
    const briefFile = path.join(briefsPath, `${today}.md`);
    const tmp = `${briefFile}.bak`;
    await fs.rename(briefFile, tmp);
    try {
      const env = await runGetTodayBrief(tmpRoot);
      expect(["synthesised", "empty"]).toContain(env.data.origin);
      if (env.data.origin === "synthesised") {
        expect(env.data.markdown).toContain(`Today's Brief`);
        expect(env.data.source_atoms.length).toBeGreaterThan(0);
      }
    } finally {
      await fs.rename(tmp, briefFile);
    }
  });
});

describe("get_my_pending", () => {
  it("returns the open action items for daizhe (overdue first)", async () => {
    const env = await runGetMyPending(tmpRoot, "daizhe");
    // Should contain the overdue ticket + today's pricing decision; should
    // exclude the closed comment and never include the sample.
    const ids = env.data.items.map((i) => i.id);
    expect(ids).toContain("evt-2026-04-20-7777777777");
    expect(ids).toContain("evt-2026-04-25-aaaaaaaaaa");
    expect(ids).not.toContain("evt-2026-04-25-bbbbbbbbbb"); // closed
    expect(ids).not.toContain("evt-2026-04-24-eeeeeeeeee"); // sample
    // Overdue first.
    expect(env.data.items[0].id).toBe("evt-2026-04-20-7777777777");
    expect(env.data.items[0].overdue).toBe(true);
  });

  it("returns empty for an unknown user", async () => {
    const env = await runGetMyPending(tmpRoot, "nobody");
    expect(env.data.count).toBe(0);
    expect(env.data.items).toEqual([]);
  });

  it("matches user case-insensitively", async () => {
    const env = await runGetMyPending(tmpRoot, "DAIZHE");
    expect(env.data.count).toBeGreaterThan(0);
  });
});

describe("get_for_person", () => {
  it("returns recent atoms involving the person", async () => {
    const env = await runGetForPerson(tmpRoot, "eric");
    expect(env.data.count).toBeGreaterThan(0);
    expect(env.data.atoms.every((a) =>
      (a.actors ?? [a.actor]).includes("eric") ||
      (a.refs?.people ?? []).includes("eric"),
    )).toBe(true);
  });

  it("respects the 30-day window (excludes the 45-day-old atom)", async () => {
    const env = await runGetForPerson(tmpRoot, "daizhe");
    expect(env.data.atoms.map((a) => a.id)).not.toContain(
      "evt-2025-old-ffffffffff",
    );
  });

  it("excludes sample atoms", async () => {
    const env = await runGetForPerson(tmpRoot, "system");
    expect(env.data.atoms.map((a) => a.id)).not.toContain(
      "evt-2026-04-24-eeeeeeeeee",
    );
  });

  it("sorts newest first", async () => {
    const env = await runGetForPerson(tmpRoot, "daizhe");
    for (let i = 1; i < env.data.atoms.length; i++) {
      expect(env.data.atoms[i - 1].ts >= env.data.atoms[i].ts).toBe(true);
    }
  });
});

describe("get_for_project", () => {
  it("returns recent atoms in the project", async () => {
    const env = await runGetForProject(tmpRoot, "v1-launch");
    expect(env.data.count).toBeGreaterThan(0);
    for (const a of env.data.atoms) {
      expect(a.refs?.projects ?? []).toContain("v1-launch");
    }
  });

  it("returns empty for unknown slug", async () => {
    const env = await runGetForProject(tmpRoot, "no-such-project");
    expect(env.data.count).toBe(0);
  });
});

describe("get_thread_state", () => {
  it("returns chronologically sorted atoms for the thread", async () => {
    const env = await runGetThreadState(tmpRoot, "pricing-debate");
    expect(env.data.count).toBe(2);
    expect(env.data.atoms[0].ts < env.data.atoms[1].ts).toBe(true);
    // Decision in the thread surfaces in decisions_resolved.
    expect(env.data.decisions_resolved).toContain("pricing-20-seat");
  });

  it("includes the narrative file when present", async () => {
    const env = await runGetThreadState(tmpRoot, "pricing-debate");
    expect(env.data.narrative).toContain("Long-running pricing thread");
  });

  it("returns active status when no atom is closed", async () => {
    const env = await runGetThreadState(tmpRoot, "pricing-debate");
    expect(env.data.status).toBe("active");
  });

  it("returns null narrative when no thread file exists", async () => {
    const env = await runGetThreadState(tmpRoot, "no-such-thread");
    expect(env.data.narrative).toBeNull();
  });
});

describe("get_recent_decisions", () => {
  it("returns decisions in the last 7 days only by default", async () => {
    const env = await runGetRecentDecisions(tmpRoot);
    const ids = env.data.atoms.map((a) => a.id);
    expect(ids).toContain("evt-2026-04-25-aaaaaaaaaa");
    expect(ids).not.toContain("evt-2025-old-ffffffffff");
  });

  it("widens window when asked", async () => {
    const env = await runGetRecentDecisions(tmpRoot, 60);
    const ids = env.data.atoms.map((a) => a.id);
    expect(ids).toContain("evt-2025-old-ffffffffff");
  });

  it("excludes sample atoms", async () => {
    const env = await runGetRecentDecisions(tmpRoot, 60);
    const ids = env.data.atoms.map((a) => a.id);
    expect(ids).not.toContain("evt-2026-04-24-eeeeeeeeee");
  });

  it("clamps days argument to [1,365]", async () => {
    const env = await runGetRecentDecisions(tmpRoot, 9999);
    expect(env.data.window_days).toBe(365);
  });

  it("source_atoms reflects returned atom ids", async () => {
    const env = await runGetRecentDecisions(tmpRoot, 60);
    expect(env.source_atoms).toEqual(env.data.atoms.map((a) => a.id));
  });
});

// ----------------------------------------------------------------------
// Resilience

describe("missing sidecar", () => {
  it("returns empty data without throwing", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "tng-empty-"));
    try {
      const env = await runGetMyPending(empty, "anyone");
      expect(env.data.items).toEqual([]);
      expect(env.confidence).toBe(1.0);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it("get_today_brief returns origin=empty when nothing is there", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "tng-empty-brief-"));
    try {
      const env = await runGetTodayBrief(empty);
      expect(env.data.origin).toBe("empty");
      expect(env.data.markdown).toBe("");
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});
