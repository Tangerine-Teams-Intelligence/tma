/**
 * Phase 3-C — co-thinker view helpers.
 *
 * Pure functions used by `/co-thinker` and its sub-components. Kept out of
 * the route file so they're cheap to unit-test in isolation.
 *
 *   • relativeTime  — turn an ISO timestamp into "5 min ago" / "in 2 min".
 *   • parseSections — split the brain doc into the 4 H2 sections the
 *                     route renders as separate cards.
 *   • CITATION_REGEX — global regex matching atom-path citations
 *                      (`/memory/foo/bar.md` optionally followed by `Lnn`).
 */

/**
 * Match an atom-path citation. The brain doc encodes references to memory
 * atoms as `/memory/<path>.md` optionally followed by ` L<line>`. We match
 * the full reference (path + optional line) in one capture so the renderer
 * can wrap it as a single <Link/>.
 *
 * Capture groups (1-indexed):
 *   1 — full match (e.g. `/memory/decisions/foo.md L23`)
 *   2 — path only (e.g. `/memory/decisions/foo.md`)
 *   3 — line number string (e.g. `23`) or undefined
 */
export const CITATION_REGEX = /(\/memory\/[^\s)]+\.md)(?:\s+L(\d+))?/g;

/**
 * Format an ISO 8601 timestamp as a short relative phrase relative to `now`.
 * Returns "—" for null / unparseable input so the caller doesn't have to
 * branch.
 *
 * Examples:
 *   • 30s ago
 *   • 5 min ago
 *   • 2 hr ago
 *   • in 4 min   (next heartbeat)
 *   • just now   (within ±5s)
 */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";

  const deltaMs = t - now.getTime();
  const absSec = Math.abs(deltaMs) / 1000;
  const future = deltaMs > 0;

  if (absSec < 5) return "just now";
  if (absSec < 60) {
    const n = Math.round(absSec);
    return future ? `in ${n}s` : `${n}s ago`;
  }
  if (absSec < 60 * 60) {
    const n = Math.round(absSec / 60);
    return future ? `in ${n} min` : `${n} min ago`;
  }
  if (absSec < 60 * 60 * 24) {
    const n = Math.round(absSec / 3600);
    return future ? `in ${n} hr` : `${n} hr ago`;
  }
  const n = Math.round(absSec / 86400);
  return future ? `in ${n} d` : `${n} d ago`;
}

/**
 * Brain-doc section. The doc is structured around 4 canonical H2 headings;
 * this is how we split for separate rendering / styling.
 */
export interface BrainSection {
  /** Raw H2 heading text (e.g. "What I'm watching"). */
  heading: string;
  /** Body markdown after the heading, before the next H2. Trimmed. */
  body: string;
}

/**
 * Split a brain doc by `## ` H2 markers. Lines before the first H2 are
 * dropped (we treat the title H1 as throwaway preamble). Each section's
 * body is a complete markdown fragment that can be passed to ReactMarkdown
 * verbatim.
 *
 * The route uses this to render each section as its own card; if the brain
 * has fewer than the canonical 4 sections we just render whatever we got.
 */
export function parseSections(content: string): BrainSection[] {
  if (!content) return [];
  const lines = content.split("\n");
  const sections: BrainSection[] = [];
  let current: BrainSection | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (current) sections.push({ heading: current.heading, body: current.body.trim() });
      current = { heading: m[1].trim(), body: "" };
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.body.trim() });
  return sections;
}

/**
 * The 4 canonical section headings in the order the brain doc emits them.
 * Phase 3-C UI renders sections in this order regardless of doc order; any
 * extra sections fall through to "Other" at the bottom.
 */
export const CANONICAL_SECTIONS = [
  "What I'm watching",
  "Active threads",
  "My todo",
  "Recent reasoning",
] as const;

/**
 * Convert an atom citation path to the in-app router target. The brain
 * encodes paths as `/memory/decisions/foo.md`; the React Router route is
 * `/memory/<rest>` (the route already knows about the `/memory` prefix),
 * so we pass the trimmed remainder.
 *
 * Returns the full router path including the `/memory` prefix so the
 * caller can pass it straight to `<Link to={...}/>`.
 */
export function citationToRoute(citation: string): string {
  // Strip leading `/memory/` since the route prefix is already `/memory/*`.
  // We keep the leading `/memory` when handing back to the caller.
  if (citation.startsWith("/memory/")) return citation;
  if (citation.startsWith("memory/")) return `/${citation}`;
  return `/memory/${citation.replace(/^\/+/, "")}`;
}
