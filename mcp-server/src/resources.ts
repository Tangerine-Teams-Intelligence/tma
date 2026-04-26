/**
 * resources.ts — team-memory:// resource handlers.
 *
 * Exposes:
 *   team-memory://                          — list all memory files (metadata only)
 *   team-memory://<relative/path.md>        — full content of one file
 *
 * The MCP resources/list call returns one entry per file plus the synthetic
 * root listing entry; resources/read serves either the index or a specific file.
 */

import { walkMemoryRoot, readMemoryFile } from "./memory.js";

export const RESOURCE_SCHEME = "team-memory";
export const ROOT_URI = `${RESOURCE_SCHEME}://`;

export interface ResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
}

/**
 * List resources for MCP `resources/list`. Includes the synthetic root index
 * plus one entry per markdown file under the memory root.
 */
export async function listResources(root: string): Promise<ResourceDescriptor[]> {
  const files = await walkMemoryRoot(root);
  const out: ResourceDescriptor[] = [
    {
      uri: ROOT_URI,
      name: "Team memory index",
      description: "Index of every markdown file under the Tangerine team memory root.",
      mimeType: "application/json",
    },
  ];
  for (const f of files) {
    out.push({
      uri: `${RESOURCE_SCHEME}://${f.relPath}`,
      name: f.title,
      description: `Memory file: ${f.relPath}`,
      mimeType: "text/markdown",
    });
  }
  return out;
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

/**
 * Read a resource for MCP `resources/read`.
 *  - `team-memory://`            → JSON list of all files (metadata)
 *  - `team-memory://<relpath>`   → raw file contents (markdown)
 *
 * Returns null if the URI doesn't match or the file isn't found.
 */
export async function readResource(
  root: string,
  uri: string,
): Promise<ResourceContents | null> {
  if (!uri.startsWith(`${RESOURCE_SCHEME}://`)) return null;
  const rel = uri.slice(`${RESOURCE_SCHEME}://`.length);

  if (rel === "" || rel === "/") {
    const files = await walkMemoryRoot(root);
    const list = files.map((f) => ({
      uri: `${RESOURCE_SCHEME}://${f.relPath}`,
      file: f.relPath,
      title: f.title,
      frontmatter: f.frontmatter,
    }));
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        { root, count: list.length, files: list },
        null,
        2,
      ),
    };
  }

  const file = await readMemoryFile(root, rel);
  if (!file) return null;
  return {
    uri,
    mimeType: "text/markdown",
    text: rebuild(file.frontmatter, file.body),
  };
}

/** Rebuild a markdown file with its frontmatter for round-trip fidelity. */
function rebuild(frontmatter: Record<string, unknown>, body: string): string {
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) return body;
  // Lightweight YAML emit for primitives only; complex values fall back to JSON.
  const lines: string[] = ["---"];
  for (const k of keys) {
    const v = frontmatter[k];
    lines.push(`${k}: ${formatYamlValue(v)}`);
  }
  lines.push("---", "");
  return lines.join("\n") + body;
}

function formatYamlValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    if (/[:#\n"']/.test(v)) return JSON.stringify(v);
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
