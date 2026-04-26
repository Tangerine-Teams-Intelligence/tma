/**
 * server.ts — MCP server setup using @modelcontextprotocol/sdk.
 *
 * Wires together:
 *   - tools/list, tools/call          (query_team_memory)
 *   - resources/list, resources/read  (team-memory://)
 *
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
  QUERY_TOOL_DEFINITION,
  QUERY_TOOL_NAME,
  runQueryTeamMemory,
  type QueryArgs,
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
    return { tools: [QUERY_TOOL_DEFINITION] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== QUERY_TOOL_NAME) {
      return {
        isError: true,
        content: [
          { type: "text", text: `Unknown tool: ${req.params.name}` },
        ],
      };
    }
    const args = (req.params.arguments ?? {}) as Partial<QueryArgs>;
    if (typeof args.query !== "string" || args.query.trim().length === 0) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "query_team_memory requires a non-empty 'query' string.",
          },
        ],
      };
    }
    const result = await runQueryTeamMemory(root, {
      query: args.query,
      limit: args.limit,
    });
    return {
      content: [
        { type: "text", text: JSON.stringify(result, null, 2) },
      ],
    };
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
