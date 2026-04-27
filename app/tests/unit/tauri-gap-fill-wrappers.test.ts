import { describe, expect, it } from "vitest";

import {
  startBot,
  stopBot,
  botStatus,
  readMeetingFile,
  watchMeeting,
  unwatchMeeting,
  writeEnvFile,
  openInEditor,
  checkUpdates,
  getWsPort,
  validateDiscordBotToken,
  billingReconcile,
  emailVerifySend,
  emailVerifyConfirm,
  emailVerifyStatus,
  getAiToolStatus,
  ssoValidateSamlResponseWithResult,
  personalAgentsAppleIntelHook,
  personalAgentsDevinWebhook,
  auditLogExport,
  auditVerifyChain,
  auditGetRegion,
  auditSetRegion,
} from "../../src/lib/tauri";

/**
 * Wave 3 cross-cut — sanity tests for the gap-fill wrappers added per
 * API_SURFACE_SPEC §3. These run outside Tauri (no `__TAURI_INTERNALS__`)
 * so every call hits the mock branch of `safeInvoke`. Goal: ensure each
 * wrapper resolves to a structurally-valid value, not a runtime crash —
 * which is the contract the spec promises every TS consumer.
 */

describe("API surface — Wave 3 gap-fill wrappers (mock fallback)", () => {
  it("bot lifecycle wrappers resolve to typed shapes", async () => {
    const start = await startBot({ meeting_id: "m-1" });
    expect(start).toEqual({ run_id: "", pid: null });

    await expect(stopBot("m-1")).resolves.toBeUndefined();

    const status = await botStatus("m-1");
    expect(status).toEqual({ pid: null, voice_channel_id: null });
  });

  it("meeting file read returns string", async () => {
    const out = await readMeetingFile({ meeting_id: "m-1", file: "transcript" });
    expect(out).toBe("");
  });

  it("watch / unwatch meeting wrappers resolve", async () => {
    const w = await watchMeeting("m-1");
    expect(w).toEqual({ watch_id: "" });
    await expect(unwatchMeeting("w-1")).resolves.toBeUndefined();
  });

  it("env / external helpers resolve", async () => {
    await expect(writeEnvFile({ FOO: "bar" })).resolves.toBeUndefined();
    await expect(openInEditor("/x", 12)).resolves.toBeUndefined();
    const upd = await checkUpdates();
    expect(upd.available).toBe(false);
    expect(upd.version).toBeNull();
    const port = await getWsPort();
    expect(port).toEqual({ port: null, endpoint: "" });
  });

  it("validateDiscordBotToken returns failure shape", async () => {
    const out = await validateDiscordBotToken("garbage");
    expect(out.ok).toBe(false);
    expect(out.error).toBeTypeOf("string");
  });

  it("billing + email-verify wrappers resolve to safe defaults", async () => {
    const r = await billingReconcile();
    expect(r.promoted_to_active).toBe(0);
    expect(r.errors).toEqual([]);

    const send = await emailVerifySend("a@b.com");
    expect(send.token).toBe("");
    expect(send.provider).toBe("stub");

    const conf = await emailVerifyConfirm("tok");
    expect(conf.verified).toBe(false);

    const stat = await emailVerifyStatus("a@b.com");
    expect(stat.email).toBe("a@b.com");
    expect(stat.verified).toBe(false);
  });

  it("ai_tools single-tool read returns null", async () => {
    const r = await getAiToolStatus("cursor");
    expect(r).toBeNull();
  });

  it("sso variant-aware result returns stub variant", async () => {
    const r = await ssoValidateSamlResponseWithResult("acme", "<saml/>");
    expect(r.variant).toBe("stub");
    expect(r.assertion).toBeNull();
    expect(r.error).toBeTypeOf("string");
  });

  it("personal_agents webhooks return PersonalAgentCaptureResult", async () => {
    const apple = await personalAgentsAppleIntelHook({
      payload: { intent: "test" },
    });
    expect(apple.source).toBe("apple-intelligence");
    expect(apple.written).toBe(0);

    const devin = await personalAgentsDevinWebhook({
      payload: { run_id: "r1" },
    });
    expect(devin.source).toBe("devin");
    expect(devin.written).toBe(0);
  });

  it("audit wave-3 wrappers resolve to safe defaults", async () => {
    expect(await auditLogExport(7)).toBe("");
    expect(await auditGetRegion()).toBe("us-east");
    await expect(auditSetRegion("eu-west")).resolves.toBeUndefined();
    const v = await auditVerifyChain(7);
    expect(v.ok).toBe(true);
    expect(v.broken_at).toBeNull();
    expect(v.checked).toBe(0);
  });
});
