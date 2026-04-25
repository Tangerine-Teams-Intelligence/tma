/**
 * MeetingsList unit test — fixture loads, search filters, click navigates.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import MeetingsList from "../../src/pages/meetings/MeetingsList";

beforeEach(() => {
  // Fresh fixtures per test.
  (window as unknown as { __TMI_MOCK__?: object }).__TMI_MOCK__ = undefined;
});

function renderWith(initialPath = "/meetings") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <MeetingsList />
    </MemoryRouter>
  );
}

describe("MeetingsList", () => {
  it("renders the default fixture meetings", async () => {
    renderWith();
    await waitFor(() =>
      expect(screen.getByTestId("meetings-list")).toBeInTheDocument()
    );
    expect(screen.getByText("David sync")).toBeInTheDocument();
    expect(screen.getByText("Weekly standup")).toBeInTheDocument();
  });

  it("shows empty state when fixture is empty", async () => {
    (window as unknown as { __TMI_MOCK__: object }).__TMI_MOCK__ = {
      meetings: [],
    };
    renderWith();
    await waitFor(() =>
      expect(screen.getByTestId("ml-empty")).toBeInTheDocument()
    );
  });

  it("search query narrows the list", async () => {
    renderWith();
    await waitFor(() => screen.getByTestId("meetings-list"));
    const search = screen.getByLabelText("Search meetings");
    fireEvent.change(search, { target: { value: "David" } });
    await waitFor(() => {
      expect(screen.getByText("David sync")).toBeInTheDocument();
      expect(screen.queryByText("Weekly standup")).not.toBeInTheDocument();
    });
  });

  it("clicking a card opens NewMeetingDialog when New is pressed", async () => {
    renderWith();
    fireEvent.click(screen.getByTestId("new-meeting-button"));
    expect(screen.getByTestId("nm-0")).toBeInTheDocument();
  });
});
