// === wave 14 ===
/**
 * Wave 14 — /today ChatGPT-style hero tests.
 *
 * Covers the wave-14 pivot 1 deliverable: /today landing now leads
 * with a multiline chat input + orange Send button (replacing the
 * 200px BrainVizHero as the primary CTA). The brain viz still mounts
 * — demoted to a compact secondary anchor in the top-right.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import TodayRoute from "../src/routes/today";
import * as tauri from "../src/lib/tauri";
// === wave 18 === — Wave 14 covers the post-setup chat input. Wave 18
// added a setup-mode swap (OnboardingChat replaces the chat input when
// `setupWizardChannelReady === false`), so this suite must land in
// post-setup state by flipping the store latch in beforeEach.
import { useStore } from "../src/lib/store";

describe("Wave 14 — /today ChatGPT-style hero", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Default success — most tests want the dispatch to succeed.
    vi.spyOn(tauri, "coThinkerStatus").mockResolvedValue({
      last_heartbeat_at: null,
      next_heartbeat_at: null,
      brain_doc_size: 0,
      observations_today: 0,
    });
    // === wave 18 === — flip into post-setup (general-query) mode so
    // the Wave 14 chat input is rendered (instead of the OnboardingChat
    // setup-mode shell).
    useStore.setState((s) => ({
      ui: { ...s.ui, setupWizardChannelReady: true, onboardingMode: "chat" },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the chat input + send button as the primary hero CTA", async () => {
    render(
      <MemoryRouter>
        <TodayRoute />
      </MemoryRouter>,
    );

    // Hero H1 + textarea + Send button all mount together.
    expect(await screen.findByTestId("today-hero-h1")).toBeInTheDocument();
    const textarea = screen.getByTestId("today-chat-textarea");
    expect(textarea).toBeInTheDocument();
    expect(textarea.tagName).toBe("TEXTAREA");
    const send = screen.getByTestId("today-chat-send");
    expect(send).toBeInTheDocument();
    // Send is disabled when prompt is empty.
    expect(send).toBeDisabled();
  });

  it("clicking Send dispatches via coThinkerDispatch and renders the response", async () => {
    const dispatch = vi
      .spyOn(tauri, "coThinkerDispatch")
      .mockResolvedValue({
        text: "We picked **flat-rate** pricing on 2026-04-22.",
        channel_used: "mcp_sampling",
        tool_id: "cursor",
        latency_ms: 312,
        tokens_estimate: 22,
      });

    render(
      <MemoryRouter>
        <TodayRoute />
      </MemoryRouter>,
    );

    const textarea = await screen.findByTestId("today-chat-textarea");
    fireEvent.change(textarea, {
      target: { value: "What did we decide about pricing?" },
    });
    const send = screen.getByTestId("today-chat-send");
    expect(send).not.toBeDisabled();
    fireEvent.click(send);

    await waitFor(() => {
      expect(screen.getByTestId("today-chat-response")).toBeInTheDocument();
    });
    // The body text is rendered (markdown stripped to text in the
    // rendered DOM by react-markdown — the substring still appears).
    expect(screen.getByTestId("today-chat-response")).toHaveTextContent(
      /flat-rate/i,
    );
    // The dispatch call was made with our prompt.
    expect(dispatch).toHaveBeenCalledTimes(1);
    const callArgs = dispatch.mock.calls[0]?.[0];
    expect(callArgs?.user_prompt).toBe("What did we decide about pricing?");
  });

  it("shows a Thinking… loading state while the dispatch is in flight", async () => {
    let resolve: ((v: unknown) => void) | null = null;
    vi.spyOn(tauri, "coThinkerDispatch").mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r as (v: unknown) => void;
        }) as unknown as Promise<tauri.LlmResponse>,
    );

    render(
      <MemoryRouter>
        <TodayRoute />
      </MemoryRouter>,
    );

    const textarea = await screen.findByTestId("today-chat-textarea");
    fireEvent.change(textarea, { target: { value: "Hello" } });
    fireEvent.click(screen.getByTestId("today-chat-send"));

    // Loading state — Send button label flips to "Thinking…" and is
    // disabled. Response panel hasn't mounted yet.
    await waitFor(() => {
      expect(screen.getByTestId("today-chat-send")).toHaveTextContent(
        /Thinking/i,
      );
    });
    expect(screen.getByTestId("today-chat-send")).toBeDisabled();
    expect(
      screen.queryByTestId("today-chat-response"),
    ).not.toBeInTheDocument();

    // Resolve the dispatch so the test doesn't hang on the open promise.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (resolve as any)?.({
      text: "ok",
      channel_used: "mcp_sampling",
      tool_id: "cursor",
      latency_ms: 1,
      tokens_estimate: 1,
    });
    await waitFor(() => {
      expect(screen.getByTestId("today-chat-response")).toBeInTheDocument();
    });
  });

  it("renders the markdown response inside the chat bubble", async () => {
    vi.spyOn(tauri, "coThinkerDispatch").mockResolvedValue({
      text: "## Pricing\n- Flat rate $99\n- Decision: 2026-04-22",
      channel_used: "mcp_sampling",
      tool_id: "claude-code",
      latency_ms: 412,
      tokens_estimate: 32,
    });

    render(
      <MemoryRouter>
        <TodayRoute />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByTestId("today-chat-textarea"), {
      target: { value: "pricing?" },
    });
    fireEvent.click(screen.getByTestId("today-chat-send"));

    await waitFor(() => {
      expect(screen.getByTestId("today-chat-response")).toBeInTheDocument();
    });
    // Markdown heading renders as an actual <h2> in the DOM.
    const bubble = screen.getByTestId("today-chat-response");
    expect(bubble.querySelector("h2")?.textContent).toMatch(/Pricing/i);
    expect(bubble.querySelectorAll("li").length).toBe(2);
    // Provenance line shows the answering tool id + latency.
    expect(bubble).toHaveTextContent(/claude-code/);
    expect(bubble).toHaveTextContent(/412ms/);
  });

  it("renders an inline error block when coThinkerDispatch rejects", async () => {
    vi.spyOn(tauri, "coThinkerDispatch").mockRejectedValue(
      new Error("all_channels_exhausted"),
    );

    render(
      <MemoryRouter>
        <TodayRoute />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByTestId("today-chat-textarea"), {
      target: { value: "anything" },
    });
    fireEvent.click(screen.getByTestId("today-chat-send"));

    await waitFor(() => {
      expect(screen.getByTestId("today-chat-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("today-chat-error")).toHaveTextContent(
      /all_channels_exhausted/,
    );
    // Response panel should NOT mount on error.
    expect(
      screen.queryByTestId("today-chat-response"),
    ).not.toBeInTheDocument();
  });
});
// === end wave 14 ===
