// === wave 1.15 W2.1 ===
/**
 * Wave 1.15 W2.1 — DemoTourOverlay tests.
 *
 * Coverage (≥10 specs):
 *  1-5. Each step renders correct title + body + Next button.
 *  6.   Skip on a mid-tour step → demoTourCompleted=true, demoMode unchanged.
 *  7.   Step 5 conversion CTA → demoSeedClear called + demoMode=false +
 *       demoTourCompleted=true + navigate('/setup').
 *  8.   Overlay does not mount when demoTourCompleted=true.
 *  9.   Overlay does not mount when demoMode=false.
 *  10.  Each Next click fires `demo_tour_step_completed` (5 times across
 *       a full traversal).
 *  11.  Step-5 conversion fires `demo_to_real_conversion` event.
 *  12.  Skip fires `demo_tour_dismissed` event with the at_step payload.
 *  13.  Esc key dismisses (treated as Skip → latch flips, demoMode stays).
 *  14.  Dialog has role=dialog + aria-labelledby + tabIndex=-1 (a11y).
 *
 * Telemetry is mocked at the module boundary so we can assert on event
 * names + payloads without writing to disk. The Tauri demoSeedClear is
 * mocked too — vitest never has the bridge anyway, but we want a spy.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const tauriMocks = vi.hoisted(() => ({
  demoSeedClear: vi.fn(),
}));
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    demoSeedClear: tauriMocks.demoSeedClear,
  };
});

const telemetryMocks = vi.hoisted(() => ({
  logEvent: vi.fn(),
}));
vi.mock("@/lib/telemetry", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/telemetry")>();
  return {
    ...actual,
    logEvent: telemetryMocks.logEvent,
  };
});

import { useStore } from "../src/lib/store";
import { DemoTourOverlay } from "../src/components/onboarding/DemoTourOverlay";

function renderOverlay() {
  return render(
    <MemoryRouter>
      <DemoTourOverlay />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigateMock.mockClear();
  tauriMocks.demoSeedClear.mockReset();
  tauriMocks.demoSeedClear.mockResolvedValue({ removed_files: 16 });
  telemetryMocks.logEvent.mockReset();
  telemetryMocks.logEvent.mockResolvedValue(undefined);
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      demoMode: true,
      demoTourCompleted: false,
    },
  }));
});

afterEach(() => {
  cleanup();
});

describe("DemoTourOverlay — step rendering", () => {
  it("step 1 renders Memory tree title + body + Next", () => {
    renderOverlay();
    expect(screen.getByTestId("demo-tour-title")).toHaveTextContent(
      "Memory tree",
    );
    expect(screen.getByTestId("demo-tour-body")).toHaveTextContent(
      "你的所有 atom 在这",
    );
    expect(screen.getByTestId("demo-tour-next")).toBeInTheDocument();
    expect(screen.getByTestId("demo-tour-step-label")).toHaveTextContent(
      "Step 1 of 5",
    );
  });

  it("step 2 renders People copy after one Next", () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId("demo-tour-next"));
    expect(screen.getByTestId("demo-tour-title")).toHaveTextContent(
      "People",
    );
    expect(screen.getByTestId("demo-tour-body")).toHaveTextContent(
      "队友自动浮现",
    );
    expect(screen.getByTestId("demo-tour-next")).toBeInTheDocument();
  });

  it("step 3 renders Threads copy after two Nexts", () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId("demo-tour-next"));
    fireEvent.click(screen.getByTestId("demo-tour-next"));
    expect(screen.getByTestId("demo-tour-title")).toHaveTextContent(
      "Threads",
    );
    expect(screen.getByTestId("demo-tour-body")).toHaveTextContent(
      "@mention",
    );
    expect(screen.getByTestId("demo-tour-next")).toBeInTheDocument();
  });

  it("step 4 renders Co-Thinker copy after three Nexts", () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId("demo-tour-next"));
    fireEvent.click(screen.getByTestId("demo-tour-next"));
    fireEvent.click(screen.getByTestId("demo-tour-next"));
    expect(screen.getByTestId("demo-tour-title")).toHaveTextContent(
      "Co-Thinker",
    );
    expect(screen.getByTestId("demo-tour-body")).toHaveTextContent(
      "持续",
    );
    expect(screen.getByTestId("demo-tour-next")).toBeInTheDocument();
  });

  it("step 5 renders Ready-for-real CTA after four Nexts (no Next button on final)", () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId("demo-tour-next"));
    fireEvent.click(screen.getByTestId("demo-tour-next"));
    fireEvent.click(screen.getByTestId("demo-tour-next"));
    fireEvent.click(screen.getByTestId("demo-tour-next"));
    expect(screen.getByTestId("demo-tour-title")).toHaveTextContent(
      "Ready for real?",
    );
    expect(screen.getByTestId("demo-tour-body")).toHaveTextContent(
      "sample data",
    );
    expect(screen.getByTestId("demo-tour-try-real")).toBeInTheDocument();
    expect(screen.queryByTestId("demo-tour-next")).not.toBeInTheDocument();
  });
});

describe("DemoTourOverlay — skip / dismiss path", () => {
  it("Skip on a mid-tour step flips demoTourCompleted but leaves demoMode true", () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId("demo-tour-next")); // now on step 2
    fireEvent.click(screen.getByTestId("demo-tour-skip"));
    const ui = useStore.getState().ui;
    expect(ui.demoTourCompleted).toBe(true);
    expect(ui.demoMode).toBe(true);
  });

  it("Skip fires demo_tour_dismissed with the current at_step payload", () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId("demo-tour-next")); // step 2 (index 1)
    fireEvent.click(screen.getByTestId("demo-tour-next")); // step 3 (index 2)
    fireEvent.click(screen.getByTestId("demo-tour-skip"));
    const dismissCall = telemetryMocks.logEvent.mock.calls.find(
      (c) => c[0] === "demo_tour_dismissed",
    );
    expect(dismissCall).toBeDefined();
    expect(dismissCall![1]).toEqual({ at_step: 2 });
  });

  it("Esc key acts as Skip — flips latch + emits dismiss event", () => {
    renderOverlay();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape" }),
      );
    });
    const ui = useStore.getState().ui;
    expect(ui.demoTourCompleted).toBe(true);
    expect(ui.demoMode).toBe(true);
    const dismissCall = telemetryMocks.logEvent.mock.calls.find(
      (c) => c[0] === "demo_tour_dismissed",
    );
    expect(dismissCall).toBeDefined();
    expect(dismissCall![1]).toEqual({ at_step: 0 });
  });
});

describe("DemoTourOverlay — conversion path (step 5)", () => {
  it("Try-real CTA calls demoSeedClear, drops demoMode, latches completed, routes /setup", async () => {
    renderOverlay();
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByTestId("demo-tour-next"));
    }
    fireEvent.click(screen.getByTestId("demo-tour-try-real"));
    await waitFor(() => {
      expect(tauriMocks.demoSeedClear).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(useStore.getState().ui.demoMode).toBe(false);
    });
    const ui = useStore.getState().ui;
    expect(ui.demoTourCompleted).toBe(true);
    expect(navigateMock).toHaveBeenCalledWith("/setup");
  });

  it("Try-real fires demo_to_real_conversion with cleared_files count + from_step", async () => {
    tauriMocks.demoSeedClear.mockResolvedValueOnce({ removed_files: 16 });
    renderOverlay();
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByTestId("demo-tour-next"));
    }
    fireEvent.click(screen.getByTestId("demo-tour-try-real"));
    await waitFor(() => {
      const conv = telemetryMocks.logEvent.mock.calls.find(
        (c) => c[0] === "demo_to_real_conversion",
      );
      expect(conv).toBeDefined();
      expect(conv![1]).toEqual({ from_step: 4, cleared_files: 16 });
    });
  });
});

describe("DemoTourOverlay — gating + telemetry funnel", () => {
  it("does not render when demoTourCompleted=true (returning user)", () => {
    useStore.setState((s) => ({
      ui: { ...s.ui, demoMode: true, demoTourCompleted: true },
    }));
    renderOverlay();
    expect(screen.queryByTestId("demo-tour-dialog")).not.toBeInTheDocument();
  });

  it("does not render when demoMode=false (real-data user)", () => {
    useStore.setState((s) => ({
      ui: { ...s.ui, demoMode: false, demoTourCompleted: false },
    }));
    renderOverlay();
    expect(screen.queryByTestId("demo-tour-dialog")).not.toBeInTheDocument();
  });

  it("each Next click fires demo_tour_step_completed (5 events across full traversal)", async () => {
    renderOverlay();
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByTestId("demo-tour-next"));
    }
    fireEvent.click(screen.getByTestId("demo-tour-try-real"));
    await waitFor(() => {
      const stepEvents = telemetryMocks.logEvent.mock.calls.filter(
        (c) => c[0] === "demo_tour_step_completed",
      );
      // 4 Next clicks (steps 0..3) + 1 from try-real (step 4) = 5
      expect(stepEvents).toHaveLength(5);
      expect(stepEvents[0][1]).toEqual({ step_index: 0 });
      expect(stepEvents[4][1]).toEqual({ step_index: 4 });
    });
  });
});

describe("DemoTourOverlay — a11y", () => {
  it("dialog has role=dialog, aria-labelledby pointing at title, focusable", () => {
    renderOverlay();
    const dialog = screen.getByTestId("demo-tour-dialog");
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("aria-labelledby");
    expect(dialog).toHaveAttribute("aria-describedby");
    expect(dialog).toHaveAttribute("tabIndex", "-1");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy!);
    expect(heading).not.toBeNull();
    expect(heading?.textContent).toBe("Memory tree");
  });
});
// === end wave 1.15 W2.1 ===
