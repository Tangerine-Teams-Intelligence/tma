import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import {
  topicToMarkdown,
  topicFromMarkdown,
  newSticky,
  newComment,
  type CanvasTopic,
} from "../src/lib/canvas";
import { CanvasView } from "../src/components/canvas/CanvasView";
import CanvasRoute from "../src/routes/canvas";
import * as tauri from "../src/lib/tauri";

// ============================================================
// 1. Markdown round-trip
// ============================================================

describe("canvas markdown round-trip", () => {
  it("preserves stickies + position + color + author + comments", () => {
    const t: CanvasTopic = {
      project: "tangerine-teams-app",
      topic: "v1-8-ideation",
      title: "v1.8 ideation",
      created_at: "2026-04-26T15:00:00.000Z",
      stickies: [
        {
          id: "abc123",
          x: 120,
          y: 80,
          color: "yellow",
          author: "daizhe",
          is_agi: false,
          created_at: "2026-04-26T15:00:00.000Z",
          body: "First idea: AGI as peer, not chatbot.",
          comments: [
            {
              id: "c-1",
              author: "claude",
              is_agi: true,
              created_at: "2026-04-26T15:01:00.000Z",
              body: "+1, this matches the founding paper.",
            },
            {
              id: "c-2",
              author: "sarah",
              is_agi: false,
              created_at: "2026-04-26T15:03:00.000Z",
              body: "Should we ship Phase 4 first?",
            },
          ],
        },
        {
          id: "def456",
          x: 400,
          y: 220,
          color: "orange",
          author: "tangerine",
          is_agi: true,
          created_at: "2026-04-26T15:05:00.000Z",
          body: "AGI sticky example.",
          comments: [],
        },
      ],
    };

    const md = topicToMarkdown(t);
    const round = topicFromMarkdown(md, t.project, t.topic);

    expect(round.project).toBe(t.project);
    expect(round.topic).toBe(t.topic);
    expect(round.title).toBe(t.title);
    expect(round.created_at).toBe(t.created_at);
    expect(round.stickies).toHaveLength(2);
    expect(round.stickies[0]).toMatchObject({
      id: "abc123",
      x: 120,
      y: 80,
      color: "yellow",
      author: "daizhe",
      is_agi: false,
      body: "First idea: AGI as peer, not chatbot.",
    });
    expect(round.stickies[0].comments).toHaveLength(2);
    expect(round.stickies[0].comments[0]).toMatchObject({
      author: "claude",
      is_agi: true,
      body: "+1, this matches the founding paper.",
    });
    expect(round.stickies[1]).toMatchObject({
      id: "def456",
      color: "orange",
      author: "tangerine",
      is_agi: true,
    });
  });

  it("handles empty topic", () => {
    const t: CanvasTopic = {
      project: "p",
      topic: "t",
      title: "t",
      created_at: "2026-04-26T00:00:00.000Z",
      stickies: [],
    };
    const md = topicToMarkdown(t);
    const round = topicFromMarkdown(md, "p", "t");
    expect(round.stickies).toEqual([]);
  });

  it("recovers sticky body from corrupted meta", () => {
    // No frontmatter, broken meta JSON — body should still survive.
    const md = `## sticky-x
<!-- canvas-meta: {NOT JSON} -->

Hello world.
`;
    const round = topicFromMarkdown(md, "p", "t");
    expect(round.stickies).toHaveLength(1);
    expect(round.stickies[0].body).toContain("Hello world");
    // Defaults for x / y / color when meta couldn't parse.
    expect(round.stickies[0].x).toBe(0);
    expect(round.stickies[0].y).toBe(0);
    expect(round.stickies[0].color).toBe("yellow");
  });
});

// ============================================================
// 2. Sticky drag updates x/y
// ============================================================

describe("sticky position drag updates x/y", () => {
  beforeEach(() => {
    vi.spyOn(tauri, "canvasListTopics").mockResolvedValue(["topic1"]);
    vi.spyOn(tauri, "canvasLoadTopic").mockImplementation(async () => {
      const t: CanvasTopic = {
        project: "p",
        topic: "topic1",
        title: "Topic 1",
        created_at: "2026-04-26T00:00:00.000Z",
        stickies: [
          {
            id: "s1",
            x: 10,
            y: 20,
            color: "yellow",
            author: "daizhe",
            is_agi: false,
            created_at: "2026-04-26T00:00:00.000Z",
            body: "drag me",
            comments: [],
          },
        ],
      };
      return topicToMarkdown(t);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates x/y when the header is dragged", async () => {
    const saveSpy = vi.spyOn(tauri, "canvasSaveTopic").mockResolvedValue();

    render(<CanvasView project="p" />);

    const drag = await screen.findByTestId("sticky-s1-drag-handle");

    // Drag from (100, 100) → (160, 130) in screen coords. With scale=1
    // that maps 1:1 to canvas coords, so x/y should jump to 70 / 50.
    fireEvent.mouseDown(drag, { button: 0, clientX: 100, clientY: 100 });
    await act(async () => {
      window.dispatchEvent(
        new MouseEvent("mousemove", { clientX: 160, clientY: 130 }),
      );
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseup"));
    });

    // Wait for the debounced save.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 320));
    });

    // The save should have fired with markdown that includes the new x/y.
    expect(saveSpy).toHaveBeenCalled();
    const lastCall = saveSpy.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const writtenMd = lastCall![2] as string;
    const round = topicFromMarkdown(writtenMd, "p", "topic1");
    expect(round.stickies[0].x).toBe(70);
    expect(round.stickies[0].y).toBe(50);
  });
});

// ============================================================
// 3. Comment append writes back to file
// ============================================================

describe("comment append persists via canvasSaveTopic", () => {
  beforeEach(() => {
    vi.spyOn(tauri, "canvasListTopics").mockResolvedValue(["t1"]);
    vi.spyOn(tauri, "canvasLoadTopic").mockImplementation(async () => {
      const t: CanvasTopic = {
        project: "p",
        topic: "t1",
        title: "T1",
        created_at: "2026-04-26T00:00:00.000Z",
        stickies: [
          {
            id: "s1",
            x: 0,
            y: 0,
            color: "blue",
            author: "daizhe",
            is_agi: false,
            created_at: "2026-04-26T00:00:00.000Z",
            body: "thread starter",
            comments: [],
          },
        ],
      };
      return topicToMarkdown(t);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("save fires with the appended comment", async () => {
    const saveSpy = vi.spyOn(tauri, "canvasSaveTopic").mockResolvedValue();

    render(<CanvasView project="p" />);

    // Wait for the sticky to render.
    await screen.findByTestId("sticky-s1");

    const replyInput = screen.getByPlaceholderText("Reply…") as HTMLTextAreaElement;
    fireEvent.change(replyInput, { target: { value: "Looks good" } });
    fireEvent.click(screen.getByRole("button", { name: /Post reply/i }));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 320));
    });

    expect(saveSpy).toHaveBeenCalled();
    const writtenMd = saveSpy.mock.calls.at(-1)![2] as string;
    const round = topicFromMarkdown(writtenMd, "p", "t1");
    expect(round.stickies[0].comments).toHaveLength(1);
    expect(round.stickies[0].comments[0].body).toBe("Looks good");
    expect(round.stickies[0].comments[0].is_agi).toBe(false);
  });
});

// ============================================================
// 4. Empty state shows on no topics
// ============================================================

describe("empty state on no topics", () => {
  beforeEach(() => {
    vi.spyOn(tauri, "canvasListTopics").mockResolvedValue([]);
    vi.spyOn(tauri, "canvasListProjects").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("/canvas/:project shows the canvas-empty empty state", async () => {
    render(
      <MemoryRouter initialEntries={["/canvas/myproject"]}>
        <Routes>
          <Route path="/canvas/:project" element={<CanvasRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("canvas-empty")).toBeInTheDocument();
    expect(await screen.findByText(/No canvas topics yet/i)).toBeInTheDocument();
  });

  it("/canvas index shows canvas-index-empty when no projects", async () => {
    render(
      <MemoryRouter initialEntries={["/canvas"]}>
        <Routes>
          <Route path="/canvas" element={<CanvasRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("canvas-index-empty")).toBeInTheDocument();
  });
});

// ============================================================
// 5. Helper sanity
// ============================================================

describe("canvas helpers", () => {
  it("newSticky uses orange for AGI defaults", () => {
    const s = newSticky({ author: "tangerine", is_agi: true });
    expect(s.color).toBe("orange");
    expect(s.is_agi).toBe(true);
  });

  it("newSticky defaults to yellow for humans", () => {
    const s = newSticky({ author: "daizhe" });
    expect(s.color).toBe("yellow");
    expect(s.is_agi).toBe(false);
  });

  it("newComment marks AGI when requested", () => {
    const c = newComment({ author: "claude", is_agi: true, body: "hi" });
    expect(c.is_agi).toBe(true);
  });
});
