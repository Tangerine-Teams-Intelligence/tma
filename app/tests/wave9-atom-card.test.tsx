// === wave 9 ===
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AtomCard } from "../src/components/AtomCard";

describe("Wave 9 — AtomCard", () => {
  it("renders title, body preview, vendor label, and source path", () => {
    render(
      <MemoryRouter>
        <AtomCard
          vendor="cursor"
          title="Pricing tier-2 decision"
          body="The team agreed on flat-rate after debating per-seat for 30 minutes."
          sourcePath="team/decisions/pricing-tier-2.md"
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Pricing tier-2 decision")).toBeInTheDocument();
    expect(screen.getByText(/Cursor/)).toBeInTheDocument();
    expect(screen.getByText(/team\/decisions\/pricing-tier-2\.md/)).toBeInTheDocument();
    expect(screen.getByText(/flat-rate/)).toBeInTheDocument();
  });

  it("links to the supplied path", () => {
    render(
      <MemoryRouter>
        <AtomCard
          vendor="claude-code"
          title="Some atom"
          linkTo="/memory/decisions/foo.md"
          testId="link-card"
        />
      </MemoryRouter>,
    );
    const card = screen.getByTestId("link-card");
    expect(card.tagName).toBe("A");
    expect(card.getAttribute("href")).toBe("/memory/decisions/foo.md");
    expect(card.getAttribute("data-vendor")).toBe("claude-code");
  });

  it("falls back to default vendor for unknown ids", () => {
    render(
      <MemoryRouter>
        <AtomCard vendor="totally-bogus" title="x" testId="fallback-card" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("fallback-card").getAttribute("data-vendor")).toBe(
      "default",
    );
  });

  it("compact variant hides body and source path", () => {
    render(
      <MemoryRouter>
        <AtomCard
          vendor="cursor"
          title="Tight"
          body="should not appear"
          sourcePath="should-not-show.md"
          compact
          testId="compact-card"
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Tight")).toBeInTheDocument();
    expect(screen.queryByText(/should not appear/)).not.toBeInTheDocument();
    expect(screen.queryByText(/should-not-show/)).not.toBeInTheDocument();
  });

  it("normalizes 'Claude Code' / underscore variants for data-vendor", () => {
    render(
      <MemoryRouter>
        <AtomCard vendor="Claude Code" title="x" testId="normalized-card" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("normalized-card").getAttribute("data-vendor")).toBe(
      "claude-code",
    );
  });
});
// === end wave 9 ===
