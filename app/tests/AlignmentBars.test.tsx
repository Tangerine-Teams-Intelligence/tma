import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AlignmentBars } from "../src/components/AlignmentBars";

describe("AlignmentBars", () => {
  it("shows empty hint when no users tracked", () => {
    render(
      <AlignmentBars
        snapshot={{
          computed_at: null,
          users: [],
          total_atoms: 0,
          shared_viewed: 0,
          rate: 0,
          per_user_seen: {},
        }}
      />,
    );
    expect(screen.getByText(/No member coverage yet/i)).toBeInTheDocument();
  });

  it("shows empty hint when total_atoms is 0", () => {
    render(
      <AlignmentBars
        snapshot={{
          computed_at: "2026-04-25T08:00:00Z",
          users: ["daizhe", "eric"],
          total_atoms: 0,
          shared_viewed: 0,
          rate: 0,
          per_user_seen: { daizhe: 0, eric: 0 },
        }}
      />,
    );
    expect(screen.getByText(/No member coverage yet/i)).toBeInTheDocument();
  });

  it("renders one bar per user with pct", () => {
    render(
      <AlignmentBars
        snapshot={{
          computed_at: "2026-04-25T08:00:00Z",
          users: ["daizhe", "eric"],
          total_atoms: 100,
          shared_viewed: 80,
          rate: 0.8,
          per_user_seen: { daizhe: 90, eric: 80 },
        }}
      />,
    );
    expect(screen.getByText("@daizhe")).toBeInTheDocument();
    expect(screen.getByText("@eric")).toBeInTheDocument();
    expect(screen.getByText("90 / 100 (90%)")).toBeInTheDocument();
    expect(screen.getByText("80 / 100 (80%)")).toBeInTheDocument();
  });

  it("sorts bars by pct descending", () => {
    const { container } = render(
      <AlignmentBars
        snapshot={{
          computed_at: "2026-04-25T08:00:00Z",
          users: ["a_low", "b_high"],
          total_atoms: 100,
          shared_viewed: 50,
          rate: 0.5,
          per_user_seen: { a_low: 30, b_high: 90 },
        }}
      />,
    );
    const bars = container.querySelectorAll("[data-alignment-bar]");
    expect(bars).toHaveLength(2);
    // First should be the higher pct (b_high → 90%)
    expect(bars[0].textContent).toContain("@b_high");
    expect(bars[1].textContent).toContain("@a_low");
  });

  it("emits a progressbar role with aria-valuenow", () => {
    render(
      <AlignmentBars
        snapshot={{
          computed_at: "2026-04-25T08:00:00Z",
          users: ["d"],
          total_atoms: 50,
          shared_viewed: 25,
          rate: 0.5,
          per_user_seen: { d: 25 },
        }}
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });
});
