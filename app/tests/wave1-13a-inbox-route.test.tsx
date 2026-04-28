// === wave 1.13-A ===
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import InboxRoute from "../src/routes/inbox";
import type { InboxEvent } from "../src/lib/identity";

// Mock the Tauri invoke surface so the lib/identity wrappers (which call
// `safeInvoke` → `invoke`) hit our test handlers instead of the no-op
// browser fallback. We flip the `__TAURI_INTERNALS__` flag so `inTauri()`
// returns true, then route every command through a single dispatcher.
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

let testEvents: InboxEvent[] = [];
let markReadIds: string[] = [];
let archiveIds: string[] = [];
let markAllReadCalls = 0;

beforeEach(() => {
  // Pretend we're inside Tauri so `inTauri()` returns true.
  (
    window as unknown as Record<string, unknown>
  ).__TAURI_INTERNALS__ = { v: 1 };
  testEvents = [];
  markReadIds = [];
  archiveIds = [];
  markAllReadCalls = 0;
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "inbox_list") return testEvents;
    if (cmd === "inbox_mark_read") {
      const id = (args as { args: { eventId: string } }).args.eventId;
      markReadIds.push(id);
      return undefined;
    }
    if (cmd === "inbox_archive") {
      const id = (args as { args: { eventId: string } }).args.eventId;
      archiveIds.push(id);
      return undefined;
    }
    if (cmd === "inbox_mark_all_read") {
      markAllReadCalls += 1;
      return 0;
    }
    return undefined;
  });
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

function makeEvent(
  kind: string,
  source: string,
  overrides: Partial<InboxEvent> = {},
): InboxEvent {
  return {
    id: `${kind}-${source}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    targetUser: "you",
    sourceUser: source,
    sourceAtom: "team/decisions/x.md",
    timestamp: new Date().toISOString(),
    payload: { snippet: `${source} says hi` },
    read: false,
    archived: false,
    ...overrides,
  };
}

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={["/inbox"]}>
      <InboxRoute />
    </MemoryRouter>,
  );
}

describe("InboxRoute (wave 1.13-A)", () => {
  it("renders the three tabs", async () => {
    renderRoute();
    await waitFor(() => {
      expect(screen.getByTestId("inbox-tabs")).toBeInTheDocument();
    });
    expect(screen.getByTestId("inbox-tab-mention")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-tab-review_request")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-tab-comment_reply")).toBeInTheDocument();
  });

  it("shows an empty state when no events match the active tab", async () => {
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("inbox-empty")).toBeInTheDocument(),
    );
  });

  it("renders mention events on the Mentions tab", async () => {
    testEvents = [
      makeEvent("mention", "alice"),
      makeEvent("review_request", "bob"),
    ];
    renderRoute();
    await waitFor(() => {
      const cards = screen.queryAllByTestId("inbox-event");
      expect(cards.length).toBe(1);
      expect(cards[0].dataset.eventKind).toBe("mention");
    });
  });

  it("switches to review requests tab and shows badge counts", async () => {
    testEvents = [
      makeEvent("review_request", "carol"),
      makeEvent("review_request", "dave"),
    ];
    renderRoute();
    await waitFor(() =>
      expect(
        screen.getByTestId("inbox-tab-review_request-badge"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("inbox-tab-review_request-badge"),
    ).toHaveTextContent("2");
    fireEvent.click(screen.getByTestId("inbox-tab-review_request"));
    await waitFor(() => {
      const cards = screen.queryAllByTestId("inbox-event");
      expect(cards.length).toBe(2);
      expect(cards[0].dataset.eventKind).toBe("review_request");
    });
  });

  it("Mark read calls the API", async () => {
    const e = makeEvent("mention", "alice");
    testEvents = [e];
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("inbox-event-mark-read")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("inbox-event-mark-read"));
    await waitFor(() => {
      expect(markReadIds).toContain(e.id);
    });
  });

  it("Archive calls inbox_archive", async () => {
    const e = makeEvent("mention", "alice");
    testEvents = [e];
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("inbox-event-archive")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("inbox-event-archive"));
    await waitFor(() => {
      expect(archiveIds).toContain(e.id);
    });
  });

  it("Mark all read calls inbox_mark_all_read", async () => {
    testEvents = [
      makeEvent("mention", "alice"),
      makeEvent("mention", "bob"),
    ];
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("inbox-mark-all-read")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("inbox-mark-all-read"));
    await waitFor(() => {
      expect(markAllReadCalls).toBeGreaterThan(0);
    });
  });
});
// === end wave 1.13-A ===
