import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import TodayRoute from "../src/routes/today";
import ThisWeekRoute from "../src/routes/this-week";
import PeopleListRoute from "../src/routes/people";
import PersonDetailRoute from "../src/routes/people/detail";
import ProjectsListRoute from "../src/routes/projects";
import ProjectDetailRoute from "../src/routes/projects/detail";
import ThreadsListRoute from "../src/routes/threads";
import ThreadDetailRoute from "../src/routes/threads/detail";
import AlignmentRoute from "../src/routes/alignment";
import InboxRoute from "../src/routes/inbox";
// === v1.16 Wave 1 === — CanvasRoute / CoThinkerRoute imports砍.

import * as views from "../src/lib/views";

function renderRoute(path: string, element: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={path} element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Stage 1 Wave 3 routes — smoke", () => {
  it("/today renders without crash", async () => {
    renderRoute("/today", <TodayRoute />);
    expect(await screen.findByText(/^Today$/i)).toBeInTheDocument();
  });

  it("/this-week renders without crash", async () => {
    renderRoute("/this-week", <ThisWeekRoute />);
    expect(await screen.findByText(/Last 7 days/i)).toBeInTheDocument();
  });

  it("/people index renders without crash", async () => {
    renderRoute("/people", <PeopleListRoute />);
    // v1.16 Wave 2 — /people rewritten to v1.16 spec; header now shows
    // "People · N active in last 24h" via testid view-tabs (active route
    // landmark). Smoke test just needs the route to mount cleanly.
    expect(await screen.findByTestId("view-tabs")).toBeInTheDocument();
  });

  it("/people/:alias renders person detail", async () => {
    vi.spyOn(views, "readPerson").mockResolvedValueOnce({
      alias: "eric",
      recent_events: [],
      mentioned_projects: ["v1-launch"],
      mentioned_threads: [],
      notes: [],
    });
    render(
      <MemoryRouter initialEntries={["/people/eric"]}>
        <Routes>
          <Route path="/people/:alias" element={<PersonDetailRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("@eric")).toBeInTheDocument());
  });

  it("/projects index renders without crash", async () => {
    renderRoute("/projects", <ProjectsListRoute />);
    expect(await screen.findByText(/Active projects/i)).toBeInTheDocument();
  });

  it("/projects/:slug renders project detail", async () => {
    vi.spyOn(views, "readProject").mockResolvedValueOnce({
      slug: "v1-launch",
      recent_events: [],
      members: [],
      threads: [],
      notes: [],
    });
    render(
      <MemoryRouter initialEntries={["/projects/v1-launch"]}>
        <Routes>
          <Route path="/projects/:slug" element={<ProjectDetailRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText("v1-launch")).toBeInTheDocument(),
    );
  });

  it("/threads index renders without crash", async () => {
    renderRoute("/threads", <ThreadsListRoute />);
    // v1.16 Wave 2 — /threads rewritten to mention-set grouping; smoke
    // test just needs the route to mount cleanly via view-tabs landmark.
    expect(await screen.findByTestId("view-tabs")).toBeInTheDocument();
  });

  it("/threads/:topic renders thread detail", async () => {
    vi.spyOn(views, "readThread").mockResolvedValueOnce({
      topic: "pr-47",
      events: [],
      members: [],
      notes: [],
    });
    render(
      <MemoryRouter initialEntries={["/threads/pr-47"]}>
        <Routes>
          <Route path="/threads/:topic" element={<ThreadDetailRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("#pr-47")).toBeInTheDocument());
  });

  it("/alignment renders the hero metric", async () => {
    renderRoute("/alignment", <AlignmentRoute />);
    // Heading anchor — there's also a body sentence containing the phrase.
    expect(
      await screen.findByRole("heading", { level: 1, name: /Same-screen rate/i }),
    ).toBeInTheDocument();
  });

  // === wave 1.13-A === — /inbox is the collab inbox now (Mentions /
  // Review requests / Comment replies). Asserts on the new shape.
  it("/inbox renders the collab inbox header + empty state by default", async () => {
    renderRoute("/inbox", <InboxRoute />);
    expect(await screen.findByText(/Activity for you/i)).toBeInTheDocument();
    expect(
      await screen.findByTestId("inbox-tab-mention"),
    ).toBeInTheDocument();
  });
  // === end wave 1.13-A ===

  // === v1.16 Wave 1 === — /canvas + /co-thinker smoke tests砍 (routes deleted).
});
