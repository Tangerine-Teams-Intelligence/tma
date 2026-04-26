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
 * v1.5.5 wires the Tauri plugin-fs in. Outside Tauri (vitest, vite dev in a
 * browser tab) the helpers fall back to an empty-tree shim so the UI stays
 * usable. All fs errors (missing dir, permission denied) degrade silently to
 * empty results rather than throwing — the UI handles `tree.length === 0` as
 * the empty state.
 */

import { readDir, readTextFile, exists, mkdir } from "@tauri-apps/plugin-fs";

// Detect Tauri environment without crashing the browser/test runner.
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

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
 * the dir from JS — `init_memory_with_samples` (Rust) handles the first-run
 * mkdir + sample seeding so the first-paint always sees a populated tree.
 *
 * Cross-platform pattern: prefer `<home>/.tangerine-memory/` everywhere.
 */
export function defaultMemoryRoot(): string {
  if (typeof window !== "undefined") {
    // Best-effort placeholder shown in the breadcrumb until Rust resolves the
    // real $HOME path via `resolve_memory_root`.
    return "~/.tangerine-memory";
  }
  return ".tangerine-memory";
}

/** Joins a memory-root + relative path safely (always forward slashes after). */
function join(root: string, rel: string): string {
  if (!rel) return root;
  const r = root.endsWith("/") || root.endsWith("\\") ? root.slice(0, -1) : root;
  return `${r}/${rel}`;
}

/** Concatenate a parent rel path + a child name with forward slashes. */
function childRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/**
 * Recursive directory walk.
 *
 * Returns folder + file nodes (no symlinks, no hidden dotfiles). Sorted
 * dirs-first then alpha within each level. On any fs error, returns an empty
 * array silently — the UI's empty state covers it.
 */
async function walkDir(rootAbs: string, relPath: string): Promise<MemoryNode[]> {
  const abs = join(rootAbs, relPath);
  let entries: { name: string; isDirectory: boolean; isFile: boolean }[] = [];
  try {
    entries = await readDir(abs);
  } catch {
    return [];
  }

  const nodes: MemoryNode[] = [];
  for (const e of entries) {
    if (!e.name || e.name.startsWith(".")) continue;
    const rel = childRel(relPath, e.name);
    if (e.isDirectory) {
      const children = await walkDir(rootAbs, rel);
      nodes.push({ path: rel, name: e.name, kind: "dir", children });
    } else if (e.isFile) {
      // Only surface markdown files. Other extensions are ignored to keep
      // the tree focused on what the user can actually render.
      if (!/\.(md|markdown|mdx)$/i.test(e.name)) continue;
      nodes.push({ path: rel, name: e.name, kind: "file" });
    }
  }

  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

/**
 * Walk the memory root and return a tree.
 *
 * v1.5.5: real fs walk via `@tauri-apps/plugin-fs` when running inside Tauri.
 * Outside Tauri (browser dev / tests), returns synthesized standard folders
 * so the UI shape is preserved.
 */
export async function readMemoryTree(root: string): Promise<MemoryNode[]> {
  if (!inTauri()) {
    return STANDARD_FOLDERS.map((name) => ({
      path: name,
      name,
      kind: "dir" as const,
      children: [],
    }));
  }

  // Make sure the root exists so the first-launch path doesn't error out.
  // (init_memory_with_samples handles seeding; this is just a safety mkdir.)
  try {
    const present = await exists(root);
    if (!present) {
      await mkdir(root, { recursive: true });
    }
  } catch {
    // Permission or path error — fall through, walkDir will return [].
  }

  const tree = await walkDir(root, "");
  if (tree.length > 0) return tree;

  // Empty dir — synthesize standard folders so the user sees the layout.
  return STANDARD_FOLDERS.map((name) => ({
    path: name,
    name,
    kind: "dir" as const,
    children: [],
  }));
}

/** Alias used by some callers — same contract as `readMemoryTree`. */
export const walkMemoryTree = readMemoryTree;

/**
 * Read a single memory file. Returns null on any error (missing file,
 * permission denied) so the UI's "file not found" state can render.
 */
export async function readMemoryFile(
  root: string,
  relPath: string,
): Promise<string | null> {
  if (!inTauri()) return null;
  if (!relPath) return null;
  const abs = join(root, relPath);
  try {
    return await readTextFile(abs);
  } catch {
    return null;
  }
}

/** Recursive collector of every .md file path under `root` (rel-paths). */
async function collectFiles(rootAbs: string, relPath: string): Promise<string[]> {
  const abs = join(rootAbs, relPath);
  let entries: { name: string; isDirectory: boolean; isFile: boolean }[] = [];
  try {
    entries = await readDir(abs);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.name || e.name.startsWith(".")) continue;
    const rel = childRel(relPath, e.name);
    if (e.isDirectory) {
      const sub = await collectFiles(rootAbs, rel);
      out.push(...sub);
    } else if (e.isFile && /\.(md|markdown|mdx)$/i.test(e.name)) {
      out.push(rel);
    }
  }
  return out;
}

/** Build a snippet around the first match (~120 chars). */
function makeSnippet(body: string, q: string): string {
  const idx = body.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return body.slice(0, 120).replace(/\s+/g, " ").trim();
  const start = Math.max(0, idx - 50);
  const end = Math.min(body.length, idx + q.length + 70);
  const cut = body.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + cut + (end < body.length ? "…" : "");
}

/**
 * Substring search across all .md bodies under root.
 *
 * v1.5.5: linear scan, case-insensitive, capped at 50 hits and 200 files
 * checked to keep the palette responsive on large memory dirs. v1.6 will add
 * a fulltext + vector index sidecar.
 */
export async function searchMemory(
  root: string,
  query: string,
): Promise<MemorySearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  if (!inTauri()) return [];

  const files = await collectFiles(root, "");
  const hits: MemorySearchHit[] = [];
  const needle = q.toLowerCase();
  let scanned = 0;
  for (const rel of files) {
    if (scanned >= 200) break;
    scanned++;
    let body: string;
    try {
      body = await readTextFile(join(root, rel));
    } catch {
      continue;
    }
    if (!body.toLowerCase().includes(needle)) continue;
    const name = rel.split("/").pop() ?? rel;
    hits.push({ path: rel, name, snippet: makeSnippet(body, q) });
    if (hits.length >= 50) break;
  }
  return hits;
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

/**
 * Parse a tiny subset of YAML frontmatter — enough to read the `sample` flag
 * + `title` without pulling a full YAML parser into the bundle. Returns the
 * raw frontmatter string plus a parsed map (string-only values).
 */
export interface Frontmatter {
  raw: string;
  body: string;
  fields: Record<string, string>;
  isSample: boolean;
}

export function parseFrontmatter(content: string): Frontmatter {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { raw: "", body: content, fields: {}, isSample: false };
  const raw = m[1];
  const body = m[2];
  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  const isSample = /^(true|yes|1)$/i.test(fields.sample ?? "");
  return { raw, body, fields, isSample };
}
