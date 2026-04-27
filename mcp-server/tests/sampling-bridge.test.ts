/**
 * Tests for `sampling-bridge.ts`. We exercise the pure helpers (param
 * builder, text extractor, env-var gates) directly — wiring up a real ws
 * server + a fake MCP host is out of scope for unit tests; integration
 * coverage lives in the manual verification described in
 * `mcp-server/README.md` and the Rust-side tests in
 * `app/src-tauri/src/agi/sampling_bridge.rs::tests`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { __testables } from "../src/sampling-bridge.js";

const { buildCreateMessageParams, extractText, isBridgeEnabled, resolveToolId } =
  __testables;

describe("sampling-bridge: env-var gates", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.TANGERINE_SAMPLING_BRIDGE;
    delete process.env.TANGERINE_MCP_TOOL_ID;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("isBridgeEnabled defaults to false", () => {
    expect(isBridgeEnabled()).toBe(false);
  });

  it("isBridgeEnabled accepts 1 / true / yes", () => {
    process.env.TANGERINE_SAMPLING_BRIDGE = "1";
    expect(isBridgeEnabled()).toBe(true);
    process.env.TANGERINE_SAMPLING_BRIDGE = "true";
    expect(isBridgeEnabled()).toBe(true);
    process.env.TANGERINE_SAMPLING_BRIDGE = "yes";
    expect(isBridgeEnabled()).toBe(true);
  });

  it("isBridgeEnabled rejects junk values", () => {
    process.env.TANGERINE_SAMPLING_BRIDGE = "0";
    expect(isBridgeEnabled()).toBe(false);
    process.env.TANGERINE_SAMPLING_BRIDGE = "no";
    expect(isBridgeEnabled()).toBe(false);
    process.env.TANGERINE_SAMPLING_BRIDGE = "";
    expect(isBridgeEnabled()).toBe(false);
  });

  it("resolveToolId defaults to cursor", () => {
    expect(resolveToolId()).toBe("cursor");
  });

  it("resolveToolId honours explicit env override", () => {
    process.env.TANGERINE_MCP_TOOL_ID = "claude-code";
    expect(resolveToolId()).toBe("claude-code");
    process.env.TANGERINE_MCP_TOOL_ID = "  windsurf  ";
    expect(resolveToolId()).toBe("windsurf");
  });

  it("resolveToolId falls back to cursor on empty", () => {
    process.env.TANGERINE_MCP_TOOL_ID = "";
    expect(resolveToolId()).toBe("cursor");
    process.env.TANGERINE_MCP_TOOL_ID = "   ";
    expect(resolveToolId()).toBe("cursor");
  });
});

describe("sampling-bridge: buildCreateMessageParams", () => {
  it("packs user_prompt as a single user text message", () => {
    const params = buildCreateMessageParams({
      op: "sample",
      request_id: "abc",
      system_prompt: "",
      user_prompt: "what shipped last week?",
    });
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].role).toBe("user");
    expect(params.messages[0].content).toEqual({
      type: "text",
      text: "what shipped last week?",
    });
  });

  it("includes systemPrompt only when non-empty", () => {
    const empty = buildCreateMessageParams({
      op: "sample",
      request_id: "abc",
      system_prompt: "",
      user_prompt: "x",
    });
    expect(empty.systemPrompt).toBeUndefined();

    const withSys = buildCreateMessageParams({
      op: "sample",
      request_id: "abc",
      system_prompt: "You are Tangerine.",
      user_prompt: "x",
    });
    expect(withSys.systemPrompt).toBe("You are Tangerine.");
  });

  it("respects max_tokens when provided", () => {
    const p = buildCreateMessageParams({
      op: "sample",
      request_id: "abc",
      system_prompt: "",
      user_prompt: "x",
      max_tokens: 4096,
    });
    expect(p.maxTokens).toBe(4096);
  });

  it("falls back to 1000 when max_tokens missing or 0", () => {
    const a = buildCreateMessageParams({
      op: "sample",
      request_id: "abc",
      system_prompt: "",
      user_prompt: "x",
    });
    expect(a.maxTokens).toBe(1000);
    const b = buildCreateMessageParams({
      op: "sample",
      request_id: "abc",
      system_prompt: "",
      user_prompt: "x",
      max_tokens: 0,
    });
    expect(b.maxTokens).toBe(1000);
  });

  it("includes temperature only when finite", () => {
    const a = buildCreateMessageParams({
      op: "sample",
      request_id: "abc",
      system_prompt: "",
      user_prompt: "x",
    });
    expect(a.temperature).toBeUndefined();

    const b = buildCreateMessageParams({
      op: "sample",
      request_id: "abc",
      system_prompt: "",
      user_prompt: "x",
      temperature: 0.4,
    });
    expect(b.temperature).toBe(0.4);
  });
});

describe("sampling-bridge: extractText", () => {
  it("returns text directly from a single text block", () => {
    const result = { content: { type: "text", text: "borrowed answer" } };
    expect(extractText(result)).toBe("borrowed answer");
  });

  it("concatenates text blocks from an array result", () => {
    const result = {
      content: [
        { type: "text", text: "part one. " },
        { type: "text", text: "part two." },
      ],
    };
    expect(extractText(result)).toBe("part one. part two.");
  });

  it("annotates tool_use blocks", () => {
    const result = {
      content: [
        { type: "text", text: "before " },
        { type: "tool_use", name: "search" },
        { type: "text", text: " after" },
      ],
    };
    expect(extractText(result)).toBe("before [tool_use search] after");
  });

  it("returns empty string for nullish / shapeless input", () => {
    expect(extractText(null)).toBe("");
    expect(extractText(undefined)).toBe("");
    expect(extractText({})).toBe("");
    expect(extractText({ content: undefined })).toBe("");
  });
});
