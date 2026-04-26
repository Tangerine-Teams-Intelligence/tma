// Webhook receiver — bonus, OPT-IN. Default ingest path is poll.ts.
//
// This module exposes a single function that accepts a GitHub webhook event
// (already parsed JSON + the `X-GitHub-Event` header value) and returns the
// atoms it implies. It does NOT start a server — the host (desktop app or
// future hosted gateway) is responsible for routing HTTP and signature
// verification. This keeps the source connector dependency-light.

import type { Atom } from "../types.js";
import type { NormalizeCtx } from "../normalize.js";
import {
  normalizePr,
  normalizePrMerged,
  normalizePrClosed,
  normalizeComment,
  normalizeIssue,
  normalizeIssueClosed,
  normalizeReview,
  type RawPr,
  type RawIssue,
  type RawComment,
  type RawReview,
} from "../normalize.js";

export interface WebhookResult {
  atoms: Atom[];
  rawLogins: Set<string>;
}

export function processWebhook(
  eventName: string,
  payload: Record<string, unknown>,
  ctx: NormalizeCtx,
): WebhookResult {
  const atoms: Atom[] = [];
  const rawLogins = new Set<string>();

  const action = payload.action as string | undefined;

  if (eventName === "pull_request" && action) {
    const pr = payload.pull_request as RawPr | undefined;
    if (!pr) return { atoms, rawLogins };
    if (pr.user?.login) rawLogins.add(pr.user.login);
    if (action === "opened" || action === "reopened" || action === "edited") {
      atoms.push(normalizePr(pr, ctx));
    }
    if (action === "closed") {
      if (pr.merged_at) {
        atoms.push(normalizePrMerged(pr, ctx));
        if (pr.merged_by?.login) rawLogins.add(pr.merged_by.login);
      } else {
        atoms.push(normalizePrClosed(pr, ctx));
      }
    }
  } else if (eventName === "issues" && action) {
    const issue = payload.issue as RawIssue | undefined;
    if (!issue) return { atoms, rawLogins };
    if (issue.user?.login) rawLogins.add(issue.user.login);
    if (action === "opened" || action === "reopened" || action === "edited") {
      atoms.push(normalizeIssue(issue, ctx));
    }
    if (action === "closed") {
      atoms.push(normalizeIssueClosed(issue, ctx));
    }
  } else if (eventName === "issue_comment" && action === "created") {
    const issue = payload.issue as (RawIssue & { pull_request?: unknown; html_url?: string }) | undefined;
    const comment = payload.comment as { id: number; body: string; user?: { login: string }; created_at: string; html_url?: string } | undefined;
    if (!issue || !comment) return { atoms, rawLogins };
    if (comment.user?.login) rawLogins.add(comment.user.login);
    const raw: RawComment = {
      id: comment.id,
      body: comment.body,
      user: comment.user ?? null,
      created_at: comment.created_at,
      html_url: comment.html_url,
      inline: false,
      path: null,
      parentNumber: issue.number,
      parentKind: issue.pull_request ? "pr" : "issue",
      parentTitle: issue.title,
    };
    atoms.push(normalizeComment(raw, ctx));
  } else if (eventName === "pull_request_review_comment" && action === "created") {
    const pr = payload.pull_request as { number: number; title?: string } | undefined;
    const comment = payload.comment as { id: number; body: string; user?: { login: string }; created_at: string; html_url?: string; path?: string } | undefined;
    if (!pr || !comment) return { atoms, rawLogins };
    if (comment.user?.login) rawLogins.add(comment.user.login);
    const raw: RawComment = {
      id: comment.id,
      body: comment.body,
      user: comment.user ?? null,
      created_at: comment.created_at,
      html_url: comment.html_url,
      inline: true,
      path: comment.path ?? null,
      parentNumber: pr.number,
      parentKind: "pr",
      parentTitle: pr.title,
    };
    atoms.push(normalizeComment(raw, ctx));
  } else if (eventName === "pull_request_review" && action === "submitted") {
    const pr = payload.pull_request as { number: number; title?: string } | undefined;
    const review = payload.review as { id: number; body: string | null; state: string; user?: { login: string }; submitted_at: string; html_url?: string } | undefined;
    if (!pr || !review) return { atoms, rawLogins };
    if (review.user?.login) rawLogins.add(review.user.login);
    const raw: RawReview = {
      id: review.id,
      body: review.body,
      state: review.state,
      user: review.user ?? null,
      submitted_at: review.submitted_at,
      html_url: review.html_url,
      parentNumber: pr.number,
      parentTitle: pr.title,
    };
    atoms.push(normalizeReview(raw, ctx));
  }

  return { atoms, rawLogins };
}
