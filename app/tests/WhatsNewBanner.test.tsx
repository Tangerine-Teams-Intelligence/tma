import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { WhatsNewBanner } from "../src/components/WhatsNewBanner";
import { useStore } from "../src/lib/store";
import * as views from "../src/lib/views";

beforeEach(() => {
  // Fresh dismissal state per test.
  useStore.setState((s) => ({ ui: { ...s.ui, whatsNewDismissed: false } }));
});

describe("WhatsNewBanner", () => {
  it("does not render when count is 0", async () => {
    vi.spyOn(views, "readWhatsNew").mockResolvedValueOnce({
      since: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
      new_events: [],
      count: 0,
      notes: [],
    });
    const { container } = render(
      <MemoryRouter>
        <WhatsNewBanner />
      </MemoryRouter>,
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(container.querySelector("[data-whats-new-banner]")).toBeNull();
  });

  it("does not render when last_opened_at is fresh (< 1h)", async () => {
    vi.spyOn(views, "readWhatsNew").mockResolvedValueOnce({
      since: new Date(Date.now() - 5 * 60_000).toISOString(),
      new_events: [],
      count: 5,
      notes: [],
    });
    const { container } = render(
      <MemoryRouter>
        <WhatsNewBanner />
      </MemoryRouter>,
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(container.querySelector("[data-whats-new-banner]")).toBeNull();
  });

  it("renders banner with count when stale + has new", async () => {
    vi.spyOn(views, "readWhatsNew").mockResolvedValueOnce({
      since: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
      new_events: [],
      count: 7,
      notes: [],
    });
    render(
      <MemoryRouter>
        <WhatsNewBanner />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("7")).toBeInTheDocument());
    expect(screen.getByText(/new atoms since you last looked/i)).toBeInTheDocument();
  });

  it("renders for never-opened cursor when there are new atoms", async () => {
    vi.spyOn(views, "readWhatsNew").mockResolvedValueOnce({
      since: null,
      new_events: [],
      count: 3,
      notes: [],
    });
    render(
      <MemoryRouter>
        <WhatsNewBanner />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("3")).toBeInTheDocument());
  });

  it("dismisses on X button click", async () => {
    vi.spyOn(views, "readWhatsNew").mockResolvedValueOnce({
      since: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
      new_events: [],
      count: 2,
      notes: [],
    });
    vi.spyOn(views, "markUserOpened").mockResolvedValueOnce({
      user: "me",
      last_opened_at: new Date().toISOString(),
      atoms_viewed_count: 0,
      atoms_acked_count: 0,
    });
    const { container } = render(
      <MemoryRouter>
        <WhatsNewBanner />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("2")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(useStore.getState().ui.whatsNewDismissed).toBe(true);
    await waitFor(() =>
      expect(container.querySelector("[data-whats-new-banner]")).toBeNull(),
    );
  });
});
