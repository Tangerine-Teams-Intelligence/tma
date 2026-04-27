/**
 * v2.0-alpha.2 — WorkflowGraph component tests.
 *
 * Reactflow inspects DOM measurements (ResizeObserver, getBoundingClientRect)
 * that jsdom doesn't implement; we shim the missing globals here so the
 * component can mount inside vitest without crashing. The graph builder
 * (`buildGraph`) is exercised separately via direct calls so the schema
 * is verified independently of the reactflow renderer.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// reactflow measurement override — jsdom returns 0×0 for every element,
// which trips reactflow's internal layout assertions. The shared
// `tests/setup.ts` stubs ResizeObserver + DOMMatrix; this file extends
// the override to give reactflow a non-zero viewport box. Scoped to this
// file so other tests aren't affected.
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

import { WorkflowGraph, buildGraph } from "../src/components/graphs/WorkflowGraph";
import * as atomsLib from "../src/lib/atoms";
import type { AtomEntry } from "../src/lib/atoms";

function renderGraph() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<WorkflowGraph />} />
      </Routes>
    </MemoryRouter>,
  );
}

const sampleAtoms: AtomEntry[] = [
  { rel_path: "team/people/daizhe.md", kind: "people", scope: "team", name: "daizhe.md" },
  { rel_path: "team/people/hongyu.md", kind: "people", scope: "team", name: "hongyu.md" },
  { rel_path: "team/projects/v1-launch.md", kind: "projects", scope: "team", name: "v1-launch.md" },
  {
    rel_path: "team/decisions/2026-04-pricing-daizhe.md",
    kind: "decisions",
    scope: "team",
    name: "2026-04-pricing-daizhe.md",
  },
  {
    rel_path: "personal/me/cursor/2026-04-26-graph-build.md",
    kind: "agents",
    scope: "personal",
    name: "2026-04-26-graph-build.md",
  },
];

describe("WorkflowGraph — buildGraph schema", () => {
  it("renders nodes from atoms (one per kind)", () => {
    const { nodes, edges } = buildGraph(sampleAtoms);
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain("person:daizhe");
    expect(ids).toContain("person:hongyu");
    expect(ids).toContain("project:v1-launch");
    expect(ids).toContain("decision:2026-04-pricing-daizhe");
    expect(ids).toContain("agent:cursor");
    // Mention edge: pricing-daizhe references @daizhe.
    const mention = edges.find(
      (e) => e.source === "person:daizhe" && e.target === "decision:2026-04-pricing-daizhe",
    );
    expect(mention).toBeTruthy();
    expect(mention?.data).toMatchObject({ kind: "mention" });
  });

  it("does not collapse two decisions into one node", () => {
    const atoms: AtomEntry[] = [
      { rel_path: "team/decisions/a.md", kind: "decisions", scope: "team", name: "a.md" },
      { rel_path: "team/decisions/b.md", kind: "decisions", scope: "team", name: "b.md" },
    ];
    const { nodes } = buildGraph(atoms);
    const decisionIds = nodes.filter((n) => n.type === "decision").map((n) => n.id);
    expect(decisionIds).toEqual(["decision:a", "decision:b"]);
  });

  it("places each node at a finite position", () => {
    const { nodes } = buildGraph(sampleAtoms);
    for (const n of nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });
});

describe("WorkflowGraph — render", () => {
  it("renders the graph region when atoms exist", async () => {
    vi.spyOn(atomsLib, "listAtoms").mockResolvedValueOnce({
      root: "~/.tangerine-memory",
      atoms: sampleAtoms,
      personal_included: true,
    });
    renderGraph();
    await waitFor(() =>
      expect(screen.getByTestId("workflow-graph")).toBeInTheDocument(),
    );
    cleanup();
  });

  it("renders the empty state when no atoms", async () => {
    vi.spyOn(atomsLib, "listAtoms").mockResolvedValueOnce({
      root: "~/.tangerine-memory",
      atoms: [],
      personal_included: true,
    });
    renderGraph();
    await waitFor(() =>
      expect(screen.getByTestId("workflow-graph-empty")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Connect a source to see your team's workflow/i),
    ).toBeInTheDocument();
    cleanup();
  });

  it("clicking a person node navigates to the detail route", async () => {
    vi.spyOn(atomsLib, "listAtoms").mockResolvedValueOnce({
      root: "~/.tangerine-memory",
      atoms: sampleAtoms,
      personal_included: true,
    });
    let observedPath: string | null = null;
    function PathProbe(): null {
      // imported lazily so the import order matches the component tree
      const { useLocation } = require("react-router-dom");
      const loc = useLocation();
      observedPath = loc.pathname;
      return null;
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<WorkflowGraph />} />
          <Route path="/people/:alias" element={<PathProbe />} />
          <Route path="/projects/:slug" element={<PathProbe />} />
          <Route path="/memory/*" element={<PathProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    const node = await screen.findByTestId("workflow-node-person-daizhe");
    fireEvent.click(node);
    await waitFor(() => expect(observedPath).toBe("/people/daizhe"));
    cleanup();
  });

  it("does not crash when reactflow's pan/zoom controls render", async () => {
    vi.spyOn(atomsLib, "listAtoms").mockResolvedValueOnce({
      root: "~/.tangerine-memory",
      atoms: sampleAtoms,
      personal_included: true,
    });
    renderGraph();
    // reactflow draws SVG zoom controls inside the wrapper. We just assert
    // the wrapper is still in the DOM after a tick — pan/zoom is reactflow's
    // own concern and a unit test isn't the right place to drive wheel events.
    await waitFor(() => expect(screen.getByTestId("workflow-graph")).toBeInTheDocument());
    cleanup();
  });
});
