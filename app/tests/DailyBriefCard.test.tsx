import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DailyBriefCard } from "../src/components/DailyBriefCard";

describe("DailyBriefCard", () => {
  it("renders empty hint when brief doesn't exist", () => {
    render(<DailyBriefCard date="2026-04-26" markdown={null} exists={false} />);
    expect(screen.getByText(/Tangerine writes today/i)).toBeInTheDocument();
  });

  it("renders the markdown body when present", () => {
    render(
      <DailyBriefCard
        date="2026-04-26"
        exists
        markdown={"# Brief\n\nFirst sentence."}
      />,
    );
    expect(screen.getByText("Brief")).toBeInTheDocument();
    expect(screen.getByText("First sentence.")).toBeInTheDocument();
  });

  it("calls onMarkRead and shows ack pill", () => {
    const onMarkRead = vi.fn();
    const { rerender } = render(
      <DailyBriefCard
        date="2026-04-26"
        exists
        markdown={"# Brief"}
        onMarkRead={onMarkRead}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /mark read/i }));
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    rerender(
      <DailyBriefCard
        date="2026-04-26"
        exists
        markdown={"# Brief"}
        acked
        onMarkRead={onMarkRead}
      />,
    );
    expect(screen.getByText(/read/i)).toBeInTheDocument();
  });

  it("collapses + re-expands on header click", () => {
    render(
      <DailyBriefCard
        date="2026-04-26"
        exists
        markdown={"# Brief\n\nVisible body line."}
      />,
    );
    expect(screen.getByText("Visible body line.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /collapse daily brief/i }));
    expect(screen.queryByText("Visible body line.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /expand daily brief/i }));
    expect(screen.getByText("Visible body line.")).toBeInTheDocument();
  });

  it("shows the date in the header", () => {
    render(
      <DailyBriefCard date="2026-04-26" exists markdown={"# x"} />,
    );
    expect(screen.getByText(/2026-04-26/)).toBeInTheDocument();
  });
});
