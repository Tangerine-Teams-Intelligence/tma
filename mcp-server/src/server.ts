/**
 * server.ts — MCP server setup using @modelcontextprotocol/sdk.
 *
 * Wires together:
 *   - tools/list, tools/call          (7 tools — see tools.ts)
 *   - resources/list, resources/read  (team-memory://)
 *
 * Every tool response is wrapped in the AGI envelope (see envelope.ts).
 * All logging goes to stderr. Stdout is reserved for JSONRPC frames.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { resolveMemoryRoot } from "./memory.js";
import {
  ALL_TOOL_DEFINITIONS,
  TOOL_NAMES,
  runQueryTeamMemory,
  runGetTodayBrief,
  runGetMyPending,
  runGetForPerson,
  runGetForProject,
  runGetThreadState,
  runGetRecentDecisions,
} from "./tools.js";
import { listResources, readResource } from "./resources.js";
import { startSamplingBridge } from "./sampling-bridge.js";

export interface ServerOptions {
  /** Memory root override; falls back to env / ~/.tangerine-memory. */
  root?: string;
  /** Server name advertised over MCP (override in tests if needed). */
  name?: string;
  /** Server version advertised over MCP. */
  version?: string;
}

export function createServer(opts: ServerOptions = {}): {
  server: Server;
  root: string;
} {
  const root = resolveMemoryRoot(opts.root);
  const server = new Server(
    {
      name: opts.name ?? "tangerine-mcp",
      version: opts.version ?? "0.1.0",
    },
    {
      // Note: `sampling` is a *client* capability, not a server one — we
      // don't declare it. We just call `server.createMessage(...)` and the
      // SDK throws if the host (Cursor / Claude Code / Codex) didn't
      // advertise sampling support during init. Errors flow into the
      // sampling bridge's `sample_response` with `ok=false`.
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: ALL_TOOL_DEFINITIONS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const name = req.params.name;
    try {
      switch (name) {
        case TOOL_NAMES.QUERY: {
          if (typeof args.query !== "string" || args.query.trim().length === 0) {
            return errorResult(
              "query_team_memory requires a non-empty 'query' string.",
            );
          }
          const env = await runQueryTeamMemory(root, {
            query: args.query,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          });
          return jsonResult(env);
        }
        case TOOL_NAMES.TODAY_BRIEF: {
          const env = await runGetTodayBrief(root);
          return jsonResult(env);
        }
        case TOOL_NAMES.MY_PENDING: {
          if (typeof args.user !== "string" || args.user.trim().length === 0) {
            return errorResult(
              "get_my_pending requires a non-empty 'user' string.",
            );
          }
          const env = await runGetMyPending(root, args.user);
          return jsonResult(env);
        }
        case TOOL_NAMES.FOR_PERSON: {
          if (typeof args.name !== "string" || args.name.trim().length === 0) {
            return errorResult(
              "get_for_person requires a non-empty 'name' string.",
            );
          }
          const env = await runGetForPerson(root, args.name);
          return jsonResult(env);
        }
        case TOOL_NAMES.FOR_PROJECT: {
          if (typeof args.slug !== "string" || args.slug.trim().length === 0) {
            return errorResult(
              "get_for_project requires a non-empty 'slug' string.",
            );
          }
          const env = await runGetForProject(root, args.slug);
          return jsonResult(env);
        }
        case TOOL_NAMES.THREAD_STATE: {
          if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
            return errorResult(
              "get_thread_state requires a non-empty 'topic' string.",
            );
          }
          const env = await runGetThreadState(root, args.topic);
          return jsonResult(env);
        }
        case TOOL_NAMES.RECENT_DECISIONS: {
          const days = typeof args.days === "number" ? args.days : undefined;
          const env = await runGetRecentDecisions(root, days);
          return jsonResult(env);
        }
        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const msg = (err as Error).stack ?? (err as Error).message ?? String(err);
      process.stderr.write(`[tangerine-mcp] tool ${name} threw: ${msg}\n`);
      return errorResult(`Internal error in ${name}: ${(err as Error).message}`);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = await listResources(root);
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const found = await readResource(root, uri);
    if (!found) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return {
      contents: [
        {
          uri: found.uri,
          mimeType: found.mimeType,
          text: found.text,
        },
      ],
    };
  });

  return { server, root };
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

/**
 * Start a stdio MCP server. Logs the resolved memory root to stderr at startup.
 *
 * v1.9 Wave 4-A: when env var `TANGERINE_SAMPLING_BRIDGE=1` is set, also
 * opens a persistent ws connection to Tangerine's localhost server and
 * registers ourselves as a sampler so the desktop app can reverse-call the
 * host's LLM via `sampling/createMessage`. The bridge is non-fatal and
 * self-reconnecting; it never blocks stdio MCP traffic.
 *
 * Resolves only when the transport is closed.
 */
export async function runStdioServer(opts: ServerOptions = {}): Promise<void> {
  const { server, root } = createServer(opts);
  process.stderr.write(
    `[tangerine-mcp] starting stdio server, memory root: ${root}\n`,
  );
  const transport = new StdioServerTransport();
  // Start the sampling bridge alongside the stdio server. It opens its own
  // ws connection and reconnects on disconnect; if disabled (default) it's
  // a no-op. We connect AFTER `server.connect(transport)` so the host has
  // already negotiated capabilities — `server.createMessage()` requires
  // the protocol handshake to be complete.
  await server.connect(transport);
  startSamplingBridge(server);
}
