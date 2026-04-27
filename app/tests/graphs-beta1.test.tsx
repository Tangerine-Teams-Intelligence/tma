/**
 * v2.0-beta.1 — Tests for the three graph surfaces shipped in beta.1
 * (DecisionLineageTree / SocialGraph / ProjectTopology).
 *
 * Layered the same way as `workflow-graph.test.tsx`:
 *   - pure builder tests run synchronously off canned atom + body data
 *   - render tests mount through MemoryRouter with a `listAtoms` mock
 *
 * jsdom DOM-measurement shim duplicated here (rather than promoted to
 * setup.ts) so the workflow-graph test stays untouched and we don't risk
 * polluting unrelated suites.
 */
import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      top: 0,
      right: 800,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    };
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

import {
  DecisionLineageTree,
  buildLineageGraph,
  parseFrontmatter,
} from "../src/components/graphs/DecisionLineageTree";
import {
  SocialGraph,
  buildSocialGraph,
  aliasesPresent,
  atomTimestamp,
} from "../src/components/graphs/SocialGraph";
import {
  ProjectTopology,
  buildProjectTopology,
  parseProjectFm,
} from "../src/components/graphs/ProjectTopology";
import * as atomsLib from "../src/lib/atoms";
import type { AtomEntry } from "../src/lib/atoms";

// ---------------------------------------------------------------------------
// Decision Lineage
// ---------------------------------------------------------------------------

describe("DecisionLineageTree — parseFrontmatter", () => {
  it("parses block-style source_provenance + writeback", () => {
    const body = [
      "---",
      "title: Pricing decision",
      "source_provenance:",
      "  - meetings/2026-04-25-roadmap.md",
      "  - threads/pricing.md",
      "writeback:",
      "  - github://Tangerine-Intelligence/legal-documents#PR-42",
      "  - linear://TI-218",
      "---",
      "Body text.",
    ].join("\n");
    const fm = parseFrontmatter(body);
    expect(fm.source_provenance).toEqual([
      "meetings/2026-04-25-roadmap.md",
      "threads/pricing.md",
    ]);
    expect(fm.writeback).toEqual([
      "github://Tangerine-Intelligence/legal-documents#PR-42",
      "linear://TI-218",
    ]);
  });

  it("parses inline-style frontmatter", () => {
    const body =
      "---\nsource_provenance: [a.md, b.md]\nwriteback: [github://o/r#PR-1]\n---\n";
    const fm = parseFrontmatter(body);
    expect(fm.source_provenance).toEqual(["a.md", "b.md"]);
    expect(fm.writeback).toEqual(["github://o/r#PR-1"]);
  });

  it("returns empty arrays when fields are missing", () => {
    const fm = parseFrontmatter("no frontmatter here");
    expect(fm.source_provenance).toEqual([]);
    expect(fm.writeback).toEqual([]);
  });
});

describe("DecisionLineageTree — buildLineageGraph", () => {
  const decisionBody = [
    "---",
    "source_provenance:",
    "  - meetings/2026-04-25-roadmap.md",
    "  - threads/pricing.md",
    "writeback:",
    "  - github://owner/repo#PR-42",
    "---",
  ].join("\n");

  const atoms: AtomEntry[] = [
    {
      rel_path: "team/decisions/2026-04-pricing.md",
      kind: "decisions",
      scope: "team",
      name: "2026-04-pricing.md",
    },
  ];
  const bodies = new Map([
    ["team/decisions/2026-04-pricing.md", decisionBody],
  ]);

  it("creates one decision + two source nodes + one writeback node", () => {
    const { nodes, edges } = buildLineageGraph(atoms, bodies);
    const types = nodes.map((n) => n.type).sort();
    // 1 decision + 2 source + 1 writeback = 4 nodes
    expect(nodes.length).toBe(4);
    expect(types.filter((t) => t === "lineage-decision").length).toBe(1);
    expect(types.filter((t) => t === "lineage-source").length).toBe(2);
    expect(types.filter((t) => t === "lineage-writeback").length).toBe(1);
    // Edges: 2 derived_from + 1 writeback
    expect(edges.length).toBe(3);
    const kinds = edges.map((e) => (e.data as { kind: string }).kind).sort();
    expect(kinds).toEqual(["derived_from", "derived_from", "writeback"]);
  });

  it("places sources above decision (rank 0) and writebacks below (rank 2)", () => {
    const { nodes } = buildLineageGraph(atoms, bodies);
    const decision = nodes.find((n) => n.type === "lineage-decision");
    const source = nodes.find((n) => n.type === "lineage-source");
    const wb = nodes.find((n) => n.type === "lineage-writeback");
    expect(source!.position.y).toBeLessThan(decision!.position.y);
    expect(wb!.position.y).toBeGreaterThan(decision!.position.y);
  });

  it("renders a lone diamond when the decision has no provenance", () => {
    const lone: AtomEntry[] = [
      {
        rel_path: "team/decisions/empty.md",
        kind: "decisions",
        scope: "team",
        name: "empty.md",
      },
    ];
    const { nodes, edges } = buildLineageGraph(lone, new Map());
    expect(nodes.length).toBe(1);
    expect(nodes[0].type).toBe("lineage-decision");
    expect(edges.length).toBe(0);
  });
});

describe("DecisionLineageTree — render", () => {
  it("renders the empty state when no decision atoms exist", async () => {
    vi.spyOn(atomsLib, "listAtoms").mockResolvedValueOnce({
      root: "~/.tangerine-memory",
      atoms: [],
      personal_included: true,
    });
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<DecisionLineageTree />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("lineage-tree-empty")).toBeInTheDocument(),
    );
  });

  it("renders the graph region when a decision atom exists", async () => {
    vi.spyOn(atomsLib, "listAtoms").mockResolvedValueOnce({
      root: "~/.tangerine-memory",
      atoms: [
        {
          rel_path: "team/decisions/2026-04-pricing.md",
          kind: "decisions",
          scope: "team",
          name: "2026-04-pricing.md",
        },
      ],
      personal_included: true,
    });
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<DecisionLineageTree />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("lineage-tree")).toBeInTheDocument(),
    );
  });
});

// ---------------------------------------------------------------------------
// Social Graph
// ---------------------------------------------------------------------------

describe("SocialGraph — aliasesPresent", () => {
  const aliases = new Set(["daizhe", "hongyu"]);

  it("matches @-prefixed aliases", () => {
    expect(aliasesPresent("ping @daizhe later", aliases)).toEqual(
      new Set(["daizhe"]),
    );
  });

  it("matches whole-word aliases without @", () => {
    expect(aliasesPresent("daizhe approved the spec.", aliases)).toEqual(
      new Set(["daizhe"]),
    );
  });

  it("does not match partial substrings", () => {
    // "daizhei" should not match "daizhe"
    expect(aliasesPresent("daizhei is unrelated", aliases)).toEqual(
      new Set(),
    );
  });

  it("returns multiple aliases when both appear", () => {
    expect(
      aliasesPresent("@daizhe + hongyu sync", aliases),
    ).toEqual(new Set(["daizhe", "hongyu"]));
  });
});

describe("SocialGraph — atomTimestamp", () => {
  const now = new Date("2026-04-26T00:00:00");
  it("parses YYYY-MM-DD prefix from atom name", () => {
    const ts = atomTimestamp(
      {
        rel_path: "x",
        kind: "meetings",
        scope: "team",
        name: "2026-04-25-roadmap.md",
      },
      now,
    );
    // Compare local-time fields rather than ISO string so the test passes
    // regardless of which timezone CI runs in.
    expect(ts.getFullYear()).toBe(2026);
    expect(ts.getMonth()).toBe(3); // April (0-indexed)
    expect(ts.getDate()).toBe(25);
  });
  it("falls back to now when filename has no date prefix", () => {
    const ts = atomTimestamp(
      { rel_path: "x", kind: "meetings", scope: "team", name: "roadmap.md" },
      now,
    );
    expect(ts).toBe(now);
  });
});

describe("SocialGraph — buildSocialGraph", () => {
  const atoms: AtomEntry[] = [
    {
      rel_path: "team/people/daizhe.md",
      kind: "people",
      scope: "team",
      name: "daizhe.md",
    },
    {
      rel_path: "team/people/hongyu.md",
      kind: "people",
      scope: "team",
      name: "hongyu.md",
    },
    {
      rel_path: "team/people/ada.md",
      kind: "people",
      scope: "team",
      name: "ada.md",
    },
    {
      rel_path: "team/meetings/2026-04-25-pricing.md",
      kind: "meetings",
      scope: "team",
      name: "2026-04-25-pricing.md",
    },
    {
      rel_path: "team/meetings/2026-04-26-roadmap.md",
      kind: "meetings",
      scope: "team",
      name: "2026-04-26-roadmap.md",
    },
  ];
  const bodies = new Map([
    [
      "team/meetings/2026-04-25-pricing.md",
      "Discussion between @daizhe and @hongyu about pricing.",
    ],
    [
      "team/meetings/2026-04-26-roadmap.md",
      "@daizhe + @hongyu + ada synced on roadmap.",
    ],
  ]);

  it("creates one node per person", () => {
    const { nodes } = buildSocialGraph(atoms, bodies, {
      now: new Date("2026-04-26T00:00:00"),
    });
    expect(nodes.length).toBe(3);
    const ids = nodes.map((n) => n.id).sort();
    expect(ids).toEqual([
      "person:ada",
      "person:daizhe",
      "person:hongyu",
    ]);
  });

  it("computes mention frequency: daizhe-hongyu > daizhe-ada", () => {
    const { rawEdges } = buildSocialGraph(atoms, bodies, {
      now: new Date("2026-04-26T00:00:00"),
    });
    const dh = rawEdges.find(
      (e) =>
        (e.from === "daizhe" && e.to === "hongyu") ||
        (e.from === "hongyu" && e.to === "daizhe"),
    );
    const da = rawEdges.find(
      (e) =>
        (e.from === "daizhe" && e.to === "ada") ||
        (e.from === "ada" && e.to === "daizhe"),
    );
    expect(dh).toBeTruthy();
    expect(da).toBeTruthy();
    // daizhe-hongyu appears in 2 atoms; daizhe-ada in 1.
    expect(dh!.weight).toBeGreaterThan(da!.weight);
  });

  it("filters out atoms older than the window", () => {
    const oldAtoms: AtomEntry[] = [
      ...atoms,
      {
        rel_path: "team/meetings/2025-01-01-ancient.md",
        kind: "meetings",
        scope: "team",
        name: "2025-01-01-ancient.md",
      },
    ];
    const oldBodies = new Map([
      ...bodies,
      [
        "team/meetings/2025-01-01-ancient.md",
        "@daizhe and @ada talked long ago.",
      ],
    ]);
    const { rawEdges } = buildSocialGraph(oldAtoms, oldBodies, {
      windowDays: 30,
      now: new Date("2026-04-26T00:00:00"),
    });
    // The ancient atom's daizhe-ada contribution should be excluded; the
    // remaining roadmap atom still pairs them, so the edge survives but
    // with the lower weight from the single in-window atom.
    const da = rawEdges.find(
      (e) =>
        (e.from === "daizhe" && e.to === "ada") ||
        (e.from === "ada" && e.to === "daizhe"),
    );
    expect(da).toBeTruthy();
    expect(da!.weight).toBeLessThan(3); // 1 in-window atom worth, not 2
  });
});

describe("SocialGraph — render", () => {
  it("renders the empty state when no people atoms exist", async () => {
    vi.spyOn(atomsLib, "listAtoms").mockResolvedValueOnce({
      root: "~/.tangerine-memory",
      atoms: [],
      personal_included: true,
    });
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<SocialGraph />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("social-graph-empty")).toBeInTheDocument(),
    );
  });
});

// ---------------------------------------------------------------------------
// Project Topology
// ---------------------------------------------------------------------------

describe("ProjectTopology — parseProjectFm", () => {
  it("parses status + block-style dependencies", () => {
    const body = [
      "---",
      "status: blocked",
      "dependencies:",
      "  - v1-launch",
      "  - migration",
      "---",
    ].join("\n");
    const fm = parseProjectFm(body);
    expect(fm.status).toBe("blocked");
    expect(fm.dependencies).toEqual(["v1-launch", "migration"]);
  });

  it("parses inline dependencies", () => {
    const fm = parseProjectFm(
      "---\nstatus: active\ndependencies: [a, b, c]\n---\n",
    );
    expect(fm.status).toBe("active");
    expect(fm.dependencies).toEqual(["a", "b", "c"]);
  });

  it("defaults to idle status when missing", () => {
    expect(parseProjectFm("").status).toBe("idle");
    expect(parseProjectFm("---\n---\n").status).toBe("idle");
  });

  it("ignores unknown status values", () => {
    expect(parseProjectFm("---\nstatus: pending\n---\n").status).toBe("idle");
  });
});

describe("ProjectTopology — buildProjectTopology", () => {
  const atoms: AtomEntry[] = [
    {
      rel_path: "team/projects/v1-launch.md",
      kind: "projects",
      scope: "team",
      name: "v1-launch.md",
    },
    {
      rel_path: "team/projects/v2-graphs.md",
      kind: "projects",
      scope: "team",
      name: "v2-graphs.md",
    },
    {
      rel_path: "team/projects/v2-marketplace.md",
      kind: "projects",
      scope: "team",
      name: "v2-marketplace.md",
    },
  ];

  it("places dependents below their dependencies (hierarchical)", () => {
    const bodies = new Map([
      [
        "team/projects/v1-launch.md",
        "---\nstatus: done\n---\n",
      ],
      [
        "team/projects/v2-graphs.md",
        "---\nstatus: active\ndependencies:\n  - v1-launch\n---\n",
      ],
      [
        "team/projects/v2-marketplace.md",
        "---\nstatus: blocked\ndependencies:\n  - v2-graphs\n---\n",
      ],
    ]);
    const { nodes, edges } = buildProjectTopology(atoms, bodies);
    expect(nodes.length).toBe(3);
    expect(edges.length).toBe(2);
    const v1 = nodes.find((n) => n.id === "project:v1-launch")!;
    const v2g = nodes.find((n) => n.id === "project:v2-graphs")!;
    const v2m = nodes.find((n) => n.id === "project:v2-marketplace")!;
    expect(v1.position.y).toBeLessThan(v2g.position.y);
    expect(v2g.position.y).toBeLessThan(v2m.position.y);
  });

  it("encodes status into node data", () => {
    const bodies = new Map([
      ["team/projects/v1-launch.md", "---\nstatus: done\n---\n"],
      ["team/projects/v2-graphs.md", "---\nstatus: active\n---\n"],
      ["team/projects/v2-marketplace.md", "---\nstatus: blocked\n---\n"],
    ]);
    const { nodes } = buildProjectTopology(atoms, bodies);
    const statusBy = new Map(
      nodes.map((n) => [
        n.id,
        (n.data as { status: string }).status,
      ]),
    );
    expect(statusBy.get("project:v1-launch")).toBe("done");
    expect(statusBy.get("project:v2-graphs")).toBe("active");
    expect(statusBy.get("project:v2-marketplace")).toBe("blocked");
  });

  it("drops dependency edges that point at unknown projects", () => {
    const bodies = new Map([
      [
        "team/projects/v1-launch.md",
        "---\nstatus: active\ndependencies:\n  - ghost-project\n---\n",
      ],
      ["team/projects/v2-graphs.md", "---\nstatus: active\n---\n"],
      ["team/projects/v2-marketplace.md", "---\nstatus: idle\n---\n"],
    ]);
    const { edges } = buildProjectTopology(atoms, bodies);
    expect(edges.length).toBe(0);
  });
});

describe("ProjectTopology — render", () => {
  it("renders the empty state when no project atoms exist", async () => {
    vi.spyOn(atomsLib, "listAtoms").mockResolvedValueOnce({
      root: "~/.tangerine-memory",
      atoms: [],
      personal_included: true,
    });
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<ProjectTopology />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("topology-graph-empty")).toBeInTheDocument(),
    );
  });
});
