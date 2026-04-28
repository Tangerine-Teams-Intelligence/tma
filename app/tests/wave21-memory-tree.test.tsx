// === wave 21 ===
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import MemoryRoute from "../src/routes/memory";
import { MemoryTree, inferVendorFromPath } from "../src/components/memory/MemoryTree";
import { MemoryPreview } from "../src/components/memory/MemoryPreview";
import { MemoryFilterPills } from "../src/components/memory/MemoryFilterPills";
import * as tauri from "../src/lib/tauri";
import * as memoryLib from "../src/lib/memory";
import { useStore } from "../src/lib/store";
import type { MemoryTreeNode, MemoryTreeResult, BacklinksResult } from "../src/lib/tauri";

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
              path: "team/decisions/pcb-tier2.md",
              name: "pcb-tier2.md",
              kind: "file",
              scope: "team",
              children: [],
            },
            {
              path: "team/decisions/pricing.md",
              name: "pricing.md",
              kind: "file",
              scope: "team",
              children: [],
            },
          ],
        },
      ],
    },
    {
      path: "personal",
      name: "personal",
      kind: "dir",
      scope: "personal",
      children: [
        {
          path: "personal/alex",
          name: "alex",
          kind: "dir",
          scope: "personal",
          children: [
            {
              path: "personal/alex/threads",
              name: "threads",
              kind: "dir",
              scope: "personal",
              children: [
                {
                  path: "personal/alex/threads/cursor",
                  name: "cursor",
                  kind: "dir",
                  scope: "personal",
                  children: [
                    {
                      path: "personal/alex/threads/cursor/sample-1.md",
                      name: "sample-1.md",
                      kind: "file",
                      scope: "personal",
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  total_nodes: 8,
  file_count: 3,
  dir_count: 5,
  truncated: false,
};

const SAMPLE_FILE_BODY = `---
title: PCB Tier 2 supplier
author: alex
vendor: cursor
date: 2026-04-22
---

## Decision

We chose Tier 2 because cost-per-board fell within budget.
`;

beforeEach(() => {
  vi.restoreAllMocks();
  // Set memoryConfig.mode so the route doesn't redirect to /onboarding-team.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      memoryConfig: { ...s.ui.memoryConfig, mode: "solo" },
    },
  }));
  vi.spyOn(tauri, "memoryTree").mockResolvedValue(SAMPLE_TREE);
  vi.spyOn(tauri, "computeBacklinks").mockResolvedValue({
    target_path: null,
    target_title: null,
    hits: [],
  } satisfies BacklinksResult);
  vi.spyOn(memoryLib, "readMemoryFile").mockResolvedValue(SAMPLE_FILE_BODY);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Wave 21 — MemoryTree component", () => {
  it("renders top-level dirs from supplied nodes", () => {
    render(
      <MemoryRouter>
        <MemoryTree
          nodes={SAMPLE_TREE.nodes}
          selectedPath={null}
          onSelect={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("memory-tree")).toBeInTheDocument();
    expect(screen.getByTestId("memory-tree-dir-team")).toBeInTheDocument();
    expect(screen.getByTestId("memory-tree-dir-personal")).toBeInTheDocument();
  });

  it("clicking a file row fires onSelect with the path", () => {
    const onSelect = vi.fn();
    render(
      <MemoryRouter>
        <MemoryTree
          nodes={SAMPLE_TREE.nodes}
          selectedPath={null}
          onSelect={onSelect}
        />
      </MemoryRouter>,
    );
    // Files are inside dirs that are open by default at depth 0; team is
    // depth 0 and decisions is a child, so we need to expand decisions.
    fireEvent.click(screen.getByTestId("memory-tree-dir-team/decisions"));
    fireEvent.click(
      screen.getByTestId("memory-tree-file-team/decisions/pcb-tier2.md"),
    );
    expect(onSelect).toHaveBeenCalledWith("team/decisions/pcb-tier2.md");
  });

  it("filter input narrows the tree", () => {
    render(
      <MemoryRouter>
        <MemoryTree
          nodes={SAMPLE_TREE.nodes}
          selectedPath={null}
          onSelect={() => {}}
          filter="pricing"
        />
      </MemoryRouter>,
    );
    // pricing.md should be reachable (parent dirs match by transitive
    // descendant); pcb-tier2.md should not exist in the tree.
    fireEvent.click(screen.getByTestId("memory-tree-dir-team/decisions"));
    expect(
      screen.getByTestId("memory-tree-file-team/decisions/pricing.md"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("memory-tree-file-team/decisions/pcb-tier2.md"),
    ).not.toBeInTheDocument();
  });

  it("renders a vendor color dot next to thread leaves", () => {
    render(
      <MemoryRouter>
        <MemoryTree
          nodes={SAMPLE_TREE.nodes}
          selectedPath={null}
          onSelect={() => {}}
        />
      </MemoryRouter>,
    );
    // Expand personal/alex/threads/cursor.
    fireEvent.click(screen.getByTestId("memory-tree-dir-personal/alex"));
    fireEvent.click(screen.getByTestId("memory-tree-dir-personal/alex/threads"));
    fireEvent.click(
      screen.getByTestId("memory-tree-dir-personal/alex/threads/cursor"),
    );
    expect(
      screen.getByTestId(
        "memory-tree-vendor-dot-personal/alex/threads/cursor/sample-1.md",
      ),
    ).toBeInTheDocument();
  });

  it("highlights the selected file row", () => {
    render(
      <MemoryRouter>
        <MemoryTree
          nodes={SAMPLE_TREE.nodes}
          selectedPath={"team/decisions/pricing.md"}
          onSelect={() => {}}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("memory-tree-dir-team/decisions"));
    const row = screen.getByTestId(
      "memory-tree-file-team/decisions/pricing.md",
    );
    expect(row.getAttribute("aria-selected")).toBe("true");
  });

  it("renders the empty state when no nodes match filter", () => {
    render(
      <MemoryRouter>
        <MemoryTree
          nodes={SAMPLE_TREE.nodes}
          selectedPath={null}
          onSelect={() => {}}
          filter="nonexistent-needle-xyz"
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("memory-tree-empty")).toBeInTheDocument();
  });
});

describe("Wave 21 — inferVendorFromPath", () => {
  it("recognizes vendor from threads/<vendor>/ path", () => {
    expect(
      inferVendorFromPath("personal/alex/threads/cursor/sample-1.md"),
    ).toBe("cursor");
  });

  it("recognizes vendor from any path segment", () => {
    expect(inferVendorFromPath("anything/codex/foo.md")).toBe("codex");
  });

  it("returns null when no vendor segment matches", () => {
    expect(inferVendorFromPath("team/decisions/pcb.md")).toBeNull();
  });
});

describe("Wave 21 — MemoryPreview component", () => {
  it("renders the empty state when no path", () => {
    render(
      <MemoryRouter>
        <MemoryPreview relPath={null} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("memory-preview-empty")).toBeInTheDocument();
  });

  it("renders frontmatter chips + body for a selected atom", async () => {
    render(
      <MemoryRouter>
        <MemoryPreview relPath="team/decisions/pcb-tier2.md" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("memory-preview")).toBeInTheDocument();
    });
    expect(screen.getByTestId("chip-author")).toHaveTextContent("alex");
    expect(screen.getByTestId("chip-date")).toHaveTextContent("2026-04-22");
    expect(screen.getByTestId("chip-vendor")).toBeInTheDocument();
  });

  it("renders the backlinks section header", async () => {
    render(
      <MemoryRouter>
        <MemoryPreview relPath="team/decisions/pcb-tier2.md" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("memory-preview-backlinks")).toBeInTheDocument();
    });
  });

  it("renders backlinks when computeBacklinks returns hits", async () => {
    vi.spyOn(tauri, "computeBacklinks").mockResolvedValue({
      target_path: "team/decisions/pcb-tier2.md",
      target_title: "pcb-tier2",
      hits: [
        {
          path: "team/timeline/2026-04-25.md",
          title: "Apr 25 timeline",
          snippet: "…cited team/decisions/pcb-tier2.md as the chosen…",
        },
      ],
    });
    render(
      <MemoryRouter>
        <MemoryPreview relPath="team/decisions/pcb-tier2.md" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId(
          "memory-preview-backlink-team/timeline/2026-04-25.md",
        ),
      ).toBeInTheDocument();
    });
  });
});

describe("Wave 21 — MemoryFilterPills", () => {
  it("renders vendor pills + date pills + search input", () => {
    render(
      <MemoryFilterPills
        vendorFilter={{}}
        onVendorToggle={() => {}}
        onVendorReset={() => {}}
        dateRange="30d"
        onDateRangeChange={() => {}}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(screen.getByTestId("memory-filter-pills")).toBeInTheDocument();
    expect(screen.getByTestId("memory-filter-search")).toBeInTheDocument();
    expect(screen.getByTestId("memory-filter-vendors")).toBeInTheDocument();
    expect(screen.getByTestId("memory-filter-date")).toBeInTheDocument();
    expect(screen.getByTestId("memory-filter-vendor-cursor")).toBeInTheDocument();
    expect(screen.getByTestId("memory-filter-date-30d")).toBeInTheDocument();
  });

  it("clicking a vendor pill fires onVendorToggle", () => {
    const onToggle = vi.fn();
    render(
      <MemoryFilterPills
        vendorFilter={{}}
        onVendorToggle={onToggle}
        onVendorReset={() => {}}
        dateRange="30d"
        onDateRangeChange={() => {}}
        search=""
        onSearchChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("memory-filter-vendor-cursor"));
    expect(onToggle).toHaveBeenCalledWith("cursor");
  });

  it("clicking a date pill fires onDateRangeChange", () => {
    const onChange = vi.fn();
    render(
      <MemoryFilterPills
        vendorFilter={{}}
        onVendorToggle={() => {}}
        onVendorReset={() => {}}
        dateRange="30d"
        onDateRangeChange={onChange}
        search=""
        onSearchChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("memory-filter-date-7d"));
    expect(onChange).toHaveBeenCalledWith("7d");
  });

  it("All vendors pill is active when no vendors selected", () => {
    render(
      <MemoryFilterPills
        vendorFilter={{}}
        onVendorToggle={() => {}}
        onVendorReset={() => {}}
        dateRange="30d"
        onDateRangeChange={() => {}}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(
      screen.getByTestId("memory-filter-all-vendors").getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

describe("Wave 21 — Memory route shell", () => {
  it("renders the header with atom + thread counts", async () => {
    render(
      <MemoryRouter initialEntries={["/memory"]}>
        <Routes>
          <Route path="/memory" element={<MemoryRoute />} />
          <Route path="/memory/*" element={<MemoryRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("memory-header")).toBeInTheDocument();
    });
    // 3 files in the SAMPLE_TREE; 2 distinct dirs contain files.
    const header = screen.getByTestId("memory-header");
    expect(header.textContent).toMatch(/3 atoms/);
  });

  it("renders left pane with tree and right pane with empty state", async () => {
    render(
      <MemoryRouter initialEntries={["/memory"]}>
        <Routes>
          <Route path="/memory" element={<MemoryRoute />} />
          <Route path="/memory/*" element={<MemoryRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("memory-left-pane")).toBeInTheDocument();
    });
    expect(screen.getByTestId("memory-right-pane")).toBeInTheDocument();
    expect(screen.getByTestId("memory-preview-empty")).toBeInTheDocument();
  });

  it("renders the New decision button", async () => {
    render(
      <MemoryRouter initialEntries={["/memory"]}>
        <Routes>
          <Route path="/memory" element={<MemoryRoute />} />
          <Route path="/memory/*" element={<MemoryRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("memory-new-decision")).toBeInTheDocument();
    });
  });

  it("renders the preview pane when a path is in the URL", async () => {
    render(
      <MemoryRouter initialEntries={["/memory/team/decisions/pcb-tier2.md"]}>
        <Routes>
          <Route path="/memory" element={<MemoryRoute />} />
          <Route path="/memory/*" element={<MemoryRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("memory-preview")).toBeInTheDocument();
    });
  });
});
// === end wave 21 ===
