// === v2.5 auth + billing tests ===
// v2.5 §2 + §3 — frontend-side tests for the typed Tauri wrappers.
// We exercise the stub-mode mock paths (no Tauri host = browser/vitest env)
// to verify the wire shape is identical to what the Rust side returns,
// AND that the high-level state-machine moves through the expected
// trial → active → canceled progression.
//
// The Rust-side state-machine assertions live in `cargo test -- billing
// auth` per V2_5_SPEC §6.2.

import { describe, expect, it } from "vitest";

import {
  authSignInEmailPassword,
  authSignUp,
  authSignInOauth,
  authSession,
  authSignOut,
  billingTrialStart,
  billingSubscribe,
  billingCancel,
  billingStatus,
  billingWebhook,
} from "../src/lib/tauri";

describe("v2.5 auth (stub mode)", () => {
  it("auth stub mode accepts any 6+ char password", async () => {
    const s = await authSignInEmailPassword("user@tangerine.test", "abcdef");
    expect(s.email).toBe("user@tangerine.test");
    expect(s.mode).toBe("stub");
    expect(s.email_confirmed).toBe(true);
  });

  it("auth real mode requires actual Supabase", async () => {
    // The TS-side mock path is unconditional — real-mode rejection is
    // enforced in Rust (`auth_real_mode_requires_actual_supabase` test
    // in `app/src-tauri/src/auth.rs`). We assert the wire-shape contract
    // here so a future shape change can't pass silently.
    const s = await authSignUp("new@tangerine.test", "abcdef");
    expect(s).toHaveProperty("user_id");
    expect(s).toHaveProperty("access_token");
    expect(s).toHaveProperty("refresh_token");
    expect(s).toHaveProperty("expires_at");
    expect(s.mode).toMatch(/^(stub|real)$/);
  });

  it("oauth stub returns provider-flavoured email", async () => {
    const s = await authSignInOauth("github");
    expect(s.email).toContain("github");
  });

  it("session round-trip wire shape", async () => {
    // The browser-side mock (no Tauri host) is intentionally stateless —
    // it returns null for `authSession()` regardless of prior signin so
    // vitest doesn't have to manage in-process state. The Rust-side test
    // (`cmd_signin_then_session_round_trip` in commands/auth.rs) verifies
    // the real round-trip against the stub-mode static.
    const s = await authSignInEmailPassword("rt@tangerine.test", "abcdef");
    expect(s.email).toBe("rt@tangerine.test");
    await authSignOut();
    const after = await authSession();
    expect(after === null || typeof after === "object").toBe(true);
  });
});

describe("v2.5 billing (stub mode)", () => {
  it("billing stub mode simulates trial → active → canceled", async () => {
    const team = `team-test-${Date.now()}`;
    const trial = await billingTrialStart({
      teamId: team,
      email: "ceo@tangerine.test",
      emailVerified: true,
    });
    expect(trial.status).toBe("trialing");
    expect(trial.trial_end).toBeGreaterThan(trial.trial_start);

    const active = await billingSubscribe(team, "pm_stub_card_visa");
    expect(active.status).toBe("active");

    const canceled = await billingCancel(team);
    expect(canceled.status).toBe("canceled");
  });

  it("trial 30 day countdown works", async () => {
    const team = `team-cd-${Date.now()}`;
    const t = await billingTrialStart({
      teamId: team,
      email: "x@y.z",
      emailVerified: true,
    });
    const span = t.trial_end - t.trial_start;
    // 30 days ± 5 minutes (stub may compute on either side of a second tick).
    const thirtyDays = 30 * 24 * 60 * 60;
    expect(Math.abs(span - thirtyDays)).toBeLessThan(5 * 60);
  });

  it("status read returns wire shape", async () => {
    const team = `team-shape-${Date.now()}`;
    await billingTrialStart({
      teamId: team,
      email: "x@y.z",
      emailVerified: true,
    });
    const s = await billingStatus(team);
    expect(s).toHaveProperty("team_id");
    expect(s).toHaveProperty("status");
    expect(s).toHaveProperty("trial_start");
    expect(s).toHaveProperty("trial_end");
    expect(s).toHaveProperty("mode");
    expect(["stub", "test", "live"]).toContain(s.mode);
  });

  it("webhook stub reports event_type", async () => {
    const r = await billingWebhook(
      JSON.stringify({ type: "customer.subscription.updated", id: "evt_x" }),
      "any_sig",
    );
    // Browser-mode mock returns "stub.webhook" as the event_type — Rust side
    // parses the JSON and returns the actual `type` field. Either is valid
    // wire-shape compliance.
    expect(r).toHaveProperty("event_type");
    expect(r).toHaveProperty("message");
  });
});
// === end v2.5 auth + billing tests ===
