import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { IntentViewer } from "../../src/pages/meetings/components/IntentViewer";

describe("IntentViewer", () => {
  it("shows empty hint when no intents", () => {
    render(<IntentViewer intents={[]} />);
    expect(screen.getByText(/Run prep/i)).toBeInTheDocument();
  });

  it("renders one card per intent with status pill", () => {
    render(
      <IntentViewer
        intents={[
          { alias: "daizhe", ready: true, markdown: "# Intent — daizhe" },
          { alias: "hongyu", ready: false },
        ]}
      />
    );
    expect(screen.getByTestId("intent-card-daizhe")).toBeInTheDocument();
    expect(screen.getByTestId("intent-card-hongyu")).toBeInTheDocument();
    expect(screen.getByText("locked")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
  });

  it("renders markdown body verbatim", () => {
    render(
      <IntentViewer
        intents={[{ alias: "daizhe", ready: true, markdown: "# Hello\n- bullet" }]}
      />
    );
    const card = screen.getByTestId("intent-card-daizhe");
    expect(card.textContent).toContain("# Hello");
    expect(card.textContent).toContain("- bullet");
  });
});
