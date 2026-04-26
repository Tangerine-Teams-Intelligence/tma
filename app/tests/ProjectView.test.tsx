import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ProjectView } from "../src/components/ProjectView";

describe("ProjectView", () => {
  it("renders slug header + member + atom count", () => {
    render(
      <MemoryRouter>
        <ProjectView
          data={{
            slug: "v1-launch",
            recent_events: [],
            members: ["daizhe", "eric"],
            threads: ["pr-47"],
            notes: [],
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("v1-launch")).toBeInTheDocument();
    expect(screen.getByText(/0 events · 2 members/i)).toBeInTheDocument();
  });

  it("renders members with @ prefix in chip", () => {
    render(
      <MemoryRouter>
        <ProjectView
          data={{
            slug: "rms",
            recent_events: [],
            members: ["sarah"],
            threads: [],
            notes: [],
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("@sarah")).toBeInTheDocument();
  });

  it("renders thread chips", () => {
    render(
      <MemoryRouter>
        <ProjectView
          data={{
            slug: "rms",
            recent_events: [],
            members: [],
            threads: ["topic-1", "topic-2"],
            notes: [],
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("topic-1")).toBeInTheDocument();
    expect(screen.getByText("topic-2")).toBeInTheDocument();
  });

  it("shows empty hint when no recent events", () => {
    render(
      <MemoryRouter>
        <ProjectView
          data={{
            slug: "rms",
            recent_events: [],
            members: [],
            threads: [],
            notes: [],
          }}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByText(/No atoms reference this project/i),
    ).toBeInTheDocument();
  });
});
