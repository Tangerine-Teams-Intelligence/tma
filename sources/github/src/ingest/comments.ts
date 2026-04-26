// PR conversation comments + Issue comments + PR inline review comments.
//
// Three endpoints:
//  - GET /repos/{o}/{r}/issues/comments  → both PR conversation + issue comments
//  - GET /repos/{o}/{r}/pulls/comments   → inline review comments (code-line)
//
// The first is the workhorse; we set inline=false for it. The second is for
// inline-on-diff comments; we set inline=true.

import type { GhClient } from "../client.js";
import type { Atom } from "../types.js";
import type { NormalizeCtx } from "../normalize.js";
import { normalizeComment, type RawComment } from "../normalize.js";

export interface IngestCommentsResult {
  atoms: Atom[];
  rawLogins: Set<string>;
  newCursor: string | null;
}

/** Pull a parent number out of an issue-comment URL: ".../issues/47" or ".../pull/47". */
function parentNumberFromIssueUrl(url: string | null | undefined): { num: number; kind: "pr" | "issue" } | null {
  if (!url) return null;
  const pr = /\/pull\/(\d+)/.exec(url);
  if (pr) return { num: Number(pr[1]), kind: "pr" };
  const iss = /\/issues\/(\d+)/.exec(url);
  if (iss) return { num: Number(iss[1]), kind: "issue" };
  return null;
}

export async function ingestComments(
  client: GhClient,
  owner: string,
  repo: string,
  ctx: NormalizeCtx,
  since: string | null,
): Promise<IngestCommentsResult> {
  const atoms: Atom[] = [];
  const rawLogins = new Set<string>();
  let newCursor: string | null = since;

  // Conversation comments (issues + PR conversation tab).
  const issueIter = client.paginate.iterator(client.rest.issues.listCommentsForRepo, {
    owner,
    repo,
    sort: "updated",
    direction: "desc",
    since: since ?? undefined,
    per_page: 50,
  });
  for await (const page of issueIter) {
    for (const c of page.data) {
      const updated = c.updated_at ?? c.created_at;
      if (updated && (newCursor === null || updated > newCursor)) newCursor = updated;
      // Determine parent — GitHub gives us issue_url for issue comments.
      const parent = parentNumberFromIssueUrl((c as unknown as { issue_url?: string }).issue_url ?? c.html_url);
      if (!parent) continue;
      const raw: RawComment = {
        id: c.id,
        body: c.body ?? null,
        user: c.user ? { login: c.user.login } : null,
        created_at: c.created_at,
        html_url: c.html_url,
        path: null,
        inline: false,
        parentNumber: parent.num,
        parentKind: parent.kind,
      };
      atoms.push(normalizeComment(raw, ctx));
      if (raw.user?.login) rawLogins.add(raw.user.login);
    }
  }

  // Inline review comments (diff line comments) — always PR-scoped.
  const reviewIter = client.paginate.iterator(client.rest.pulls.listReviewCommentsForRepo, {
    owner,
    repo,
    sort: "updated",
    direction: "desc",
    since: since ?? undefined,
    per_page: 50,
  });
  for await (const page of reviewIter) {
    for (const c of page.data) {
      const updated = c.updated_at ?? c.created_at;
      if (updated && (newCursor === null || updated > newCursor)) newCursor = updated;
      const prNumber = (c as unknown as { pull_request_url?: string }).pull_request_url
        ? Number(/\/pulls\/(\d+)/.exec((c as unknown as { pull_request_url: string }).pull_request_url)?.[1] ?? 0)
        : 0;
      if (!prNumber) continue;
      const raw: RawComment = {
        id: c.id,
        body: c.body ?? null,
        user: c.user ? { login: c.user.login } : null,
        created_at: c.created_at,
        html_url: c.html_url,
        path: c.path ?? null,
        inline: true,
        parentNumber: prNumber,
        parentKind: "pr",
      };
      atoms.push(normalizeComment(raw, ctx));
      if (raw.user?.login) rawLogins.add(raw.user.login);
    }
  }

  return { atoms, rawLogins, newCursor };
}
