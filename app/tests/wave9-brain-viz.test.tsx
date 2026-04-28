// === wave 9 ===
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BrainVizHero, BrainVizEmpty } from "../src/components/BrainVizHero";

describe("Wave 9 — BrainVizHero", () => {
  it("renders an alive orb with atom count and active particles", () => {
    render(
      <BrainVizHero
        state="alive"
        activeVendors={["cursor", "claude-code"]}
        atomsToday={42}
      />,
    );
    const orb = screen.getByTestId("brain-orb");
    expect(orb.getAttribute("data-state")).toBe("alive");
    expect(orb.textContent).toBe("42");
    expect(screen.getByTestId("brain-particle-cursor").getAttribute("data-active")).toBe(
      "true",
    );
    expect(
      screen.getByTestId("brain-particle-claude-code").getAttribute("data-active"),
    ).toBe("true");
    // Codex isn't in activeVendors so its particle is static.
    expect(screen.getByTestId("brain-particle-codex").getAttribute("data-active")).toBe(
      "false",
    );
  });

  it("idle state renders the orb but no green halo (data-state=idle)", () => {
    render(<BrainVizHero state="idle" activeVendors={[]} atomsToday={5} />);
    expect(screen.getByTestId("brain-orb").getAttribute("data-state")).toBe("idle");
  });

  it("BrainVizEmpty renders 8 placeholder particles + grey orb", () => {
    render(<BrainVizEmpty />);
    const root = screen.getByTestId("brain-viz-empty");
    expect(root).toBeInTheDocument();
  });
});
// === end wave 9 ===
