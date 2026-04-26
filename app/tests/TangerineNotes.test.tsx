import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TangerineNotes } from "../src/components/TangerineNotes";

describe("TangerineNotes", () => {
  it("renders nothing when notes array is empty (Stage 1 default)", () => {
    const { container } = render(<TangerineNotes notes={[]} route="today" />);
    // Hook 5: Stage 1 always [] but the slot lives in the component file
    // so Stage 2 plug-in is a one-line change. Stage 1 = no DOM emitted.
    expect(container.querySelector("[data-tangerine-notes]")).toBeNull();
  });

  it("renders the notes section header when at least one note", () => {
    render(
      <TangerineNotes
        route="today"
        notes={[
          { id: "n1", text: "thrashing detected on pricing thread" },
        ]}
      />,
    );
    expect(screen.getByText(/Tangerine notes/i)).toBeInTheDocument();
    expect(screen.getByText(/thrashing detected/)).toBeInTheDocument();
  });

  it("renders cta when provided", () => {
    render(
      <TangerineNotes
        route="people:eric"
        notes={[
          {
            id: "n1",
            text: "Eric hasn't ack'd 5 decisions",
            cta: { label: "send brief" },
          },
        ]}
      />,
    );
    expect(screen.getByText("send brief")).toBeInTheDocument();
  });

  it("uses the orange accent border (Hook 5 spec)", () => {
    render(
      <TangerineNotes
        route="today"
        notes={[{ id: "x", text: "hi" }]}
      />,
    );
    const section = screen.getByLabelText("Tangerine notes");
    expect(section.className).toContain("border-l-4");
  });
});
