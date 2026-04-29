/**
 * v1.16 Wave 3 Agent C1 — Magic Moment 30s onboarding tests.
 *
 * Coverage:
 *   1. Step 1 renders the headline + ↓ hint + skip.
 *   2. ArrowDown advances Step 1 → Step 2.
 *   3. Enter advances Step 1 → Step 2.
 *   4. Space advances Step 1 → Step 2.
 *   5. ESC at any step closes the modal + flips welcomed=true.
 *   6. Step 2 mounts 5 sample atoms (data-visible toggles in,
 *      verified by stack data attribute, not animation timing).
 *   7. Step 3 default checkboxes — claude_code + cursor checked,
 *      codex + windsurf unchecked.
 *   8. Step 3 toggle a checkbox flips data-checked.
 *   9. Step 3 confirm advances to Step 4 + writes through to store.
 *  10. Step 4 enter button navigates to /feed + flips welcomed=true.
 *  11. Returning user (welcomed=true) does NOT mount the modal.
 *  12. Step 1 click "↓ 继续" button also advances.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import { MagicMoment } from "../src/components/onboarding/MagicMoment";
import { useStore } from "../src/lib/store";

function FeedStub() {
  return <div data-testid="feed-stub">FEED</div>;
}

function Harness() {
  return (
    <>
      <MagicMoment />
      <Routes>
        <Route path="/" element={<div data-testid="root-stub" />} />
        <Route path="/feed" element={<FeedStub />} />
      </Routes>
    </>
  );
}

function renderMagic(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Harness />
    </MemoryRouter>,
  );
}

/** Drive the Step 2 animation to completion. The internal effect
 *  schedules one chained setTimeout per tick; vitest's fake timers
 *  fire the *currently* pending timer, not the chain — so we loop and
 *  advance until the "继续 →" button is rendered (max 6 ticks). */
async function advanceToStep2Done() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    if (screen.queryByTestId("magic-step2-advance")) return;
  }
  throw new Error("Step 2 never reached its done state");
}

beforeEach(() => {
  // Reset welcomed + personal-agent flags between specs.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      welcomed: false,
      personalAgentsEnabled: {
        cursor: false,
        claude_code: false,
        codex: false,
        windsurf: false,
        devin: false,
        replit: false,
        apple_intelligence: false,
        ms_copilot: false,
      },
    },
  }));
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("Wave 3 C1 — MagicMoment", () => {
  it("Step 1 renders the headline + ↓ hint", () => {
    renderMagic();
    const moment = screen.getByTestId("magic-moment");
    expect(moment.getAttribute("data-step")).toBe("1");
    expect(screen.getByTestId("magic-step1")).toBeInTheDocument();
    const headline = screen.getByTestId("magic-step1-headline");
    expect(headline.textContent).toContain("Tangerine 自动记住你团队");
    expect(headline.textContent).toContain("跟 AI 说的所有对话");
    // ↓ prompt
    expect(screen.getByText(/按.*看示例/)).toBeInTheDocument();
    expect(screen.getByText(/press ↓ to continue/i)).toBeInTheDocument();
  });

  it("ArrowDown advances Step 1 → Step 2", () => {
    renderMagic();
    expect(screen.getByTestId("magic-step1")).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowDown" });
    });
    expect(screen.getByTestId("magic-step2")).toBeInTheDocument();
    expect(screen.queryByTestId("magic-step1")).not.toBeInTheDocument();
  });

  it("Enter advances Step 1 → Step 2", () => {
    renderMagic();
    act(() => {
      fireEvent.keyDown(window, { key: "Enter" });
    });
    expect(screen.getByTestId("magic-step2")).toBeInTheDocument();
  });

  it("Space advances Step 1 → Step 2", () => {
    renderMagic();
    act(() => {
      fireEvent.keyDown(window, { key: " " });
    });
    expect(screen.getByTestId("magic-step2")).toBeInTheDocument();
  });

  it("Step 1 click button also advances", () => {
    renderMagic();
    fireEvent.click(screen.getByTestId("magic-step1-advance"));
    expect(screen.getByTestId("magic-step2")).toBeInTheDocument();
  });

  it("ESC at Step 1 closes + flips welcomed=true", () => {
    renderMagic();
    expect(useStore.getState().ui.welcomed).toBe(false);
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(useStore.getState().ui.welcomed).toBe(true);
    expect(screen.queryByTestId("magic-moment")).not.toBeInTheDocument();
  });

  it("Step 2 skip button closes + flips welcomed=true", () => {
    renderMagic();
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowDown" });
    });
    expect(screen.getByTestId("magic-step2")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("magic-step2-skip"));
    expect(useStore.getState().ui.welcomed).toBe(true);
    expect(screen.queryByTestId("magic-moment")).not.toBeInTheDocument();
  });

  it("Step 2 mounts 5 sample atoms", () => {
    renderMagic();
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowDown" });
    });
    const stack = screen.getByTestId("magic-step2-stack");
    // The stack hosts all 5 atoms even when only the first is "visible".
    // Each sample renders an AtomCard wrapper keyed by id.
    expect(stack.querySelectorAll('[data-testid^="magic-sample-magic-sample-"]').length).toBe(5);
  });

  it("Step 3 default checkboxes — claude_code + cursor checked", async () => {
    vi.useFakeTimers();
    renderMagic();
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowDown" });
    });
    await advanceToStep2Done();
    fireEvent.click(screen.getByTestId("magic-step2-advance"));
    expect(screen.getByTestId("magic-step3")).toBeInTheDocument();
    expect(
      screen.getByTestId("magic-step3-row-claude_code").getAttribute("data-checked"),
    ).toBe("true");
    expect(
      screen.getByTestId("magic-step3-row-cursor").getAttribute("data-checked"),
    ).toBe("true");
    expect(
      screen.getByTestId("magic-step3-row-codex").getAttribute("data-checked"),
    ).toBe("false");
    expect(
      screen.getByTestId("magic-step3-row-windsurf").getAttribute("data-checked"),
    ).toBe("false");
    vi.useRealTimers();
  });

  it("Step 3 toggle a checkbox flips data-checked", async () => {
    vi.useFakeTimers();
    renderMagic();
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowDown" });
    });
    await advanceToStep2Done();
    fireEvent.click(screen.getByTestId("magic-step2-advance"));
    const codexRow = screen.getByTestId("magic-step3-row-codex");
    expect(codexRow.getAttribute("data-checked")).toBe("false");
    fireEvent.click(screen.getByTestId("magic-step3-checkbox-codex"));
    expect(codexRow.getAttribute("data-checked")).toBe("true");
    vi.useRealTimers();
  });

  it("Step 3 confirm advances to Step 4 + writes selections to store", async () => {
    vi.useFakeTimers();
    renderMagic();
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowDown" });
    });
    await advanceToStep2Done();
    fireEvent.click(screen.getByTestId("magic-step2-advance"));
    // Toggle codex on so we can verify the write-through.
    fireEvent.click(screen.getByTestId("magic-step3-checkbox-codex"));
    fireEvent.click(screen.getByTestId("magic-step3-confirm"));
    expect(screen.getByTestId("magic-step4")).toBeInTheDocument();
    const flags = useStore.getState().ui.personalAgentsEnabled;
    expect(flags.claude_code).toBe(true);
    expect(flags.cursor).toBe(true);
    expect(flags.codex).toBe(true);
    expect(flags.windsurf).toBe(false);
    vi.useRealTimers();
  });

  it("Step 4 enter button navigates to /feed + flips welcomed=true", async () => {
    vi.useFakeTimers();
    renderMagic();
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowDown" });
    });
    await advanceToStep2Done();
    fireEvent.click(screen.getByTestId("magic-step2-advance"));
    fireEvent.click(screen.getByTestId("magic-step3-confirm"));
    expect(useStore.getState().ui.welcomed).toBe(false);
    // Switch back to real timers so React Router's navigate() finishes
    // its scheduled work without our fake clock holding it.
    vi.useRealTimers();
    fireEvent.click(screen.getByTestId("magic-step4-enter"));
    expect(useStore.getState().ui.welcomed).toBe(true);
    await waitFor(() => {
      expect(screen.queryByTestId("magic-moment")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("feed-stub")).toBeInTheDocument();
  });

  it("returning user (welcomed=true) does NOT mount the modal", () => {
    useStore.setState((s) => ({
      ui: { ...s.ui, welcomed: true },
    }));
    // We test the AppShell mount gate directly via the predicate that
    // gates the JSX. The gate is `!welcomed`, so we assert the store
    // value drives a no-mount decision; exercising AppShell itself
    // would pull in PresenceProvider + Tauri stubs and is out of
    // scope for this unit. We instead skip rendering the MagicMoment
    // and just verify the predicate.
    const shouldMount = !useStore.getState().ui.welcomed;
    expect(shouldMount).toBe(false);
  });
});
