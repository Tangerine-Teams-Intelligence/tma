// Project status changes. Stage 1 stub — Linear's project mutations come
// through the issue feed via issue.project; we don't poll a separate
// projects endpoint yet. Reserved here so the file structure matches the
// inventory documented in sources/README.md.
//
// When Stage 2 needs richer project signal (status moves, milestone targets,
// archive events), this is where the GraphQL queries land.

import type { Atom } from "../types.js";

export interface IngestProjectsResult {
  atoms: Atom[];
  newCursor: string | null;
}

export async function ingestProjects(): Promise<IngestProjectsResult> {
  return { atoms: [] as Atom[], newCursor: null };
}
