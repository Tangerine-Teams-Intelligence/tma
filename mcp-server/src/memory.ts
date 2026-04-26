/**
 * memory.ts — filesystem walk + search + frontmatter parse for Tangerine team memory.
 *
 * Memory layout (mirrors the desktop app):
 *   <root>/{meetings,decisions,people,projects,threads,glossary,...}/*.md
 *
 * Each file may have YAML frontmatter (parsed via gray-matter). Search is
 * case-insensitive substring across the body (after stripping frontmatter),
 * results sorted by descending number of matches.
 *
 * Logging: stderr only (stdout is reserved for MCP JSONRPC traffic).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import matter from "gray-matter";

/** Hard cap on how many files we'll touch in a single walk. */
export const MAX_FILES = 1000;

/** Max body bytes returned in a single payload (safety belt). */
export const CONTENT_PREVIEW_CHARS = 4000;

/** Snippet window characters either side of the matched substring. */
const SNIPPET_CONTEXT = 120;

/** Memory file as we cache it after a walk. */
export interface MemoryFile {
  /** Path relative to the memory root, with forward slashes. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Parsed YAML frontmatter (empty object if none). */
  frontmatter: Record<string, unknown>;
  /** Body of the file with frontmatter stripped. */
  body: string;
  /** Convenient title from frontmatter.title, or filename without extension. */
  title: string;
}

/** A single search hit. */
export interface SearchHit {
  /** Path relative to the memory root, with forward slashes. */
  file: string;
  /** Title from frontmatter, or filename. */
  title: string;
  /** Parsed frontmatter (object). */
  frontmatter: Record<string, unknown>;
  /** Snippet around the first match (with ellipsis). */
  snippet: string;
  /** First N chars of the body. */
  content_preview: string;
  /** Number of matches in this file. */
  matches: number;
}

/**
 * Resolve the memory root in priority order:
 *   1. explicit `rootArg` (from --root flag)
 *   2. $TANGERINE_MEMORY_ROOT env var
 *   3. ~/.tangerine-memory
 */
export function resolveMemoryRoot(rootArg?: string): string {
  if (rootArg && rootArg.trim().length > 0) {
    return path.resolve(rootArg);
  }
  const envRoot = process.env.TANGERINE_MEMORY_ROOT;
  if (envRoot && envRoot.trim().length > 0) {
    return path.resolve(envRoot);
  }
  return path.join(os.homedir(), ".tangerine-memory");
}

/**
 * Recursively walk `root` and return every `.md` file (up to MAX_FILES).
 * Returns empty array if root doesn't exist (caller should log to stderr).
 */
export async function walkMemoryRoot(root: string): Promise<MemoryFile[]> {
  let exists = false;
  try {
    const stat = await fs.stat(root);
    exists = stat.isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    return [];
  }

  const files: MemoryFile[] = [];
  await walkDir(root, root, files);
  return files;
}

async function walkDir(
  current: string,
  root: string,
  out: MemoryFile[],
): Promise<void> {
  if (out.length >= MAX_FILES) return;

  let entries: string[];
  try {
    entries = await fs.readdir(current);
  } catch (err) {
    process.stderr.write(
      `[tangerine-mcp] readdir failed for ${current}: ${(err as Error).message}\n`,
    );
    return;
  }

  for (const name of entries) {
    if (out.length >= MAX_FILES) return;
    // Skip dotfiles and node_modules-style noise.
    if (name.startsWith(".") || name === "node_modules") continue;

    const abs = path.join(current, name);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      await walkDir(abs, root, out);
    } else if (stat.isFile() && name.toLowerCase().endsWith(".md")) {
      try {
        const raw = await fs.readFile(abs, "utf8");
        const parsed = matter(raw);
        const fm = (parsed.data ?? {}) as Record<string, unknown>;
        const relPath = path.relative(root, abs).split(path.sep).join("/");
        out.push({
          relPath,
          absPath: abs,
          frontmatter: fm,
          body: parsed.content ?? "",
          title: titleFor(fm, name),
        });
      } catch (err) {
        process.stderr.write(
          `[tangerine-mcp] failed to read ${abs}: ${(err as Error).message}\n`,
        );
      }
    }
  }
}

function titleFor(fm: Record<string, unknown>, filename: string): string {
  const t = fm["title"];
  if (typeof t === "string" && t.trim().length > 0) return t.trim();
  return filename.replace(/\.md$/i, "");
}

/**
 * Case-insensitive substring search across all files. Returns top `limit` hits
 * sorted by descending match count. Empty/whitespace queries return [].
 */
export function searchMemory(
  files: MemoryFile[],
  query: string,
  limit: number,
): SearchHit[] {
  const q = (query ?? "").trim();
  if (q.length === 0) return [];
  const needle = q.toLowerCase();
  const cap = Math.max(1, Math.min(limit, 20));

  const hits: SearchHit[] = [];
  for (const f of files) {
    const haystack = f.body.toLowerCase();
    let matches = 0;
    let idx = haystack.indexOf(needle);
    const firstMatch = idx;
    while (idx !== -1) {
      matches++;
      idx = haystack.indexOf(needle, idx + needle.length);
    }
    if (matches === 0) continue;

    hits.push({
      file: f.relPath,
      title: f.title,
      frontmatter: f.frontmatter,
      snippet: snippetAround(f.body, firstMatch, needle.length),
      content_preview: f.body.slice(0, CONTENT_PREVIEW_CHARS),
      matches,
    });
  }

  hits.sort((a, b) => {
    if (b.matches !== a.matches) return b.matches - a.matches;
    return a.file.localeCompare(b.file);
  });
  return hits.slice(0, cap);
}

function snippetAround(body: string, matchIdx: number, needleLen: number): string {
  const start = Math.max(0, matchIdx - SNIPPET_CONTEXT);
  const end = Math.min(body.length, matchIdx + needleLen + SNIPPET_CONTEXT);
  let s = body.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = "..." + s;
  if (end < body.length) s = s + "...";
  return s;
}

/**
 * Read a single memory file by path relative to `root`. Validates the result
 * stays within `root` (no `../` escapes). Returns null if not found / not allowed.
 */
export async function readMemoryFile(
  root: string,
  relPath: string,
): Promise<MemoryFile | null> {
  const safeRel = relPath.replace(/^\/+/, "");
  const abs = path.resolve(root, safeRel);
  const rootResolved = path.resolve(root);
  if (!abs.startsWith(rootResolved + path.sep) && abs !== rootResolved) {
    return null;
  }
  let raw: string;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch {
    return null;
  }
  const parsed = matter(raw);
  const fm = (parsed.data ?? {}) as Record<string, unknown>;
  const relNormalized = path.relative(rootResolved, abs).split(path.sep).join("/");
  return {
    relPath: relNormalized,
    absPath: abs,
    frontmatter: fm,
    body: parsed.content ?? "",
    title: titleFor(fm, path.basename(abs)),
  };
}
