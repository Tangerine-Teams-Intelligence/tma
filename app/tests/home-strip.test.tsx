/**
 * v2.0-beta.3 — HomeStrip + sensitivity slider + onboarding cut tests.
 *
 * Covers the three user-visible deliverables of the v2.0-beta.3 build:
 *   1. The persistent home strip mounts above the route content,
 *      hydrates from `coThinkerStatus()`, and self-hides when the
 *      master AGI participation switch flips off.
 *   2. The simplified Settings → AGI sensitivity slider maps deterministically
 *      to the legacy volume + threshold pair so the existing ambient
 *      policy in `lib/ambient.ts` keeps working unchanged.
 *   3. The onboarding-team route skips the picker entirely when the
 *      user-facing memory dir is non-empty (returning user) or the
 *      memory mode is already set.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { HomeStrip } from "../src/components/co-thinker/HomeStrip";
import {
  useStore,
  sensitivityToVolumeThreshold,
  deriveSensitivity,
} from "../src/lib/store";
import * as tauri from "../src/lib/tauri";
import * as memory from "../src/lib/memory";
import OnboardingTeamRoute from "../src/routes/onboarding-team";
import * as gitLib from "../src/lib/git";

describe("HomeStrip", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Force a fresh store snapshot so the master switch defaults to on
    // and prior tests don't bleed sensitivity / volume state in.
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        agiParticipation: true,
        agiSensitivity: 50,
        agiVolume: "quiet",
        agiConfidenceThreshold: 0.7,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("HomeStrip renders with status", async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    vi.spyOn(tauri, "coThinkerStatus").mockResolvedValue({
      last_heartbeat_at: fiveMinAgo,
      next_heartbeat_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      brain_doc_size: 1234,
      observations_today: 3,
    });

    render(
      <MemoryRouter>
        <HomeStrip />
      </MemoryRouter>,
    );

    // Strip mounts immediately and hydrates from the bridge.
    expect(screen.getByTestId("co-thinker-home-strip")).toBeInTheDocument();
    await waitFor(() => {
      // === wave 12 === — UI copy changed "last heartbeat" → "last sync"
      // (Wave 12 hides heartbeat jargon in user UI). Test ID kept stable.
      expect(
        screen.getByTestId("co-thinker-home-strip-heartbeat"),
      ).toHaveTextContent(/last sync 5 min ago/i);
    });
    expect(
      screen.getByTestId("co-thinker-home-strip-observations"),
    ).toHaveTextContent(/3 things watching/i);
    // Recent activity (5min ago < 10min threshold) → pulse on.
    expect(
      screen.getByTestId("co-thinker-home-strip"),
    ).toHaveAttribute("data-recent", "true");
  });

  it("HomeStrip hides when agiParticipation is false", () => {
    vi.spyOn(tauri, "coThinkerStatus").mockResolvedValue({
      last_heartbeat_at: null,
      next_heartbeat_at: null,
      brain_doc_size: 0,
      observations_today: 0,
    });
    useStore.setState((s) => ({
      ui: { ...s.ui, agiParticipation: false },
    }));

    const { container } = render(
      <MemoryRouter>
        <HomeStrip />
      </MemoryRouter>,
    );
    expect(
      screen.queryByTestId("co-thinker-home-strip"),
    ).not.toBeInTheDocument();
    // Master-switch-off branch returns null — empty render output.
    expect(container.firstChild).toBeNull();
  });

  it("HomeStrip never shows pulse when no heartbeat fired yet", async () => {
    vi.spyOn(tauri, "coThinkerStatus").mockResolvedValue({
      last_heartbeat_at: null,
      next_heartbeat_at: null,
      brain_doc_size: 0,
      observations_today: 0,
    });
    render(
      <MemoryRouter>
        <HomeStrip />
      </MemoryRouter>,
    );
    await waitFor(() => {
      // === wave 12 === — UI copy "last heartbeat never" → "last sync never".
      expect(
        screen.getByTestId("co-thinker-home-strip-heartbeat"),
      ).toHaveTextContent(/last sync never/i);
    });
    expect(
      screen.getByTestId("co-thinker-home-strip"),
    ).toHaveAttribute("data-recent", "false");
  });
});

describe("sensitivity slider mapping", () => {
  it("Sensitivity slider maps to old volume values — silent band", () => {
    const r = sensitivityToVolumeThreshold(15);
    expect(r.volume).toBe("silent");
    expect(r.threshold).toBeGreaterThanOrEqual(0.9);
  });

  it("Sensitivity slider maps to old volume values — quiet (default) band", () => {
    const r = sensitivityToVolumeThreshold(50);
    expect(r.volume).toBe("quiet");
    expect(r.threshold).toBeCloseTo(0.7, 5);
  });

  it("Sensitivity slider maps to old volume values — chatty band", () => {
    const r = sensitivityToVolumeThreshold(75);
    expect(r.volume).toBe("chatty");
    expect(r.threshold).toBeCloseTo(0.6, 5);
  });

  it("Sensitivity slider maps to old volume values — alerts-only top end", () => {
    const r = sensitivityToVolumeThreshold(95);
    expect(r.volume).toBe("quiet");
    expect(r.threshold).toBeGreaterThanOrEqual(0.85);
  });

  it("clamps out-of-range slider input", () => {
    expect(sensitivityToVolumeThreshold(-10).volume).toBe("silent");
    expect(sensitivityToVolumeThreshold(150).volume).toBe("quiet");
    expect(sensitivityToVolumeThreshold(150).threshold).toBeGreaterThanOrEqual(
      0.85,
    );
  });

  it("setAgiSensitivity propagates to legacy volume + threshold fields", () => {
    useStore.getState().ui.setAgiSensitivity(75);
    const ui = useStore.getState().ui;
    expect(ui.agiSensitivity).toBe(75);
    expect(ui.agiVolume).toBe("chatty");
    expect(ui.agiConfidenceThreshold).toBeCloseTo(0.6, 5);
  });

  it("setAgiSensitivity rounds + clamps", () => {
    useStore.getState().ui.setAgiSensitivity(150);
    expect(useStore.getState().ui.agiSensitivity).toBe(100);
    useStore.getState().ui.setAgiSensitivity(-5);
    expect(useStore.getState().ui.agiSensitivity).toBe(0);
    useStore.getState().ui.setAgiSensitivity(50.7);
    expect(useStore.getState().ui.agiSensitivity).toBe(51);
  });

  it("deriveSensitivity reverses the mapping for v1.x migrations", () => {
    expect(deriveSensitivity("silent", 0.95)).toBe(15);
    expect(deriveSensitivity("quiet", 0.7)).toBe(45);
    expect(deriveSensitivity("chatty", 0.5)).toBe(75);
    // Quiet + high threshold → "alerts only" bucket centre.
    expect(deriveSensitivity("quiet", 0.9)).toBe(95);
  });
});

describe("Onboarding skip when memory dir non-empty", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset memoryConfig.mode back to undefined so we test the skip
    // logic on the "first launch" path.
    useStore.setState((s) => ({
      ui: { ...s.ui, memoryConfig: { ...s.ui.memoryConfig, mode: undefined } },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Onboarding skips when memory dir non-empty", async () => {
    // Bridge says memory dir has user content — should redirect to
    // /today and silently set mode = "solo".
    vi.spyOn(tauri, "resolveMemoryRoot").mockResolvedValue({
      path: "/fake/memory",
      exists: true,
      is_empty: false,
    });
    vi.spyOn(memory, "userFacingFoldersEmpty").mockResolvedValue(false);
    // gitCheck always returns available so we don't render the
    // "install git" branch.
    vi.spyOn(gitLib, "gitCheck").mockResolvedValue({
      available: true,
      path: "/usr/bin/git",
      version: "git version 2.44.0",
      install_url: "",
    });

    render(
      <MemoryRouter>
        <OnboardingTeamRoute />
      </MemoryRouter>,
    );

    // After the effect runs the user should land in solo mode silently.
    await waitFor(() => {
      const cfg = useStore.getState().ui.memoryConfig;
      expect(cfg.mode).toBe("solo");
    });
  });

  it("Onboarding skips when memoryConfig.mode already set (returning user)", async () => {
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        memoryConfig: { ...s.ui.memoryConfig, mode: "team" },
      },
    }));
    vi.spyOn(gitLib, "gitCheck").mockResolvedValue({
      available: true,
      path: "/usr/bin/git",
      version: "git version 2.44.0",
      install_url: "",
    });
    // The disk check should not be reached — the mode-set branch fires
    // first. We still mock so a stray call doesn't NPE.
    const folderSpy = vi
      .spyOn(memory, "userFacingFoldersEmpty")
      .mockResolvedValue(false);

    // Mount inside a Routes config so navigate("/") actually
    // unmounts the OnboardingTeamRoute and renders the / landing.
    // Without this the navigate() call is a no-op and the picker DOM
    // stays around even though the effect did fire.
    // v1.19.3: prod nav target moved from /today (legacy redirect) to
    // / (canonical single canvas).
    render(
      <MemoryRouter initialEntries={["/onboarding-team"]}>
        <Routes>
          <Route path="/onboarding-team" element={<OnboardingTeamRoute />} />
          <Route path="/" element={<div>today landing</div>} />
        </Routes>
      </MemoryRouter>,
    );

    // After the effect fires, the navigate kicks us to /today. The
    // landing's text appears and the picker disappears.
    await waitFor(() => {
      expect(screen.getByText(/today landing/i)).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/Where will your team's memory live/i),
    ).not.toBeInTheDocument();
    expect(folderSpy).not.toHaveBeenCalled();
  });

  it("Onboarding picker still renders for net-new user with empty dir", async () => {
    vi.spyOn(tauri, "resolveMemoryRoot").mockResolvedValue({
      path: "/fake/memory",
      exists: true,
      is_empty: false,
    });
    vi.spyOn(memory, "userFacingFoldersEmpty").mockResolvedValue(true);
    vi.spyOn(gitLib, "gitCheck").mockResolvedValue({
      available: true,
      path: "/usr/bin/git",
      version: "git version 2.44.0",
      install_url: "",
    });

    render(
      <MemoryRouter>
        <OnboardingTeamRoute />
      </MemoryRouter>,
    );

    // Net-new user → picker renders.
    await waitFor(() => {
      expect(
        screen.getByText(/Where will your team's memory live/i),
      ).toBeInTheDocument();
    });
    // mode hasn't been mutated.
    expect(useStore.getState().ui.memoryConfig.mode).toBeUndefined();
  });
});
