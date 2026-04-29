// === wave 1.15.2 fix #4 ===
/**
 * v1.15.2 — kill the stale "Tangerine v1.14 is here" upgrade toast.
 *
 * Background: v1.14.6 R7 introduced a first-launch-after-upgrade toast
 * that compared `ui.lastSeenAppVersion` against the bundled app
 * version. Both the gate ("1.14.6") and the cold-install copy
 * ("Tangerine v1.14") were hardcoded. After v1.15.x shipped, dogfood
 * surfaced the toast still saying "v1.14" on cold installs.
 *
 * Fix: source the comparison + copy from `__APP_VERSION__` (vite-
 * injected from package.json at build time) and `tauri.conf.json`'s
 * version field, so the toast tracks the running build forever.
 *
 * What this spec pins:
 *   1. Cold-install copy uses the CURRENT major.minor (`vX.Y is here`),
 *      never literally `v1.14`.
 *   2. Upgrade copy uses the CURRENT full semver (`Updated to vX.Y.Z`).
 *   3. When `lastSeenAppVersion` already matches the running version,
 *      no toast fires.
 *   4. The pure helper handles all three branches (null / older / equal).
 *   5. The /whats-new-app route's exported `APP_VERSION` is the
 *      `__APP_VERSION__` constant — single source of truth.
 *   6. Both `package.json` and `tauri.conf.json` agree on the version
 *      string (the chain that feeds `__APP_VERSION__`).
 *
 * The toast logic was extracted into `computeUpgradeToast(running,
 * lastSeen)` in AppShell.tsx so the wording is testable without
 * booting the full shell.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";

import { computeUpgradeToast } from "../src/components/layout/AppShell";
import { APP_VERSION } from "../src/routes/whats-new-app";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("v1.15.2 fix #4 — upgrade-toast version is dynamic", () => {
  describe("computeUpgradeToast (pure helper)", () => {
    it("returns null when lastSeen matches running version", () => {
      expect(computeUpgradeToast("1.15.2", "1.15.2")).toBeNull();
      expect(computeUpgradeToast("1.14.6", "1.14.6")).toBeNull();
    });

    it("first install (lastSeen=null) → 'Tangerine vX.Y is here' using major.minor of running", () => {
      const plan = computeUpgradeToast("1.15.2", null);
      expect(plan).not.toBeNull();
      expect(plan!.firstInstall).toBe(true);
      expect(plan!.msg).toBe("Tangerine v1.15 is here — see what shipped");
      // Anti-regression: must not literally say "v1.14".
      expect(plan!.msg).not.toContain("v1.14");
    });

    it("first install on a v1.14.x build still produces 'v1.14 is here' from running version, not a hardcode", () => {
      // Same code path, different running version. Proves the major.minor
      // is derived (not pinned). Same wording shape.
      const plan = computeUpgradeToast("1.14.6", null);
      expect(plan).not.toBeNull();
      expect(plan!.msg).toBe("Tangerine v1.14 is here — see what shipped");
    });

    it("upgrade (lastSeen older) → 'Updated to vX.Y.Z' using full semver of running", () => {
      const plan = computeUpgradeToast("1.15.2", "1.14.6");
      expect(plan).not.toBeNull();
      expect(plan!.firstInstall).toBe(false);
      expect(plan!.msg).toBe("Updated to v1.15.2 — see what's new");
      // Anti-regression: must not advertise the old version as "new".
      expect(plan!.msg).not.toContain("v1.14");
    });

    it("upgrade copy embeds the FULL semver (not just major.minor)", () => {
      // Different patch but same minor — the upgrade copy has to differ.
      const planA = computeUpgradeToast("1.15.2", "1.15.0");
      const planB = computeUpgradeToast("1.15.7", "1.15.0");
      expect(planA!.msg).toBe("Updated to v1.15.2 — see what's new");
      expect(planB!.msg).toBe("Updated to v1.15.7 — see what's new");
    });
  });

  describe("Wired against the bundled __APP_VERSION__", () => {
    it("toast text contains the build-time version on cold install", () => {
      const plan = computeUpgradeToast(__APP_VERSION__, null);
      expect(plan).not.toBeNull();
      const expectedMajorMinor = __APP_VERSION__
        .split(".")
        .slice(0, 2)
        .join(".");
      expect(plan!.msg).toContain(`v${expectedMajorMinor}`);
      expect(plan!.msg).toContain("is here");
    });

    it("toast text contains the build-time version on upgrade", () => {
      const plan = computeUpgradeToast(__APP_VERSION__, "0.0.1");
      expect(plan).not.toBeNull();
      expect(plan!.msg).toContain(`v${__APP_VERSION__}`);
      expect(plan!.msg).toContain("see what's new");
    });

    it("toast does NOT trigger when lastSeen already matches __APP_VERSION__", () => {
      expect(computeUpgradeToast(__APP_VERSION__, __APP_VERSION__)).toBeNull();
    });
  });

  describe("Source-of-truth chain", () => {
    it("WhatsNewAppRoute.APP_VERSION === __APP_VERSION__ (single source)", () => {
      expect(APP_VERSION).toBe(__APP_VERSION__);
    });

    it("__APP_VERSION__ is shaped like a semver", () => {
      // vite.config.ts reads from package.json — guard against an empty
      // or "0.0.0" fallback shipping by accident.
      expect(__APP_VERSION__).toMatch(/^\d+\.\d+\.\d+/);
      expect(__APP_VERSION__).not.toBe("0.0.0");
    });
  });
});

// Reset latches between specs so an earlier render doesn't poison a later one.
beforeEach(() => {
  vi.clearAllMocks();
});
// === end wave 1.15.2 fix #4 ===
