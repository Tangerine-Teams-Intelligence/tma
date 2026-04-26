/**
 * Memory tree reader.
 *
 * The user's memory dir is a flat-ish tree of markdown files:
 *
 *   <root>/
 *     meetings/
 *       2026-04-25-roadmap.md
 *     decisions/
 *       2026-04-pricing.md
 *     people/
 *       daizhe.md
 *     projects/
 *     threads/
 *     glossary.md
 *
 * Each file = frontmatter + markdown body. Tangerine never holds the
 * canonical copy — it lives in the user's repo on disk. We just read it,
 * render it, search it, and ship it to the user's AI tools.
 *
 * Sidecar `<root>/.tangerine/index.json` is reserved for a future fast-lookup
 * index (vector embeddings, fulltext token map). v1.5 does not write or read
 * that index — search is local substring scan over the markdown bodies.
 *
 * v1.5 status: file-system walk is intentionally a no-op shim until the Tauri
 * `plugin-fs` capability is wired in v1.6. The spec for v1.5 is explicitly
 * "don't crash if memory dir is empty"; we keep the same contract here. The
 * UI handles `tree.length === 0` as the empty / coming-soon state.
 */

export interface MemoryNode {
  /** Path relative to the memory root, using forward slashes. */
  path: string;
  /** Filename or directory name. */
  name: string;
  /** "dir" or "file". */
  kind: "dir" | "file";
  /** Children, only set when `kind === "dir"`. Sorted dirs-first then alpha. */
  children?: MemoryNode[];
}

export interface MemorySearchHit {
  path: string;
  name: string;
  /** ~120 chars around the first match, with the match in the middle. */
  snippet: string;
}

/** Folders that ship out of the box. Shown as empty placeholders if missing. */
export const STANDARD_FOLDERS = [
  "meetings",
  "decisions",
  "people",
  "projects",
  "threads",
  "glossary",
] as const;

/**
 * Default root when the user hasn't configured a target_repo. We don't create
 * the dir from JS — the v1.6 sources will be the first thing that writes here
 * (Discord bot writes meetings/, etc.).
 *
 * Cross-platform pattern: prefer `<home>/.tangerine-memory/` everywhere.
 */
export function defaultMemoryRoot(): string {
  if (typeof window !== "undefined") {
    // Best-effort guess. The real path comes from Tauri's `os.homeDir()` in
    // v1.6 once we wire plugin-os; for v1.5 the value is just a placeholder
    // shown to the user as "where memory will live once it starts coming in".
    return "~/.tangerine-memory";
  }
  return ".tangerine-memory";
}

/**
 * Walk the memory root and return a tree.
 *
 * v1.5: returns an empty tree synthesized from STANDARD_FOLDERS so the UI has
 * folder labels to render. Once `plugin-fs` is wired (v1.6) this will read
 * real files.
 */
export async function readMemoryTree(_root: string): Promise<MemoryNode[]> {
  // Synthesize folder placeholders so the UI shows the standard layout.
  return STANDARD_FOLDERS.map((name) => ({
    path: name,
    name,
    kind: "dir" as const,
    children: [],
  }));
}

/**
 * Read a single memory file.
 *
 * v1.5: returns null because we have no real files yet. The single-file
 * markdown view handles null by showing "file not found in this build".
 */
export async function readMemoryFile(
  _root: string,
  _relPath: string,
): Promise<string | null> {
  return null;
}

/**
 * Search memory by substring. v1.5: stub-empty. v1.6+ will scan all .md
 * bodies under root.
 */
export async function searchMemory(
  _root: string,
  query: string,
): Promise<MemorySearchHit[]> {
  if (!query.trim()) return [];
  return [];
}

/**
 * Coverage stats for the home / memory landing page.
 *
 * v1.5: most fields are placeholders since only Discord works and even that
 * writes to `meetings/`. The numbers wire up properly in v1.6 when sources
 * are real connectors.
 */
export interface CoverageStats {
  meetings: number;
  decisions: number;
  people: number;
  projects: number;
  threads: number;
  /** Sources currently active. */
  activeSources: string[];
  /** Sources known but not yet shipping. */
  comingSources: string[];
}

export function emptyCoverage(): CoverageStats {
  return {
    meetings: 0,
    decisions: 0,
    people: 0,
    projects: 0,
    threads: 0,
    activeSources: [],
    comingSources: [],
  };
}
