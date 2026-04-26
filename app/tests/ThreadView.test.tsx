import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThreadView } from "../src/components/ThreadView";
import type { TimelineEvent } from "../src/lib/views";

function ev(over: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "evt-2026-04-26-aaaaaaaaaa",
    ts: "2026-04-26T10:00:00Z",
    source: "discord",
    actor: "eric",
    actors: ["eric"],
    kind: "comment",
    refs: { threads: ["pr-47"] },
    status: "active",
    file: "timeline/2026-04-26.md",
    line: 1,
    body: "ship it",
    sample: false,
    confidence: 1,
    concepts: [],
    alternatives: [],
    source_count: 1,
    ...over,
  };
}

describe("ThreadView", () => {
  it("renders #topic header + members + atom count", () => {
    render(
      <MemoryRouter>
        <ThreadView
          data={{
            topic: "pricing",
            events: [ev()],
            members: ["eric"],
            notes: [],
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("#pricing")).toBeInTheDocument();
    expect(screen.getByText(/1 atoms/i)).toBeInTheDocument();
  });

  it("renders empty hint when no events", () => {
    render(
      <MemoryRouter>
        <ThreadView
          data={{
            topic: "ghost",
            events: [],
            members: [],
            notes: [],
          }}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByText(/No atoms reference this thread/i),
    ).toBeInTheDocument();
  });

  it("renders chronological list", () => {
    const a = ev({ id: "evt-2026-04-26-aaaaaaaaaa", body: "first" });
    const b = ev({ id: "evt-2026-04-26-bbbbbbbbbb", body: "second" });
    render(
      <MemoryRouter>
        <ThreadView
          data={{
            topic: "x",
            events: [a, b],
            members: [],
            notes: [],
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
  });
});
