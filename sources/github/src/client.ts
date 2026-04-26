// Thin wrapper around @octokit/core. Centralizes:
//  - PAT auth header construction
//  - User-Agent string (so GitHub can identify Tangerine traffic if needed)
//  - Optional fetch override (tests inject a mock)
//  - Rate-limit awareness via the response headers
//
// We use @octokit/core (not @octokit/rest) to keep the install footprint
// small. We bring in the `paginate-rest` plugin for the few endpoints that
// genuinely need pagination (issues list, comments list).

import { Octokit } from "@octokit/core";
import { paginateRest, composePaginateRest } from "@octokit/plugin-paginate-rest";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";

const TangerineOctokit = Octokit.plugin(paginateRest, restEndpointMethods);

export type GhClient = InstanceType<typeof TangerineOctokit>;

export interface MakeClientOpts {
  /** Inject a fetch implementation. Tests pass a mock. */
  fetch?: typeof fetch;
  /** Override base URL (for Enterprise; default is api.github.com). */
  baseUrl?: string;
}

export function makeClient(token: string, opts: MakeClientOpts = {}): GhClient {
  return new TangerineOctokit({
    // Empty token → unauthenticated (public reads only, low rate limit).
    ...(token ? { auth: token } : {}),
    userAgent: "tangerine-source-github/0.1.0",
    request: opts.fetch ? { fetch: opts.fetch } : undefined,
    baseUrl: opts.baseUrl,
  });
}

/** Read rate-limit metadata off any octokit response headers. */
export function readRateLimit(headers: Record<string, string | undefined>): {
  limit: number | null;
  remaining: number | null;
  resetUnix: number | null;
} {
  const num = (k: string): number | null => {
    const v = headers[k];
    if (v === undefined || v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    limit: num("x-ratelimit-limit"),
    remaining: num("x-ratelimit-remaining"),
    resetUnix: num("x-ratelimit-reset"),
  };
}

/**
 * Should we slow down? Returns ms to sleep before the next request, or 0 if
 * we have plenty of budget. We get nervous below 50 remaining.
 */
export function rateLimitBackoffMs(
  remaining: number | null,
  resetUnix: number | null,
  nowMs: number = Date.now(),
): number {
  if (remaining === null || resetUnix === null) return 0;
  if (remaining > 50) return 0;
  const resetMs = resetUnix * 1000;
  const wait = Math.max(0, resetMs - nowMs);
  // Don't sleep more than 5 minutes in one shot — caller decides whether to keep going.
  return Math.min(wait, 5 * 60 * 1000);
}

export { composePaginateRest };
