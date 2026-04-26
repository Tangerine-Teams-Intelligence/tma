/**
 * tools.ts — query_team_memory tool implementation.
 */

import {
  walkMemoryRoot,
  searchMemory,
  type SearchHit,
} from "./memory.js";

export const QUERY_TOOL_NAME = "query_team_memory";

export const QUERY_TOOL_DEFINITION = {
  name: QUERY_TOOL_NAME,
  description:
    "Search Tangerine team memory (meetings, decisions, people, projects, threads, glossary) for a substring. Returns top matching markdown files with frontmatter, snippet, and content preview. Call this whenever the user asks about prior decisions, what was said in a meeting, who someone is, or anything that might be in team context.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Substring to search across all team memory markdown",
      },
      limit: {
        type: "number",
        description: "Max results to return (1-20). Default 5.",
        default: 5,
        minimum: 1,
        maximum: 20,
      },
    },
    required: ["query"],
  },
} as const;

export interface QueryArgs {
  query: string;
  limit?: number;
}

export interface QueryResult {
  query: string;
  root: string;
  searched: number;
  hits: SearchHit[];
}

/**
 * Execute the search and shape the result. Errors during walk are logged to
 * stderr by walkMemoryRoot — we always return a valid payload.
 */
export async function runQueryTeamMemory(
  root: string,
  args: QueryArgs,
): Promise<QueryResult> {
  const limit = typeof args.limit === "number" ? args.limit : 5;
  const files = await walkMemoryRoot(root);
  const hits = searchMemory(files, args.query, limit);
  return {
    query: args.query,
    root,
    searched: files.length,
    hits,
  };
}
