/**
 * sampling-bridge.ts — v1.9 Wave 4-A real MCP sampling channel.
 *
 * When this MCP server is spawned by the user's editor (Cursor / Claude Code)
 * AND Tangerine's desktop app is running, we open a persistent ws connection
 * to `ws://127.0.0.1:<port>/sampler` and register ourselves under a `tool_id`
 * so Tangerine's session-borrower (`agi::session_borrower`) can reverse-call
 * the editor's LLM via the MCP `sampling/createMessage` request.
 *
 * Lifecycle:
 *   1. Boot: env-var TANGERINE_SAMPLING_BRIDGE=1 turns this on.
 *      TANGERINE_MCP_TOOL_ID names the tool (default = "cursor"; set to
 *      "claude-code" / "codex" / "windsurf" via the editor's mcp config).
 *   2. Discover Tangerine's bound port from `<app_data_dir>/.tangerine-port`
 *      (best effort), else default 7780. Walk 7780..=7790 if missing.
 *   3. Open ws to /sampler. Send `register_sampler` as the first frame.
 *   4. On every inbound `sample` frame: call `server.createMessage(...)`
 *      with the prompts; emit `sample_response` carrying the host's reply.
 *   5. On disconnect: reconnect with exponential backoff (1s → 30s).
 *
 * If the bridge can't reach Tangerine (app not running) we log to stderr
 * and back off; this is non-fatal — the MCP server keeps serving its normal
 * tools/resources to the editor regardless.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/** Frame Tangerine sends asking us to sample. Mirrors Rust `SampleRequestFrame`. */
interface SampleRequestFrame {
  op: "sample";
  request_id: string;
  system_prompt: string;
  user_prompt: string;
  max_tokens?: number | null;
  temperature?: number | null;
}

/** Frame we send back. Mirrors Rust `SampleResponseFrame`. */
interface SampleResponseFrame {
  op: "sample_response";
  request_id: string;
  ok: boolean;
  text?: string;
  error?: string;
}

/** First frame we send after connect. Mirrors Rust `RegisterSamplerFrame`. */
interface RegisterSamplerFrame {
  op: "register_sampler";
  tool_id: string;
}

/** Tunables. Override only via env vars (no plumbing — this is dev-time stuff). */
const RECONNECT_INITIAL_MS = Number(
  process.env.TANGERINE_SAMPLING_RECONNECT_MS ?? 1000,
);
const RECONNECT_MAX_MS = 30_000;
const HOST_REQUEST_TIMEOUT_MS = Number(
  process.env.TANGERINE_SAMPLING_HOST_TIMEOUT_MS ?? 30_000,
);

/**
 * Discover the bound port for Tangerine's localhost ws server. Returns the
 * default 7780 if no dropfile is found — the server's first attempt will
 * land on 7780 in 99 % of cases.
 */
export function discoverTangerinePort(): number {
  // Mirrors `app/src-tauri/src/main.rs` writing `.tangerine-port` under
  // `app_data_dir`. We can't easily resolve `app_data_dir` from here (it's
  // platform-specific Tauri internal), so we default and let the caller
  // override via `TANGERINE_PORT`.
  const fromEnv = Number(process.env.TANGERINE_PORT ?? "");
  if (Number.isFinite(fromEnv) && fromEnv >= 1 && fromEnv <= 65535) {
    return fromEnv;
  }

  // Best-effort: read the dropfile if it exists at a few common locations.
  const candidates = [
    path.join(os.homedir(), ".tangerine-port"),
    // Tauri's app_data_dir on Windows: %APPDATA%/com.tangerine.meeting/.tangerine-port
    process.env.APPDATA
      ? path.join(process.env.APPDATA, "com.tangerine.meeting", ".tangerine-port")
      : null,
    // macOS: ~/Library/Application Support/com.tangerine.meeting/.tangerine-port
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "com.tangerine.meeting",
      ".tangerine-port",
    ),
    // Linux XDG: ~/.local/share/com.tangerine.meeting/.tangerine-port
    path.join(
      os.homedir(),
      ".local",
      "share",
      "com.tangerine.meeting",
      ".tangerine-port",
    ),
  ].filter((p): p is string => p !== null);

  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf8").trim();
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 1 && n <= 65535) return n;
    } catch {
      /* ignore */
    }
  }
  return 7780;
}

/** True if the bridge should run (env opt-in). */
export function isBridgeEnabled(): boolean {
  const v = process.env.TANGERINE_SAMPLING_BRIDGE;
  return v === "1" || v === "true" || v === "yes";
}

/** Resolve the tool_id we identify as. Default "cursor" for back-compat. */
export function resolveToolId(): string {
  const v = (process.env.TANGERINE_MCP_TOOL_ID ?? "cursor").trim();
  return v.length > 0 ? v : "cursor";
}

/** Stable URL we reconnect to. */
function tangerineSamplerUrl(): string {
  const port = discoverTangerinePort();
  return `ws://127.0.0.1:${port}/sampler`;
}

/**
 * Run the bridge. Spawns a self-managing reconnect loop; returns a stop
 * function. Non-blocking — the caller can keep serving stdio MCP traffic.
 *
 * `server` is the Server instance from server.ts; we use its
 * `server.createMessage(...)` to ask the host (Cursor / Claude Code) for a
 * sample.
 */
export function startSamplingBridge(server: Server): () => void {
  if (!isBridgeEnabled()) {
    return () => {
      /* no-op */
    };
  }
  const tool_id = resolveToolId();
  let stopped = false;
  let backoff = RECONNECT_INITIAL_MS;
  let activeWs: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const log = (msg: string) =>
    process.stderr.write(`[tangerine-mcp][sampler] ${msg}\n`);

  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const delay = Math.min(backoff, RECONNECT_MAX_MS);
    log(`reconnect in ${delay}ms`);
    reconnectTimer = setTimeout(() => {
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      connect();
    }, delay);
  }

  function resetBackoff() {
    backoff = RECONNECT_INITIAL_MS;
  }

  function connect() {
    if (stopped) return;
    const url = tangerineSamplerUrl();
    log(`connecting to ${url} as tool_id=${tool_id}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      log(`connect threw: ${(err as Error).message}`);
      scheduleReconnect();
      return;
    }
    activeWs = ws;

    ws.on("open", () => {
      resetBackoff();
      const reg: RegisterSamplerFrame = { op: "register_sampler", tool_id };
      try {
        ws.send(JSON.stringify(reg));
        log(`registered as ${tool_id}`);
      } catch (err) {
        log(`registration send err: ${(err as Error).message}`);
        ws.terminate();
      }
    });

    ws.on("message", async (raw) => {
      let frame: SampleRequestFrame | { op: string };
      try {
        frame = JSON.parse(raw.toString());
      } catch (err) {
        log(`bad inbound JSON: ${(err as Error).message}`);
        return;
      }
      if ("op" in frame && frame.op === "sample") {
        const req = frame as SampleRequestFrame;
        await handleSampleRequest(server, ws, req, log);
      } else if ("op" in frame && frame.op === "register_sampler.ack") {
        // Tangerine acknowledged registration. Nothing to do.
      } else {
        // Ignore unknown ops for forward compat.
      }
    });

    ws.on("close", (code, reason) => {
      log(`closed code=${code} reason=${reason?.toString() ?? ""}`);
      activeWs = null;
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      log(`error: ${err.message}`);
      // 'close' will fire next; let it drive the reconnect.
    });
  }

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (activeWs) {
      try {
        activeWs.close();
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * Handle one sample request: call `server.createMessage(...)` and post back
 * the result. Errors get marshalled into `sample_response` with `ok=false`
 * so Tangerine sees a real reason rather than a hung wait.
 */
async function handleSampleRequest(
  server: Server,
  ws: WebSocket,
  req: SampleRequestFrame,
  log: (msg: string) => void,
): Promise<void> {
  const reply = (frame: SampleResponseFrame) => {
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      log(`reply send err: ${(err as Error).message}`);
    }
  };
  try {
    const params = buildCreateMessageParams(req);
    // The MCP SDK enforces a `sampling/createMessage` request to the host.
    // The host (Cursor / Claude Code) runs the user's primary LLM and
    // returns the content block(s). Defaults: maxTokens=1000 if missing
    // because the MCP spec requires it.
    const result = await Promise.race([
      server.createMessage(params),
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new Error(`host createMessage timeout after ${HOST_REQUEST_TIMEOUT_MS}ms`)),
          HOST_REQUEST_TIMEOUT_MS,
        ),
      ),
    ]);
    const text = extractText(result);
    reply({
      op: "sample_response",
      request_id: req.request_id,
      ok: true,
      text,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`createMessage failed for request_id=${req.request_id}: ${msg}`);
    reply({
      op: "sample_response",
      request_id: req.request_id,
      ok: false,
      error: msg,
    });
  }
}

/**
 * Translate Tangerine's `LlmRequest`-shaped frame into the MCP SDK's
 * `CreateMessageRequestParamsBase`.
 *
 * Defaults:
 *   * maxTokens: 1000 (MCP spec requires it; Tangerine's default of 2000
 *     is honoured if provided)
 *   * model preferences: pass none — the host picks.
 *   * temperature: passed through if provided.
 */
function buildCreateMessageParams(req: SampleRequestFrame) {
  const messages = [
    {
      role: "user" as const,
      content: { type: "text" as const, text: req.user_prompt },
    },
  ];
  const out: {
    messages: typeof messages;
    maxTokens: number;
    systemPrompt?: string;
    temperature?: number;
  } = {
    messages,
    maxTokens: req.max_tokens && req.max_tokens > 0 ? req.max_tokens : 1000,
  };
  if (req.system_prompt && req.system_prompt.length > 0) {
    out.systemPrompt = req.system_prompt;
  }
  if (typeof req.temperature === "number" && Number.isFinite(req.temperature)) {
    out.temperature = req.temperature;
  }
  return out;
}

/**
 * Extract a single string from the host's createMessage result. The MCP SDK
 * returns either `CreateMessageResult` (single content block) or
 * `CreateMessageResultWithTools` (array). We concatenate text blocks; non-text
 * blocks (tool calls in this codepath) become a fallback string.
 */
function extractText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as { content?: unknown };
  if (!r.content) return "";
  // Single block (CreateMessageResult).
  if (!Array.isArray(r.content)) {
    const block = r.content as { type?: string; text?: string };
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
    return JSON.stringify(block);
  }
  // Array (CreateMessageResultWithTools). Concatenate text blocks; mention
  // any tool_use blocks so Tangerine can see they happened.
  const parts: string[] = [];
  for (const block of r.content as Array<{ type?: string; text?: string; name?: string }>) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      parts.push(`[tool_use ${block.name ?? "?"}]`);
    }
  }
  return parts.join("");
}

// Test seam: re-export internals so unit tests can validate buildCreateMessageParams +
// extractText without spinning up a real ws.
export const __testables = {
  buildCreateMessageParams,
  extractText,
  discoverTangerinePort,
  isBridgeEnabled,
  resolveToolId,
};
