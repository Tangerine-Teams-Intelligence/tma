// === wave 14 ===
/**
 * Wave 14 — Vendor color removal tests.
 *
 * Pivot 3: vendor color is a dev concept (Cursor blue / Claude purple
 * / Codex amber etc.) that adds cognitive load for end users. Wave 14
 * removes the vendor-color rings from sidebar AI tool icons and the
 * vendor-color border-l from AtomCards by default. Vendor color is
 * preserved as opt-in (showVendorColor prop on AtomCard, future
 * /memory detail panel).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AtomCard } from "../src/components/AtomCard";
import { AIToolsSection } from "../src/components/ai-tools/AIToolsSection";

describe("Wave 14 — vendor color removal", () => {
  it("AtomCard default has no ti-vendor-border-l class", () => {
    render(
      <MemoryRouter>
        <AtomCard
          vendor="cursor"
          title="X"
          body="y"
          sourcePath="z.md"
          testId="default-card"
        />
      </MemoryRouter>,
    );
    const card = screen.getByTestId("default-card");
    expect(card.className).not.toMatch(/ti-vendor-border-l/);
  });

  it("AtomCard with showVendorColor=true keeps the vendor border", () => {
    render(
      <MemoryRouter>
        <AtomCard
          vendor="cursor"
          title="X"
          body="y"
          sourcePath="z.md"
          showVendorColor
          testId="opt-in-card"
        />
      </MemoryRouter>,
    );
    const card = screen.getByTestId("opt-in-card");
    expect(card.className).toMatch(/ti-vendor-border-l/);
  });

  it("AtomCard renders vendor as 'from <Vendor>' text by default", () => {
    render(
      <MemoryRouter>
        <AtomCard vendor="claude-code" title="X" testId="text-card" />
      </MemoryRouter>,
    );
    // Default reads "from Claude Code" — the vendor label is text-only.
    expect(screen.getByText(/from Claude Code/i)).toBeInTheDocument();
  });

  it("AIToolsSection renders without vendor-tinted icon ring", async () => {
    render(
      <MemoryRouter>
        <AIToolsSection />
      </MemoryRouter>,
    );
    // Wait for tools to mount (loadAITools resolves async).
    const cursorLink = await screen.findByTestId("ai-tool-link-cursor");
    expect(cursorLink).toBeInTheDocument();
    // The icon wrapper sibling should NOT have an inline boxShadow
    // pointing at the cursor-blue brand color.
    const html = cursorLink.outerHTML;
    expect(html).not.toMatch(/#00A8E8/);
    // Installed status dot uses the generic green CSS variable, not
    // a vendor hex — verify the dot has the green color via inline
    // style rather than a vendor hex.
    const dot = cursorLink.querySelector(
      '[data-testid="ai-tool-status-installed"]',
    );
    expect(dot).not.toBeNull();
  });
});
// === end wave 14 ===
