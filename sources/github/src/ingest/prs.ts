// Pull-request ingest. Lists PRs touched since `since`, normalizes them, and
// returns atoms for: open events, merge events, close-without-merge events.
// (PR _comment_ and _review_ ingest live in their own modules.)
//
// Strategy: use `GET /repos/{owner}/{repo}/pulls` with state=all, sorted by
// updated_at desc. Stop scanning when we hit a PR whose updated_at < since.
// We then re-fetch each candidate via `GET .../pulls/{n}` to pick up
// merged_at / merge_commit_sha / merged_by which the list endpoint omits.

import type { GhClient } from "../client.js";
import type { Atom } from "../types.js";
import type { NormalizeCtx } from "../normalize.js";
import {
  normalizePr,
  normalizePrMerged,
  normalizePrClosed,
  type RawPr,
} from "../normalize.js";

export interface IngestPrsResult {
  atoms: Atom[];
  rawLogins: Set<string>;
  /** Latest updated_at we saw, for cursor advancement. */
  newCursor: string | null;
}

export async function ingestPrs(
  client: GhClient,
  owner: string,
  repo: string,
  ctx: NormalizeCtx,
  since: string | null,
): Promise<IngestPrsResult> {
  const atoms: Atom[] = [];
  const rawLogins = new Set<string>();
  let newCursor: string | null = since;

  // Pagination — stop early when older-than-cursor.
  const iter = client.paginate.iterator(client.rest.pulls.list, {
    owner,
    repo,
    state: "all",
    sort: "updated",
    direction: "desc",
    per_page: 50,
  });

  outer: for await (const page of iter) {
    for (const item of page.data) {
      const updated = item.updated_at;
      if (updated && newCursor !== null && updated <= since!) {
        break outer; // we've gone past our cursor
      }
      if (updated && (newCursor === null || updated > newCursor)) {
        newCursor = updated;
      }

      // The list endpoint gives us most of what we need; only re-fetch when we
      // need merge metadata that's not in list (merged_at / merge_commit_sha).
      let detailed: RawPr = item as unknown as RawPr;
      const isClosedOrMerged = item.state === "closed";
      if (isClosedOrMerged) {
        try {
          const det = await client.rest.pulls.get({ owner, repo, pull_number: item.number });
          detailed = det.data as unknown as RawPr;
        } catch {
          /* keep list version on permission error */
        }
      }

      // Always emit pr_opened for any PR we see. Dedup at write time prevents
      // double-write across polls.
      atoms.push(normalizePr(detailed, ctx));
      if (detailed.user?.login) rawLogins.add(detailed.user.login);

      if (detailed.merged_at) {
        atoms.push(normalizePrMerged(detailed, ctx));
        const ml = (detailed.merged_by ?? null)?.login;
        if (ml) rawLogins.add(ml);
      } else if (detailed.closed_at) {
        atoms.push(normalizePrClosed(detailed, ctx));
      }
    }
  }

  return { atoms, rawLogins, newCursor };
}
