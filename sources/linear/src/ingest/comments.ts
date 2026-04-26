// Linear comment ingest. One comment atom per LinearComment; decision
// sniffer promotes to `decision` when body matches.

import type { LinearLike } from "../client.js";
import type { Atom } from "../types.js";
import type { NormalizeCtx } from "../normalize.js";
import { normalizeComment } from "../normalize.js";

export interface IngestCommentsResult {
  atoms: Atom[];
  rawHandles: Set<string>;
  newCursor: string | null;
}

export async function ingestComments(
  client: LinearLike,
  ctx: NormalizeCtx,
  since: string | null,
): Promise<IngestCommentsResult> {
  const atoms: Atom[] = [];
  const rawHandles = new Set<string>();
  let newCursor: string | null = since;

  const comments = await client.listCommentsForTeam(ctx.team.uuid, since);
  for (const c of comments) {
    const updated = c.updatedAt ?? c.createdAt;
    if (updated && (newCursor === null || updated > newCursor)) newCursor = updated;
    atoms.push(normalizeComment(c, ctx));
    if (c.user) {
      const u = c.user;
      const handle = u.email ?? u.displayName ?? u.name ?? u.id;
      rawHandles.add(handle);
    }
  }
  return { atoms, rawHandles, newCursor };
}
