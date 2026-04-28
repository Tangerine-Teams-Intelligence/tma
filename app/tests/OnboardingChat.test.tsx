// === wave 18 ===
/**
 * v1.10.4 — OnboardingChat component tests.
 *
 * Coverage:
 *   1. Initial system primer renders on mount and the input + send
 *      controls exist.
 *   2. User submits a message → onboardingChatTurn is invoked + the
 *      assistant's reply renders below the user echo.
 *   3. Assistant turn with action_taken renders an action card with
 *      the right kind data attribute + status color tag.
 *   4. Fallback link to the form-based wizard opens the SetupWizard
 *      modal via the store setter.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

import { OnboardingChat } from "../src/components/OnboardingChat";
import { useStore } from "../src/lib/store";

const mockOnboardingChatTurn = vi.fn();

vi.mock("../src/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tauri")>(
    "../src/lib/tauri",
  );
  return {
    ...actual,
    onboardingChatTurn: (...args: unknown[]) =>
      mockOnboardingChatTurn(...args),
  };
});

beforeEach(() => {
  // Reset all wave-18 + wave-11 store flags so each test starts in
  // fresh-install state.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      setupWizardChannelReady: false,
      setupWizardOpen: false,
      onboardingMode: "chat",
      onboardingChatStarted: false,
    },
  }));
  // Reset the mock between tests so per-test resolutions don't leak.
  mockOnboardingChatTurn.mockReset();
  // Default mock = a non-MCP action (whisper_download pending) so the
  // chat reply renders without flipping `setupWizardChannelReady` and
  // unmounting the assistant bubble. Tests that need a different shape
  // override via `mockOnboardingChatTurn.mockResolvedValueOnce(...)`.
  mockOnboardingChatTurn.mockResolvedValue({
    role: "assistant",
    content: "Got it — wiring Claude Code now.",
    actions_taken: [],
    actions_pending: [
      {
        kind: "whisper_download",
        status: "pending",
        detail: "Download Whisper small model (~244MB)",
        error: null,
      },
    ],
  });
  // Wipe any persisted chat session id so each test gets a fresh one.
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem("tangerine.onboarding-chat.session-id");
    } catch {
      // Storage blocked — fine, the component falls back to a fresh id
      // every render in that case.
    }
  }
});

describe("OnboardingChat", () => {
  it("renders initial system primer + input + send button", () => {
    render(<OnboardingChat />);
    expect(screen.getByTestId("onboarding-chat")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-chat-system")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-chat-textarea")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-chat-send")).toBeInTheDocument();
  });

  it("submitting a message dispatches and renders the assistant reply", async () => {
    render(<OnboardingChat />);
    const textarea = screen.getByTestId("onboarding-chat-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "primary=Claude Code" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("onboarding-chat-send"));
    });
    // User echo appears.
    await waitFor(() =>
      expect(screen.getByTestId("onboarding-chat-user")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("onboarding-chat-user")).toHaveTextContent(
      "primary=Claude Code",
    );
    // Assistant reply appears.
    await waitFor(() =>
      expect(screen.getByTestId("onboarding-chat-assistant")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("onboarding-chat-assistant")).toHaveTextContent(
      "Got it — wiring Claude Code now.",
    );
  });

  it("renders action cards inline below the assistant reply", async () => {
    render(<OnboardingChat />);
    const textarea = screen.getByTestId("onboarding-chat-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "download whisper" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("onboarding-chat-send"));
    });
    // The default mock returns a pending whisper_download action — the
    // assistant bubble must render the action card with data-status="pending".
    // We assert on whisper_download (not configure_mcp) so the test doesn't
    // race the channelReady-flip side-effect that hides the chat the
    // moment a configure_mcp action lands.
    await waitFor(() =>
      expect(
        screen.getByTestId("onboarding-chat-action-whisper_download"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("onboarding-chat-action-whisper_download"),
    ).toHaveAttribute("data-status", "pending");
  });

  it("flips setupWizardChannelReady when a configure_mcp action succeeds", async () => {
    mockOnboardingChatTurn.mockResolvedValueOnce({
      role: "assistant",
      content: "Done — restart your editor.",
      actions_taken: [
        {
          kind: "configure_mcp",
          status: "succeeded",
          detail: "Wrote MCP entry",
          error: null,
        },
      ],
      actions_pending: [],
    });
    render(<OnboardingChat />);
    expect(useStore.getState().ui.setupWizardChannelReady).toBe(false);
    const textarea = screen.getByTestId("onboarding-chat-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "primary=Cursor" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("onboarding-chat-send"));
    });
    // The configure_mcp succeeded → channelReady flips → component
    // unmounts the chat shell and shows the success note.
    await waitFor(() =>
      expect(useStore.getState().ui.setupWizardChannelReady).toBe(true),
    );
    expect(
      screen.queryByTestId("onboarding-chat-complete"),
    ).toBeInTheDocument();
  });

  it("'Use form-based setup' link opens the SetupWizard via the store", () => {
    render(<OnboardingChat />);
    expect(useStore.getState().ui.setupWizardOpen).toBe(false);
    fireEvent.click(screen.getByTestId("onboarding-chat-open-wizard"));
    expect(useStore.getState().ui.setupWizardOpen).toBe(true);
  });

  it("hides itself and shows the 'setup complete' note once channelReady flips", () => {
    useStore.setState((s) => ({
      ui: { ...s.ui, setupWizardChannelReady: true },
    }));
    render(<OnboardingChat />);
    // Setup-mode shell should be gone; the success note replaces it.
    expect(screen.queryByTestId("onboarding-chat")).not.toBeInTheDocument();
    expect(screen.getByTestId("onboarding-chat-complete")).toBeInTheDocument();
  });

  it("renders nothing when onboardingMode is 'wizard'", () => {
    useStore.setState((s) => ({
      ui: { ...s.ui, onboardingMode: "wizard" },
    }));
    const { container } = render(<OnboardingChat />);
    expect(container.querySelector('[data-testid="onboarding-chat"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="onboarding-chat-complete"]'),
    ).toBeNull();
  });
});
// === end wave 18 ===
