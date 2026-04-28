// === wave 10-B ===
// Tests for GitInitBanner. Pure presentational + a tiny bit of local UI
// state (URL field expand, confirmation modal). All persistence is owned
// by the parent so we just assert that the right callbacks fire.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  GitInitBanner,
  type GitInitBannerLabels,
} from "../src/components/GitInitBanner";

const LABELS: GitInitBannerLabels = {
  title: "Memory dir is not git-tracked",
  body: "Initialize git so your team can sync memory across machines.",
  initializeNow: "Initialize now",
  alreadyOnCloud: "Already on Cloud",
  maybeLater: "Maybe later",
  remoteUrlPlaceholder: "git@github.com:org/team-memory.git (optional)",
  initializing: "Initializing…",
};

function makeProps(overrides: Partial<React.ComponentProps<typeof GitInitBanner>> = {}) {
  return {
    shouldShow: true,
    onDismiss: vi.fn(),
    onInitialize: vi.fn().mockResolvedValue(undefined),
    onSkipForever: vi.fn(),
    labels: LABELS,
    ...overrides,
  };
}

describe("GitInitBanner", () => {
  it("renders nothing when shouldShow is false", () => {
    const props = makeProps({ shouldShow: false });
    const { container } = render(<GitInitBanner {...props} />);
    expect(container.querySelector('[data-testid="git-init-banner"]')).toBeNull();
  });

  it("renders title, body, and 3 buttons when shouldShow is true", () => {
    render(<GitInitBanner {...makeProps()} />);
    expect(screen.getByText(LABELS.title)).toBeInTheDocument();
    expect(screen.getByText(LABELS.body)).toBeInTheDocument();
    expect(screen.getByTestId("git-init-banner-initialize")).toBeInTheDocument();
    expect(screen.getByTestId("git-init-banner-already-on-cloud")).toBeInTheDocument();
    expect(screen.getByTestId("git-init-banner-maybe-later")).toBeInTheDocument();
  });

  it("'Initialize now' first click expands the URL input", () => {
    render(<GitInitBanner {...makeProps()} />);
    expect(
      screen.queryByTestId("git-init-banner-remote-url"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("git-init-banner-initialize"));
    expect(screen.getByTestId("git-init-banner-remote-url")).toBeInTheDocument();
  });

  it("'Initialize now' fires onInitialize(undefined) when no URL entered", async () => {
    const onInitialize = vi.fn().mockResolvedValue(undefined);
    render(<GitInitBanner {...makeProps({ onInitialize })} />);
    // First click expands URL field
    fireEvent.click(screen.getByTestId("git-init-banner-initialize"));
    // Second click runs init — URL is empty so we expect undefined
    fireEvent.click(screen.getByTestId("git-init-banner-initialize"));
    await waitFor(() => expect(onInitialize).toHaveBeenCalledTimes(1));
    expect(onInitialize).toHaveBeenCalledWith(undefined);
  });

  it("'Initialize now' fires onInitialize('git@...') when URL entered", async () => {
    const onInitialize = vi.fn().mockResolvedValue(undefined);
    render(<GitInitBanner {...makeProps({ onInitialize })} />);
    fireEvent.click(screen.getByTestId("git-init-banner-initialize"));
    const input = screen.getByTestId("git-init-banner-remote-url") as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: "git@github.com:tangerine/team-memory.git" },
    });
    fireEvent.click(screen.getByTestId("git-init-banner-initialize"));
    await waitFor(() => expect(onInitialize).toHaveBeenCalledTimes(1));
    expect(onInitialize).toHaveBeenCalledWith(
      "git@github.com:tangerine/team-memory.git",
    );
  });

  it("trims whitespace-only URL to undefined", async () => {
    const onInitialize = vi.fn().mockResolvedValue(undefined);
    render(<GitInitBanner {...makeProps({ onInitialize })} />);
    fireEvent.click(screen.getByTestId("git-init-banner-initialize"));
    const input = screen.getByTestId("git-init-banner-remote-url") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("git-init-banner-initialize"));
    await waitFor(() => expect(onInitialize).toHaveBeenCalledTimes(1));
    expect(onInitialize).toHaveBeenCalledWith(undefined);
  });

  it("'Maybe later' fires onDismiss", () => {
    const onDismiss = vi.fn();
    render(<GitInitBanner {...makeProps({ onDismiss })} />);
    fireEvent.click(screen.getByTestId("git-init-banner-maybe-later"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("'Already on Cloud' first click shows confirmation, second click fires onSkipForever", () => {
    const onSkipForever = vi.fn();
    render(<GitInitBanner {...makeProps({ onSkipForever })} />);
    // First click — confirmation appears, callback NOT yet fired
    fireEvent.click(screen.getByTestId("git-init-banner-already-on-cloud"));
    expect(onSkipForever).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("git-init-banner-confirm-skip"),
    ).toBeInTheDocument();
    // Second click — confirmation, callback fires
    fireEvent.click(screen.getByTestId("git-init-banner-already-on-cloud"));
    expect(onSkipForever).toHaveBeenCalledTimes(1);
  });

  it("disables all buttons while initialization is in flight", async () => {
    // Pending promise so we can observe the in-flight state.
    let resolveInit: () => void = () => {};
    const onInitialize = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve;
        }),
    );
    render(<GitInitBanner {...makeProps({ onInitialize })} />);
    fireEvent.click(screen.getByTestId("git-init-banner-initialize"));
    fireEvent.click(screen.getByTestId("git-init-banner-initialize"));
    await waitFor(() => {
      expect(screen.getByTestId("git-init-banner-initialize")).toBeDisabled();
      expect(screen.getByTestId("git-init-banner-already-on-cloud")).toBeDisabled();
      expect(screen.getByTestId("git-init-banner-maybe-later")).toBeDisabled();
    });
    // Show "Initializing…" label while pending.
    expect(
      screen.getByTestId("git-init-banner-initialize"),
    ).toHaveTextContent(LABELS.initializing);
    resolveInit();
  });
});
