// PR review ingest — the "Approve / Request changes / Comment" submit events.
//
// GitHub doesn't expose a repo-wide reviews endpoint, so we list per PR. To
// keep the API budget sane we only fetch reviews for PRs whose updated_at is
// newer than `since`. The caller (poll.ts) hands us the candidate PR list.

import type { GhClient } from "../client.js";
import type { Atom } from "../types.js";
import type { NormalizeCtx } from "../normalize.js";
import { normalizeReview, type RawReview } from "../normalize.js";

export interface IngestReviewsResult {
  atoms: Atom[];
  rawLogins: Set<string>;
  newCursor: string | null;
}

export async function ingestReviewsForPrs(
  client: GhClient,
  owner: string,
  repo: string,
  ctx: NormalizeCtx,
  prs: Array<{ number: number; title?: string | null }>,
  since: string | null,
): Promise<IngestReviewsResult> {
  const atoms: Atom[] = [];
  const rawLogins = new Set<string>();
  let newCursor: string | null = since;

  for (const pr of prs) {
    let res;
    try {
      res = await client.rest.pulls.listReviews({ owner, repo, pull_number: pr.number, per_page: 50 });
    } catch {
      continue; // perm error — skip
    }
    for (const r of res.data) {
      const submitted = (r as unknown as { submitted_at?: string | null }).submitted_at ?? null;
      if (since && submitted && submitted <= since) continue;
      if (submitted && (newCursor === null || submitted > newCursor)) newCursor = submitted;
      const raw: RawReview = {
        id: r.id,
        body: r.body ?? null,
        state: r.state ?? "commented",
        user: r.user ? { login: r.user.login } : null,
        submitted_at: submitted,
        html_url: r.html_url,
        parentNumber: pr.number,
        parentTitle: pr.title ?? null,
      };
      atoms.push(normalizeReview(raw, ctx));
      if (raw.user?.login) rawLogins.add(raw.user.login);
    }
  }

  return { atoms, rawLogins, newCursor };
}
