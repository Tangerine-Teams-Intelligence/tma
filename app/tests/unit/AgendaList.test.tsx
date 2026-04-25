import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AgendaList } from "../../src/pages/meetings/components/AgendaList";

describe("AgendaList", () => {
  it("renders empty hint when no items", () => {
    render(<AgendaList items={[]} />);
    expect(
      screen.getByText(/No locked intents/i)
    ).toBeInTheDocument();
  });

  it("renders one section per alias with topic items", () => {
    render(
      <AgendaList
        items={[
          { alias: "daizhe", topics: ["v1 scope", "GTM"] },
          { alias: "hongyu", topics: [] },
        ]}
      />
    );
    expect(screen.getByText("daizhe")).toBeInTheDocument();
    expect(screen.getByText("v1 scope")).toBeInTheDocument();
    expect(screen.getByText("GTM")).toBeInTheDocument();
    expect(screen.getByText("(no topics)")).toBeInTheDocument();
  });
});
