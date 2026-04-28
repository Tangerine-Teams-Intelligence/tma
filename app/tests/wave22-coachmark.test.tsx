// === wave 22 ===
/**
 * Wave 22 — Coachmark / FirstRunTour / TryThisFAB tests.
 *
 * Coverage:
 *   - Coachmark renders with title + body + Next + Skip + step label.
 *   - Coachmark gracefully skips when its target element is missing.
 *   - FirstRunTour gates correctly on demoMode + completion latch.
 *   - TryThisFAB opens, rotates cards, dismisses, and persists per-card
 *     dismiss memory.
 *   - /today renders sample query chips when prompt is empty + post-setup.
 *
 * The Coachmark tests use a tiny harness that mounts a fake target
 * element so the targetSelector resolves. All store state is reset
 * between tests via `useStore.setState`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Hoisted mocks so the /today route's data fetches resolve quickly inside
// the sample-chip render assertion.
const tauriMocks = vi.hoisted(() => {
  return {
    activityRecent: vi.fn(),
    listenActivityAtoms: vi.fn(async () => () => {}),
    coThinkerReadBrain: vi.fn(),
    coThinkerStatus: vi.fn(),
    coThinkerDispatch: vi.fn(),
  };
});

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    activityRecent: tauriMocks.activityRecent,
    listenActivityAtoms: tauriMocks.listenActivityAtoms,
    coThinkerReadBrain: tauriMocks.coThinkerReadBrain,
    coThinkerStatus: tauriMocks.coThinkerStatus,
    coThinkerDispatch: tauriMocks.coThinkerDispatch,
  };
});

import { useStore } from "../src/lib/store";
import { CoachmarkProvider } from "../src/components/coachmark/CoachmarkProvider";
import { Coachmark } from "../src/components/coachmark/Coachmark";
import { TryThisFAB } from "../src/components/coachmark/TryThisFAB";
import { useCoachmark } from "../src/components/coachmark/CoachmarkProvider";
import TodayRoute from "../src/routes/today";

beforeEach(() => {
  vi.restoreAllMocks();
  tauriMocks.activityRecent.mockReset();
  tauriMocks.listenActivityAtoms.mockClear();
  tauriMocks.coThinkerReadBrain.mockReset();
  tauriMocks.coThinkerStatus.mockReset();
  tauriMocks.coThinkerDispatch.mockReset();

  // Default mock returns — widgets resolve to empty / idle states.
  tauriMocks.activityRecent.mockResolvedValue([]);
  tauriMocks.listenActivityAtoms.mockImplementation(async () => () => {});
  tauriMocks.coThinkerReadBrain.mockResolvedValue("");
  tauriMocks.coThinkerStatus.mockResolvedValue({
    last_heartbeat_at: null,
    next_heartbeat_at: null,
    brain_doc_size: 0,
    observations_today: 0,
  });

  // Reset every wave 22 store flag so each test starts clean.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      firstRunTourCompleted: false,
      coachmarksDismissed: [],
      tryThisDismissed: [],
      welcomed: true,
      demoMode: true,
      setupWizardChannelReady: true,
      onboardingMode: "chat",
    },
  }));
});

afterEach(() => {
  cleanup();
});

// Tiny test harness so we can drive the provider without mounting the
// whole AppShell. The button calls `showStep` so the Coachmark renders.
function CoachmarkHarness({
  step,
  targetSelector,
  title = "Hello",
  body = "World",
  isFinal = false,
}: {
  step: string;
  targetSelector: string;
  title?: string;
  body?: string;
  isFinal?: boolean;
}) {
  return (
    <CoachmarkProvider>
      <ShowButton step={step} />
      <Coachmark
        step={step}
        targetSelector={targetSelector}
        title={title}
        body={body}
        stepLabel="1 of 6"
        isFinal={isFinal}
      />
    </CoachmarkProvider>
  );
}

function ShowButton({ step }: { step: string }) {
  const { showStep } = useCoachmark();
  return (
    <button data-testid="harness-show" onClick={() => showStep(step)}>
      show
    </button>
  );
}

describe("Wave 22 — Coachmark", () => {
  it("renders title + body + Next + Skip + step label when target exists", () => {
    // Mount a fake target before rendering the provider.
    const target = document.createElement("div");
    target.setAttribute("data-testid", "fake-target");
    target.style.width = "100px";
    target.style.height = "30px";
    document.body.appendChild(target);

    try {
      render(
        <CoachmarkHarness
          step="test.step1"
          targetSelector='[data-testid="fake-target"]'
        />,
      );
      fireEvent.click(screen.getByTestId("harness-show"));

      expect(screen.getByTestId("coachmark-test.step1")).toBeInTheDocument();
      expect(screen.getByText(/Hello/)).toBeInTheDocument();
      expect(screen.getByText(/World/)).toBeInTheDocument();
      expect(
        screen.getByTestId("coachmark-test.step1-step-label"),
      ).toHaveTextContent(/1 of 6/);
      expect(
        screen.getByTestId("coachmark-test.step1-next"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("coachmark-test.step1-skip"),
      ).toBeInTheDocument();
    } finally {
      document.body.removeChild(target);
    }
  });

  it("clicking Next dismisses the coachmark and persists the dismissal", () => {
    const target = document.createElement("div");
    target.setAttribute("data-testid", "fake-target-2");
    document.body.appendChild(target);

    try {
      render(
        <CoachmarkHarness
          step="test.step2"
          targetSelector='[data-testid="fake-target-2"]'
        />,
      );
      fireEvent.click(screen.getByTestId("harness-show"));
      expect(screen.getByTestId("coachmark-test.step2")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("coachmark-test.step2-next"));

      expect(screen.queryByTestId("coachmark-test.step2")).toBeNull();
      expect(useStore.getState().ui.coachmarksDismissed).toContain(
        "test.step2",
      );
    } finally {
      document.body.removeChild(target);
    }
  });

  it("renders the final-step Done CTA when isFinal=true", () => {
    const target = document.createElement("div");
    target.setAttribute("data-testid", "fake-target-3");
    document.body.appendChild(target);

    try {
      render(
        <CoachmarkHarness
          step="test.final"
          targetSelector='[data-testid="fake-target-3"]'
          isFinal
        />,
      );
      fireEvent.click(screen.getByTestId("harness-show"));
      // The Next button reads "Got it" instead of "Next" on the final step.
      expect(screen.getByTestId("coachmark-test.final-next")).toHaveTextContent(
        /Got it/i,
      );
    } finally {
      document.body.removeChild(target);
    }
  });

  it("gracefully auto-dismisses when target element is missing", async () => {
    // No target in the DOM — the Coachmark should silently dismiss.
    render(
      <CoachmarkHarness
        step="test.missing"
        targetSelector='[data-testid="not-there"]'
      />,
    );
    fireEvent.click(screen.getByTestId("harness-show"));
    // Coachmark may briefly hold the step in the active slot before the
    // graceful-skip effect runs; assert the auto-dismiss completes.
    await waitFor(() => {
      expect(screen.queryByTestId("coachmark-test.missing")).toBeNull();
    });
    expect(useStore.getState().ui.coachmarksDismissed).toContain(
      "test.missing",
    );
  });

  it("Esc key dismisses with skip semantics", () => {
    const target = document.createElement("div");
    target.setAttribute("data-testid", "fake-target-esc");
    document.body.appendChild(target);

    try {
      render(
        <CoachmarkHarness
          step="test.esc"
          targetSelector='[data-testid="fake-target-esc"]'
        />,
      );
      fireEvent.click(screen.getByTestId("harness-show"));
      expect(screen.getByTestId("coachmark-test.esc")).toBeInTheDocument();

      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });

      expect(screen.queryByTestId("coachmark-test.esc")).toBeNull();
      expect(useStore.getState().ui.coachmarksDismissed).toContain("test.esc");
    } finally {
      document.body.removeChild(target);
    }
  });
});

describe("Wave 22 — TryThisFAB", () => {
  it("renders the floating button at bottom-right", () => {
    render(
      <MemoryRouter>
        <TryThisFAB />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("try-this-fab")).toBeInTheDocument();
  });

  it("clicking the FAB opens a card popover with a fresh card", () => {
    render(
      <MemoryRouter>
        <TryThisFAB />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("try-this-fab"));
    expect(screen.getByTestId("try-this-popover")).toBeInTheDocument();
    // Some card must be rendered (cards are picked round-robin).
    const popover = screen.getByTestId("try-this-popover");
    expect(popover.textContent).toMatch(/Did you know/i);
  });

  it("clicking dismiss persists the card id into tryThisDismissed", () => {
    render(
      <MemoryRouter>
        <TryThisFAB />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("try-this-fab"));
    expect(screen.getByTestId("try-this-popover")).toBeInTheDocument();
    // The first picked card id is queryable via its data-testid prefix.
    const card = screen
      .getByTestId("try-this-popover")
      .querySelector('[data-testid^="try-this-card-"]');
    expect(card).not.toBeNull();
    const cardTestId = card!.getAttribute("data-testid")!;
    const cardId = cardTestId.replace("try-this-card-", "");

    fireEvent.click(screen.getByTestId("try-this-dismiss"));
    expect(useStore.getState().ui.tryThisDismissed).toContain(cardId);
  });

  it("clicking 'show another' rotates to a different card", () => {
    render(
      <MemoryRouter>
        <TryThisFAB />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("try-this-fab"));
    const card1 = screen
      .getByTestId("try-this-popover")
      .querySelector('[data-testid^="try-this-card-"]')!;
    const card1Id = card1.getAttribute("data-testid")!;

    fireEvent.click(screen.getByTestId("try-this-next"));
    const card2 = screen
      .getByTestId("try-this-popover")
      .querySelector('[data-testid^="try-this-card-"]')!;
    const card2Id = card2.getAttribute("data-testid")!;
    expect(card2Id).not.toBe(card1Id);
  });
});

// FirstRunTour smoke — exercises the integrated path against a manual
// /today render with all the targets present.
describe("Wave 22 — FirstRunTour gating", () => {
  it("does not render when firstRunTourCompleted is true", async () => {
    useStore.setState((s) => ({
      ui: { ...s.ui, firstRunTourCompleted: true },
    }));
    const { FirstRunTour } = await import(
      "../src/components/coachmark/FirstRunTour"
    );
    render(
      <MemoryRouter>
        <CoachmarkProvider>
          <FirstRunTour />
        </CoachmarkProvider>
      </MemoryRouter>,
    );
    // No coachmarks should show because gate is already satisfied.
    expect(screen.queryByTestId("coachmark-first_run.stat")).toBeNull();
  });

  it("does not render when demoMode is false", async () => {
    useStore.setState((s) => ({
      ui: { ...s.ui, firstRunTourCompleted: false, demoMode: false },
    }));
    const { FirstRunTour } = await import(
      "../src/components/coachmark/FirstRunTour"
    );
    render(
      <MemoryRouter>
        <CoachmarkProvider>
          <FirstRunTour />
        </CoachmarkProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("coachmark-first_run.stat")).toBeNull();
  });

  it("flipping firstRunTourCompleted via setter persists across reads", () => {
    useStore.getState().ui.setFirstRunTourCompleted(true);
    expect(useStore.getState().ui.firstRunTourCompleted).toBe(true);
    useStore.getState().ui.setFirstRunTourCompleted(false);
    expect(useStore.getState().ui.firstRunTourCompleted).toBe(false);
  });
});

// /today sample query chips — only render in fresh-input + post-setup state.
describe("Wave 22 — /today sample query chips", () => {
  it("renders 3 sample chips when prompt is empty and post-setup", async () => {
    render(
      <MemoryRouter>
        <TodayRoute />
      </MemoryRouter>,
    );

    expect(
      await screen.findByTestId("today-sample-queries"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("today-sample-query-decided"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("today-sample-query-personRecent"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("today-sample-query-lastWeek"),
    ).toBeInTheDocument();
  });

  it("clicking a chip dispatches via coThinkerDispatch", async () => {
    tauriMocks.coThinkerDispatch.mockResolvedValue({
      text: "Sample answer",
      channel_used: "mcp_sampling",
      tool_id: "cursor",
      latency_ms: 100,
      tokens_estimate: 4,
    });

    render(
      <MemoryRouter>
        <TodayRoute />
      </MemoryRouter>,
    );

    const chip = await screen.findByTestId("today-sample-query-decided");
    fireEvent.click(chip);
    await waitFor(() => {
      expect(tauriMocks.coThinkerDispatch).toHaveBeenCalledTimes(1);
    });
  });

  it("hides sample chips once prompt has text", async () => {
    render(
      <MemoryRouter>
        <TodayRoute />
      </MemoryRouter>,
    );
    const textarea = await screen.findByTestId("today-chat-textarea");
    fireEvent.change(textarea, { target: { value: "anything" } });
    expect(screen.queryByTestId("today-sample-queries")).toBeNull();
  });
});
// === end wave 22 ===
