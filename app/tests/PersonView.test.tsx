import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PersonView } from "../src/components/PersonView";
import type { TimelineEvent } from "../src/lib/views";

function ev(over: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "evt-2026-04-26-aaaaaaaaaa",
    ts: "2026-04-26T10:00:00Z",
    source: "discord",
    actor: "eric",
    actors: ["eric"],
    kind: "meeting_chunk",
    refs: {},
    status: "active",
    file: "timeline/2026-04-26.md",
    line: 1,
    body: "thoughts on pricing",
    sample: false,
    confidence: 1,
    concepts: [],
    alternatives: [],
    source_count: 1,
    ...over,
  };
}

describe("PersonView", () => {
  it("renders alias header and event count", () => {
    render(
      <MemoryRouter>
        <PersonView
          data={{
            alias: "eric",
            recent_events: [ev(), ev({ id: "evt-2026-04-26-bbbbbbbbbb" })],
            mentioned_projects: [],
            mentioned_threads: [],
            notes: [],
          }}
        />
      </MemoryRouter>,
    );
    // Heading is the canonical alias surface — ev rows also render @eric.
    expect(
      screen.getByRole("heading", { level: 1, name: /@eric/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 events captured/i)).toBeInTheDocument();
  });

  it("renders empty hint when no recent events", () => {
    render(
      <MemoryRouter>
        <PersonView
          data={{
            alias: "ghost",
            recent_events: [],
            mentioned_projects: [],
            mentioned_threads: [],
            notes: [],
          }}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByText(/No captured atoms in the last 30 days/i),
    ).toBeInTheDocument();
  });

  it("renders project + thread chips", () => {
    render(
      <MemoryRouter>
        <PersonView
          data={{
            alias: "eric",
            recent_events: [],
            mentioned_projects: ["v1-launch", "rms"],
            mentioned_threads: ["pr-47"],
            notes: [],
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("v1-launch")).toBeInTheDocument();
    expect(screen.getByText("rms")).toBeInTheDocument();
    expect(screen.getByText("pr-47")).toBeInTheDocument();
  });

  it("disables Brief them in Stage 1", () => {
    render(
      <MemoryRouter>
        <PersonView
          data={{
            alias: "eric",
            recent_events: [],
            mentioned_projects: [],
            mentioned_threads: [],
            notes: [],
          }}
        />
      </MemoryRouter>,
    );
    const btn = screen.getByRole("button", { name: /brief them/i });
    expect(btn).toBeDisabled();
  });
});
