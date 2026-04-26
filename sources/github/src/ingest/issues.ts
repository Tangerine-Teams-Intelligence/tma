// Issue ingest. Note: GitHub's `/issues` endpoint returns BOTH issues and PRs;
// PR objects carry a `pull_request` field which we use to filter them out
// (PRs are handled by ingest/prs.ts).

import type { GhClient } from "../client.js";
import type { Atom } from "../types.js";
import type { NormalizeCtx } from "../normalize.js";
import { normalizeIssue, normalizeIssueClosed, type RawIssue } from "../normalize.js";

export interface IngestIssuesResult {
  atoms: Atom[];
  rawLogins: Set<string>;
  newCursor: string | null;
}

export async function ingestIssues(
  client: GhClient,
  owner: string,
  repo: string,
  ctx: NormalizeCtx,
  since: string | null,
): Promise<IngestIssuesResult> {
  const atoms: Atom[] = [];
  const rawLogins = new Set<string>();
  let newCursor: string | null = since;

  const iter = client.paginate.iterator(client.rest.issues.listForRepo, {
    owner,
    repo,
    state: "all",
    sort: "updated",
    direction: "desc",
    since: since ?? undefined,
    per_page: 50,
  });

  for await (const page of iter) {
    for (const item of page.data) {
      // Filter PRs masquerading as issues.
      if ((item as unknown as RawIssue).pull_request) continue;

      const raw = item as unknown as RawIssue;
      if (raw.updated_at && (newCursor === null || raw.updated_at > newCursor)) {
        newCursor = raw.updated_at;
      }
      atoms.push(normalizeIssue(raw, ctx));
      if (raw.user?.login) rawLogins.add(raw.user.login);
      if (raw.closed_at) {
        atoms.push(normalizeIssueClosed(raw, ctx));
      }
    }
  }

  return { atoms, rawLogins, newCursor };
}

// Type augmentation for GitHub's "issue with optional updated_at" — used in cursor logic.
declare module "../normalize.js" {
  interface RawIssue {
    updated_at?: string | null;
  }
}
