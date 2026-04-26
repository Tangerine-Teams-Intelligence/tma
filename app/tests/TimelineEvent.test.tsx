import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TimelineEvent } from "../src/components/TimelineEvent";
import type { TimelineEvent as Ev } from "../src/lib/views";

function ev(over: Partial<Ev> = {}): Ev {
  return {
    id: "evt-2026-04-25-aaaaaaaaaa",
    ts: "2026-04-25T09:30:15Z",
    source: "github",
    actor: "eric",
    actors: ["eric"],
    kind: "pr_event",
    refs: { projects: ["v1-launch"], threads: ["pr-47"] },
    status: "active",
    file: "timeline/2026-04-25.md",
    line: 1,
    body: "merged PR #47 — postgres-migration",
    sample: false,
    confidence: 1,
    concepts: [],
    alternatives: [],
    source_count: 1,
    ...over,
  };
}

function renderWith(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("TimelineEvent", () => {
  it("renders headline + actor", () => {
    renderWith(<TimelineEvent event={ev()} />);
    expect(screen.getByText("@eric")).toBeInTheDocument();
    expect(screen.getByText(/merged PR #47/)).toBeInTheDocument();
  });

  it("shows time as HH:MM", () => {
    renderWith(<TimelineEvent event={ev({ ts: "2026-04-25T14:32:11Z" })} />);
    expect(screen.getByText("14:32")).toBeInTheDocument();
  });

  it("falls back to kind when body empty", () => {
    renderWith(<TimelineEvent event={ev({ body: "", kind: "pr_event" })} />);
    expect(screen.getByText("pr_event")).toBeInTheDocument();
  });

  it("hides confidence badge at 1.0 (Stage 1 default)", () => {
    renderWith(<TimelineEvent event={ev({ confidence: 1.0 })} />);
    expect(screen.queryByTitle(/AI confidence/i)).toBeNull();
  });

  it("shows confidence badge below 1.0 (Stage 2 hook)", () => {
    renderWith(<TimelineEvent event={ev({ confidence: 0.7 })} />);
    expect(screen.getByTitle(/AI confidence/i)).toBeInTheDocument();
    expect(screen.getByText("70%")).toBeInTheDocument();
  });

  it("calls onView when clicked", () => {
    const onView = vi.fn();
    renderWith(<TimelineEvent event={ev()} onView={onView} />);
    fireEvent.click(screen.getByRole("link"));
    expect(onView).toHaveBeenCalledWith("evt-2026-04-25-aaaaaaaaaa");
  });

  it("renders refs as chips in non-compact mode", () => {
    renderWith(<TimelineEvent event={ev()} />);
    expect(screen.getByText(/project:v1-launch/)).toBeInTheDocument();
    expect(screen.getByText(/thread:pr-47/)).toBeInTheDocument();
  });

  it("hides refs in compact mode", () => {
    renderWith(<TimelineEvent event={ev()} compact />);
    expect(screen.queryByText(/project:v1-launch/)).toBeNull();
  });

  it("renders as a button (not link) when file is missing", () => {
    const onView = vi.fn();
    renderWith(
      <TimelineEvent event={ev({ file: undefined })} onView={onView} />,
    );
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    expect(onView).toHaveBeenCalled();
  });
});
