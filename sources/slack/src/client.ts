// Thin wrapper around @slack/web-api. Centralizes:
//  - Token + bot-vs-user mode
//  - Optional fetch override (tests inject a mock)
//  - Rate-limit awareness via response headers / SlackError.data
//
// We rely on @slack/web-api's `WebClient` because it handles the OAuth2
// quirks, slack URL signing, and pagination cursors uniformly.

import { WebClient, type WebClientOptions } from "@slack/web-api";

export type SlackClient = WebClient;

export interface MakeClientOpts {
  /** Inject a fetch implementation. Tests pass a mock. */
  fetch?: typeof fetch;
  /** Override base URL (for Enterprise Grid). */
  slackApiUrl?: string;
}

export function makeClient(token: string, opts: MakeClientOpts = {}): SlackClient {
  const o: WebClientOptions = {};
  if (opts.slackApiUrl) o.slackApiUrl = opts.slackApiUrl;
  // The WebClient ships with its own retry policy and rate-limiter. Default is
  // sane for our 60s polling cadence.
  return new WebClient(token, o);
}

/**
 * Should we slow down? Slack returns `Retry-After` (seconds) on 429s. The
 * WebClient handles this internally, but pollers may want to back off
 * proactively when remaining-budget gets thin (Slack's tier-based bucket).
 */
export function rateLimitBackoffMs(retryAfterSec: number | null): number {
  if (retryAfterSec === null || retryAfterSec <= 0) return 0;
  // Cap at 5 minutes — the daemon will pick this up on the next iteration.
  return Math.min(retryAfterSec * 1000, 5 * 60 * 1000);
}
