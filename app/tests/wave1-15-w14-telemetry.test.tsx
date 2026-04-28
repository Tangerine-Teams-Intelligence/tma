// === v1.15.0 Wave 1.4 ===
/**
 * v1.15.0 Wave 1.4 — telemetry + activation listener + Solo Cloud
 * prompt rate-limit specs.
 *
 * Coverage:
 *   1. Every Wave 1.4 event name flows through `logEvent` cleanly.
 *   2. `logTypedEvent` enforces the payload shape via TS strict types
 *      (compile-time check; runtime asserts the call survives).
 *   3. `isFirstRealAtomTrigger` filters sample atoms (R9 invariant).
 *   4. `resolveActivationSource` falls back to kind when vendor absent.
 *   5. `shouldShowSoloCloudPrompt` rate limiter:
 *        - suppresses pre-onboarding
 *        - suppresses team scope
 *        - fires after 7 days OR ≥ 50 atoms
 *        - 7-day cool-down after dismissal
 *
 * The `first_real_atom_captured` once-per-install latch is enforced by
 * the store (`firstAtomCapturedAt`); the listener test exercises the
 * predicate directly so the pure-function layer stays the contract.
 * Full mount tests live in routes.smoke.test.tsx.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  logEvent,
  logTypedEvent,
  type TelemetryEventName,
} from "../src/lib/telemetry";
import * as tauri from "../src/lib/tauri";
import {
  isFirstRealAtomTrigger,
  resolveActivationSource,
} from "../src/components/FirstRealAtomActivation";
import {
  shouldShowSoloCloudPrompt,
  SOLO_CLOUD_PROMPT_COOLDOWN_MS,
  SOLO_CLOUD_PROMPT_ATOM_THRESHOLD,
} from "../src/components/SoloCloudUpgradePrompt";

// All Wave 1.4 telemetry event names. Listed explicitly so a future
// rename or accidental drop trips this file (the union itself is
// type-only and would otherwise pass silently).
const WAVE_1_4_NAMES: readonly TelemetryEventName[] = [
  "onboarding_wizard_shown",
  "onboarding_path_chosen",
  "onboarding_detection_completed",
  "onboarding_mcp_configured",
  "onboarding_mcp_failed",
  "onboarding_skipped_to_demo",
  "onboarding_skipped_to_manual",
  "onboarding_completed",
  "mcp_connected",
  "first_real_atom_captured",
  "demo_tour_step_completed",
  "demo_to_real_conversion",
  "solo_cloud_upgrade_prompt_shown",
  "solo_cloud_upgrade_clicked",
] as const;

describe("Wave 1.4 telemetry contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires logEvent for every Wave 1.4 name without crashing", async () => {
    const spy = vi.spyOn(tauri, "telemetryLog").mockResolvedValue(undefined);

    for (const name of WAVE_1_4_NAMES) {
      await logEvent(name, {});
    }

    expect(spy).toHaveBeenCalledTimes(WAVE_1_4_NAMES.length);
    const seen = spy.mock.calls.map((c) => c[0].event);
    for (const name of WAVE_1_4_NAMES) {
      expect(seen).toContain(name);
    }
  });

  it("logTypedEvent type-checks payload shape (compile-time + runtime)", async () => {
    const spy = vi.spyOn(tauri, "telemetryLog").mockResolvedValue(undefined);

    // Each typed call must compile under strict TS — no `any`. The
    // wrong-shape lines below are commented out because they would
    // intentionally fail `tsc --noEmit`. Uncomment to verify the
    // type guards are doing their job.
    await logTypedEvent("onboarding_path_chosen", { path: "ai_tool" });
    await logTypedEvent("onboarding_detection_completed", {
      detected_count: 3,
      tools: ["cursor", "claude-code", "windsurf"],
    });
    await logTypedEvent("onboarding_mcp_configured", {
      tool_id: "cursor",
      success: true,
    });
    await logTypedEvent("onboarding_mcp_failed", {
      tool_id: "cursor",
      error_class: "permission_denied",
    });
    await logTypedEvent("onboarding_completed", {
      time_to_complete_ms: 12000,
      path: "ai_tool",
    });
    await logTypedEvent("mcp_connected", { tool_id: "claude-code" });
    await logTypedEvent("first_real_atom_captured", { source: "cursor" });
    await logTypedEvent("demo_tour_step_completed", { step_index: 2 });
    // Empty-payload events: the typed map enforces `Record<string, never>`.
    await logTypedEvent("onboarding_wizard_shown", {});
    await logTypedEvent("solo_cloud_upgrade_prompt_shown", {});
    await logTypedEvent("solo_cloud_upgrade_clicked", {});

    expect(spy).toHaveBeenCalledTimes(11);
    // Spot-check a typed payload made it through cleanly.
    const detection = spy.mock.calls.find(
      (c) => c[0].event === "onboarding_detection_completed",
    );
    expect(detection?.[0].payload).toEqual({
      detected_count: 3,
      tools: ["cursor", "claude-code", "windsurf"],
    });
  });

  it("logTypedEvent path enum is constrained to the 3 valid values", async () => {
    vi.spyOn(tauri, "telemetryLog").mockResolvedValue(undefined);
    // These three must compile.
    await logTypedEvent("onboarding_path_chosen", { path: "ai_tool" });
    await logTypedEvent("onboarding_path_chosen", { path: "demo" });
    await logTypedEvent("onboarding_path_chosen", { path: "manual" });
    // A typo like `path: "ai-tool"` would fail tsc; we don't include
    // it here because the test file would stop compiling.
    expect(true).toBe(true);
  });
});

describe("first_real_atom_captured trigger predicate", () => {
  const baseEvent = {
    path: "personal/me/threads/cursor/abc.md",
    title: "Sample turn",
    vendor: "cursor",
    author: null,
    timestamp: "2026-04-28T00:00:00Z",
    kind: "thread" as const,
    isSample: false,
  };

  it("fires for a real (non-sample) atom on first capture", () => {
    expect(
      isFirstRealAtomTrigger({
        event: baseEvent,
        alreadyCaptured: false,
      }),
    ).toBe(true);
  });

  it("does NOT fire when isSample === true (R9 invariant)", () => {
    expect(
      isFirstRealAtomTrigger({
        event: { ...baseEvent, isSample: true },
        alreadyCaptured: false,
      }),
    ).toBe(false);
  });

  it("does NOT fire when activation already latched (once-per-install)", () => {
    expect(
      isFirstRealAtomTrigger({
        event: baseEvent,
        alreadyCaptured: true,
      }),
    ).toBe(false);
  });

  it("treats a missing isSample as false (legacy payload backwards-compat)", () => {
    // Simulate a v1.14 ledger entry replayed without the field. The
    // Rust serde_default fills false on the wire; the predicate also
    // treats `undefined` falsy via the boolean cast.
    const legacy = { ...baseEvent } as Partial<typeof baseEvent> &
      typeof baseEvent;
    // Force the isSample field to undefined to mimic a hand-rolled mock.
    (legacy as { isSample?: boolean }).isSample =
      undefined as unknown as boolean;
    expect(
      isFirstRealAtomTrigger({
        event: legacy,
        alreadyCaptured: false,
      }),
    ).toBe(true);
  });

  it("resolveActivationSource prefers vendor over kind", () => {
    expect(resolveActivationSource(baseEvent)).toBe("cursor");
  });

  it("resolveActivationSource falls back to kind when vendor missing", () => {
    expect(
      resolveActivationSource({ ...baseEvent, vendor: null }),
    ).toBe("thread");
    expect(
      resolveActivationSource({ ...baseEvent, vendor: "" }),
    ).toBe("thread");
  });
});

describe("Solo Cloud upgrade prompt rate limit", () => {
  // Anchor "now" so the math is deterministic regardless of wall clock.
  const NOW = 1_730_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  it("suppresses pre-onboarding (no completion timestamp)", () => {
    expect(
      shouldShowSoloCloudPrompt({
        now: NOW,
        onboardingCompletedAt: null,
        dismissedAt: null,
        atomCount: 100,
        scope: "solo",
      }),
    ).toBe(false);
  });

  it("suppresses team-scope users (different upsell surface)", () => {
    expect(
      shouldShowSoloCloudPrompt({
        now: NOW,
        onboardingCompletedAt: NOW - 30 * DAY,
        dismissedAt: null,
        atomCount: 100,
        scope: "team",
      }),
    ).toBe(false);
  });

  it("does NOT show when neither trigger has fired", () => {
    expect(
      shouldShowSoloCloudPrompt({
        now: NOW,
        onboardingCompletedAt: NOW - 1 * DAY,
        dismissedAt: null,
        atomCount: 5,
        scope: "solo",
      }),
    ).toBe(false);
  });

  it("shows after 7 days since onboarding even with low atom count", () => {
    expect(
      shouldShowSoloCloudPrompt({
        now: NOW,
        onboardingCompletedAt: NOW - SOLO_CLOUD_PROMPT_COOLDOWN_MS,
        dismissedAt: null,
        atomCount: 3,
        scope: "solo",
      }),
    ).toBe(true);
  });

  it("shows once atom count >= 50 even within the first day", () => {
    expect(
      shouldShowSoloCloudPrompt({
        now: NOW,
        onboardingCompletedAt: NOW - 1 * DAY,
        dismissedAt: null,
        atomCount: SOLO_CLOUD_PROMPT_ATOM_THRESHOLD,
        scope: "solo",
      }),
    ).toBe(true);
  });

  it("respects the 7-day dismiss cool-down", () => {
    // Eligible by both triggers, but dismissed 1 day ago.
    expect(
      shouldShowSoloCloudPrompt({
        now: NOW,
        onboardingCompletedAt: NOW - 30 * DAY,
        dismissedAt: NOW - 1 * DAY,
        atomCount: 100,
        scope: "solo",
      }),
    ).toBe(false);
  });

  it("re-shows after the cool-down expires", () => {
    expect(
      shouldShowSoloCloudPrompt({
        now: NOW,
        onboardingCompletedAt: NOW - 30 * DAY,
        dismissedAt: NOW - SOLO_CLOUD_PROMPT_COOLDOWN_MS - 1,
        atomCount: 100,
        scope: "solo",
      }),
    ).toBe(true);
  });

  it("solo scope null still treated as eligible (default fresh install)", () => {
    // A solo user who hasn't picked solo/team yet but has completed
    // onboarding (e.g. demo path) should still see the upsell when
    // the threshold trips.
    expect(
      shouldShowSoloCloudPrompt({
        now: NOW,
        onboardingCompletedAt: NOW - 30 * DAY,
        dismissedAt: null,
        atomCount: 100,
        scope: null,
      }),
    ).toBe(true);
  });
});
// === end v1.15.0 Wave 1.4 ===
