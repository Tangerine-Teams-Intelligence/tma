// === wave 1.13-B ===
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import "../src/i18n/index";

vi.mock("../src/lib/store", () => {
  return {
    useStore: (selector: (state: unknown) => unknown) =>
      selector({
        ui: { currentUser: "alex", memoryRoot: "/tmp/mem", pushToast: vi.fn() },
      }),
  };
});

vi.mock("../src/lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../src/lib/tauri",
  );
  return {
    ...actual,
    reviewListPending: vi.fn(async () => [
      {
        atom_path: "team/decisions/abc.md",
        atom_title: "Pricing change",
        status: "under-review",
        proposer: "sam",
        reviewers: ["alex", "hongyu"],
        votes_cast: 0,
        votes_required: 2,
        deadline: null,
        proposed_at: "2026-04-27T12:00:00Z",
      },
    ]),
    reviewListProposedBy: vi.fn(async () => []),
    reviewListByStatus: vi.fn(async (status: string) =>
      status === "ratified"
        ? [
            {
              atom_path: "team/decisions/old.md",
              atom_title: "Old call",
              status: "ratified",
              proposer: "alex",
              reviewers: ["alex", "sam"],
              votes_cast: 2,
              votes_required: 2,
              deadline: null,
              proposed_at: "2026-04-20T00:00:00Z",
            },
          ]
        : [],
    ),
  };
});

import ReviewsRoute from "../src/routes/reviews";

describe("ReviewsRoute (wave 1.13-B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the four tabs", async () => {
    render(
      <MemoryRouter>
        <ReviewsRoute />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("reviews-tab-pending")).toBeInTheDocument();
    expect(screen.getByTestId("reviews-tab-proposed")).toBeInTheDocument();
    expect(screen.getByTestId("reviews-tab-ratified")).toBeInTheDocument();
    expect(screen.getByTestId("reviews-tab-rejected")).toBeInTheDocument();
  });

  it("renders pending row with vote progress", async () => {
    render(
      <MemoryRouter>
        <ReviewsRoute />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("reviews-row-team/decisions/abc.md"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/Pricing change/)).toBeInTheDocument();
    expect(screen.getByText(/0 of 2 voted/)).toBeInTheDocument();
  });
});
// === end wave 1.13-B ===
