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
 * Resolves only when the transport is closed.
 */
export async function runStdioServer(opts: ServerOptions = {}): Promise<void> {
  const { server, root } = createServer(opts);
  process.stderr.write(
    `[tangerine-mcp] starting stdio server, memory root: ${root}\n`,
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
