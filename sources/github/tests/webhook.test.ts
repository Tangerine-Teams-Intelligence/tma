// Webhook normalization — uses the same fixtures as the polling path.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { processWebhook } from "../src/ingest/webhook.js";
import { makeCtx } from "../src/normalize.js";
import { defaultConfig, type IdentityMap } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

const identity: IdentityMap = { ericfromgithub: "eric", "daizhe-z": "daizhe" };
const ctx = makeCtx("myorg/api", identity, defaultConfig());

describe("processWebhook", () => {
  it("pull_request opened → pr_opened atom", () => {
    const r = processWebhook("pull_request", fx("webhook_pr_opened.json"), ctx);
    expect(r.atoms).toHaveLength(1);
    expect(r.atoms[0].kind).toBe("pr_opened");
    expect(r.atoms[0].refs.github?.pr).toBe(47);
    expect(r.rawLogins.has("ericfromgithub")).toBe(true);
  });

  it("pull_request closed without merge → pr_closed", () => {
    const payload = fx("webhook_pr_opened.json");
    payload.action = "closed";
    payload.pull_request.closed_at = "2026-04-26T11:00:00Z";
    const r = processWebhook("pull_request", payload, ctx);
    expect(r.atoms[0].kind).toBe("pr_closed");
  });

  it("pull_request closed with merge → pr_merged", () => {
    const payload = fx("webhook_pr_opened.json");
    payload.action = "closed";
    payload.pull_request.merged_at = "2026-04-26T11:00:00Z";
    payload.pull_request.merge_commit_sha = "deadbeef1234567890";
    payload.pull_request.merged_by = { login: "ericfromgithub" };
    const r = processWebhook("pull_request", payload, ctx);
    expect(r.atoms[0].kind).toBe("pr_merged");
  });

  it("issue_comment created → comment atom (decision sniff)", () => {
    const r = processWebhook("issue_comment", fx("webhook_issue_comment.json"), ctx);
    expect(r.atoms).toHaveLength(1);
    expect(r.atoms[0].kind).toBe("decision"); // body says "we agreed/let's go with"
    expect(r.atoms[0].refs.threads).toEqual(["issue-myorg-api-88"]);
  });

  it("ignores actions we don't care about", () => {
    const r = processWebhook("pull_request", { action: "synchronize", pull_request: { number: 1 } }, ctx);
    expect(r.atoms).toHaveLength(0);
  });

  it("ignores unknown event names", () => {
    const r = processWebhook("ping", { zen: "Speak like a human." }, ctx);
    expect(r.atoms).toHaveLength(0);
  });
});
