// === wave 23 ===
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import MemoryRoute from "../src/routes/memory";
import { MemoryGraphView } from "../src/components/memory/MemoryGraphView";
import { MemoryListView } from "../src/components/memory/MemoryListView";
import * as tauri from "../src/lib/tauri";
import * as memoryLib from "../src/lib/memory";
import { useStore } from "../src/lib/store";
import type {
  AtomGraphData,
  BacklinksResult,
  MemoryTreeResult,
} from "../src/lib/tauri";

const SAMPLE_TREE: MemoryTreeResult = {
  root: "/Users/test/.tangerine-memory",
  nodes: [
    {
      path: "team",
      name: "team",
      kind: "dir",
      scope: "team",
      children: [
        {
          path: "team/decisions",
          name: "decisions",
          kind: "dir",
          scope: "team",
          children: [
            {
              path: "team/decisions/alpha.md",
              name: "alpha.md",
              kind: "file",
              scope: "team",
              children: [],
            },
            {
              path: "team/decisions/beta.md",
              name: "beta.md",
              kind: "file",
              scope: "team",
              children: [],
            },
          ],
        },
      ],
    },
  ],
  total_nodes: 3,
  file_count: 2,
  dir_count: 1,
  truncated: false,
};

const SAMPLE_GRAPH: AtomGraphData = {
  nodes: [
    {
      id: "team/decisions/alpha.md",
      label: "Alpha",
      vendor: "cursor",
      author: "alex",
      kind: "decisions",
      project: null,
      timestamp: "2026-04-22",
    },
    {
      id: "team/decisions/beta.md",
      label: "Beta",
      vendor: "claude-code",
      author: "alex",
      kind: "decisions",
      project: null,
      timestamp: "2026-04-23",
    },
  ],
  edges: [
    {
      source: "team/decisions/beta.md",
      target: "team/decisions/alpha.md",
      kind: "cites",
      weight: 1.0,
    },
    {
      source: "team/decisions/alpha.md",
      target: "team/decisions/beta.md",
      kind: "same_author",
      weight: 0.25,
    },
  ],
  truncated: false,
};

beforeEach(() => {
  vi.restoreAllMocks();
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      memoryConfig: { ...s.ui.memoryConfig, mode: "solo" },
      // Default to tree so the toggle test starts from the known baseline.
      memoryViewMode: "tree",
    },
  }));
  vi.spyOn(tauri, "memoryTree").mockResolvedValue(SAMPLE_TREE);
  vi.spyOn(tauri, "computeBacklinks").mockResolvedValue({
    target_path: null,
    target_title: null,
    hits: [],
  } satisfies BacklinksResult);
  vi.spyOn(tauri, "memoryGraphData").mockResolvedValue(SAMPLE_GRAPH);
  vi.spyOn(memoryLib, "readMemoryFile").mockResolvedValue("# Body");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Wave 23 — view toggle on /memory route", () => {
  it("renders Tree | Graph | List toggle and switches the right pane", async () => {
    render(
      <MemoryRouter initialEntries={["/memory"]}>
        <Routes>
          <Route path="/memory" element={<MemoryRoute />} />
          <Route path="/memory/*" element={<MemoryRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("memory-view-toggle")).toBeInTheDocument();
    });
    // All three tabs render.
    expect(screen.getByTestId("memory-view-toggle-tree")).toBeInTheDocument();
    expect(screen.getByTestId("memory-view-toggle-graph")).toBeInTheDocument();
    expect(screen.getByTestId("memory-view-toggle-list")).toBeInTheDocument();
    // Tree is the default.
    expect(
      screen.getByTestId("memory-view-toggle-tree").getAttribute("aria-selected"),
    ).toBe("true");
    // Click Graph → graph view mounts, preview unmounts.
    fireEvent.click(screen.getByTestId("memory-view-toggle-graph"));
    await waitFor(() => {
      expect(screen.getByTestId("memory-graph-view")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("memory-preview-empty")).not.toBeInTheDocument();
    // Click List → list view mounts.
    fireEvent.click(screen.getByTestId("memory-view-toggle-list"));
    await waitFor(() => {
      expect(screen.getByTestId("memory-list-view")).toBeInTheDocument();
    });
  });
});

describe("Wave 23 — MemoryGraphView component", () => {
  it("renders one node per atom with vendor color", async () => {
    render(
      <MemoryGraphView
        selectedPath={null}
        onSelect={() => {}}
        vendorFilter={null}
        kindFilter={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("memory-graph-view")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("atom-graph-node-team/decisions/alpha.md"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("atom-graph-node-team/decisions/beta.md"),
    ).toBeInTheDocument();
    // Vendor color dots — by data-vendor attr.
    const alpha = screen.getByTestId("atom-graph-node-team/decisions/alpha.md");
    expect(alpha.getAttribute("data-vendor")).toBe("cursor");
  });

  it("clicking a node fires onSelect with the atom path", async () => {
    const onSelect = vi.fn();
    render(
      <MemoryGraphView
        selectedPath={null}
        onSelect={onSelect}
        vendorFilter={null}
        kindFilter={null}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("atom-graph-node-team/decisions/alpha.md"),
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByTestId("atom-graph-node-team/decisions/alpha.md"),
    );
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith("team/decisions/alpha.md");
    });
  });

  it("renders the empty state when no atoms exist", async () => {
    vi.spyOn(tauri, "memoryGraphData").mockResolvedValue({
      nodes: [],
      edges: [],
      truncated: false,
    });
    render(
      <MemoryGraphView
        selectedPath={null}
        onSelect={() => {}}
        vendorFilter={null}
        kindFilter={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("memory-graph-empty")).toBeInTheDocument();
    });
  });

  it("renders cluster-by select with the four cluster keys", async () => {
    render(
      <MemoryGraphView
        selectedPath={null}
        onSelect={() => {}}
        vendorFilter={null}
        kindFilter={null}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("memory-graph-cluster-select"),
      ).toBeInTheDocument();
    });
    const sel = screen.getByTestId(
      "memory-graph-cluster-select",
    ) as HTMLSelectElement;
    const opts = Array.from(sel.options).map((o) => o.value);
    expect(opts).toEqual(["vendor", "author", "project", "kind"]);
  });
});

describe("Wave 23 — MemoryListView component", () => {
  it("renders a row per atom and fires onSelect on click", async () => {
    const onSelect = vi.fn();
    render(
      <MemoryListView
        selectedPath={null}
        onSelect={onSelect}
        vendorFilter={null}
        kindFilter={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("memory-list-view")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("memory-list-row-team/decisions/alpha.md"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("memory-list-row-team/decisions/beta.md"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByTestId("memory-list-row-team/decisions/beta.md"),
    );
    expect(onSelect).toHaveBeenCalledWith("team/decisions/beta.md");
  });
});

describe("Wave 23 — node visuals through MemoryGraphView", () => {
  it("renders vendor color dots and the search input", async () => {
    render(
      <MemoryGraphView
        selectedPath={null}
        onSelect={() => {}}
        vendorFilter={null}
        kindFilter={null}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("atom-graph-node-dot-team/decisions/alpha.md"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("atom-graph-node-dot-team/decisions/beta.md"),
    ).toBeInTheDocument();
    // Search input wires through to graph rendering.
    expect(screen.getByTestId("memory-graph-search")).toBeInTheDocument();
    // Both atom edges from SAMPLE_GRAPH (cites + same_author) come through
    // the React-side edge build (verifiable via the toolbar visible counter
    // showing both nodes are in the subset).
    expect(screen.getByTestId("memory-graph-toolbar")).toHaveTextContent("2/2");
  });
});
// === end wave 23 ===
