// Linear issue ingest. Lists issues touched since `since`, normalizes them
// into ticket_event atoms (or `decision` if a completion description matches
// the decision sniffer).

import type { LinearLike } from "../client.js";
import type { Atom } from "../types.js";
import type { NormalizeCtx } from "../normalize.js";
import { normalizeIssue } from "../normalize.js";

export interface IngestIssuesResult {
  atoms: Atom[];
  rawHandles: Set<string>;
  newCursor: string | null;
}

export async function ingestIssues(
  client: LinearLike,
  ctx: NormalizeCtx,
  since: string | null,
): Promise<IngestIssuesResult> {
  const atoms: Atom[] = [];
  const rawHandles = new Set<string>();
  let newCursor: string | null = since;

  const issues = await client.listIssuesForTeam(ctx.team.uuid, since);
  for (const issue of issues) {
    if (issue.updatedAt && (newCursor === null || issue.updatedAt > newCursor)) {
      newCursor = issue.updatedAt;
    }
    atoms.push(normalizeIssue(issue, ctx, since));
    if (issue.creator) rawHandles.add(handleFor(issue.creator));
    if (issue.assignee) rawHandles.add(handleFor(issue.assignee));
  }

  return { atoms, rawHandles, newCursor };
}

function handleFor(u: { email?: string; displayName?: string; name?: string; id: string }): string {
  return u.email ?? u.displayName ?? u.name ?? u.id;
}
