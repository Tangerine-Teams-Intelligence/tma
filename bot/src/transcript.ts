// transcript.md formatter + append-with-fsync writer.
// Spec: INTERFACES.md §2.3 + §13 (memory layer mirror).

import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const NEWLINE_REPLACEMENT = "\u2424"; // U+2424 SYMBOL FOR NEWLINE per spec

/** Format `[HH:MM:SS]` from a Date. Wall-clock local time. */
export function formatTimestamp(d: Date = new Date()): string {
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
}

/** Sanitize Whisper output to a single line per spec §2.3. */
export function sanitizeText(text: string): string {
  // Collapse CRLF and LF to U+2424. Trim trailing whitespace only — preserve interior spaces.
  return text.replace(/\r\n?|\n/g, NEWLINE_REPLACEMENT).replace(/\s+$/, "");
}

export function formatLine(alias: string, text: string, when: Date = new Date()): string {
  return `${formatTimestamp(when)} ${alias}: ${sanitizeText(text)}\n`;
}

/** STT_FAILED line per spec §2.3 example. */
export function formatSttFailedLine(
  chunkId: number,
  reason: string,
  retries: number,
  when: Date = new Date(),
): string {
  return `${formatTimestamp(when)} [STT_FAILED]: chunk_id=${chunkId} reason=${reason} retries=${retries}\n`;
}

/**
 * Append a single line to transcript.md and fsync.
 * Process-internal mutex ensures observers see consistent reads.
 *
 * If a `MemoryMirrorWriter` is provided, the same line is also appended to the
 * unified `<memory_root>/meetings/<date>-<slug>.md` file under the `## Transcript`
 * section. The mirror initializes the file with frontmatter on first write.
 */
export class TranscriptWriter {
  private readonly path: string;
  private chain: Promise<void> = Promise.resolve();
  private linesWritten = 0;
  private readonly mirror: MemoryMirrorWriter | null;

  constructor(path: string, mirror: MemoryMirrorWriter | null = null) {
    this.path = path;
    this.mirror = mirror;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** Serialize concurrent writes through a promise chain. */
  async append(line: string): Promise<void> {
    const task = async (): Promise<void> => {
      const fd = openSync(this.path, "a");
      try {
        writeSync(fd, line);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.linesWritten += 1;
      if (this.mirror) {
        try {
          this.mirror.appendLine(line);
        } catch {
          // Mirror is best-effort; never crash the bot if it fails.
        }
      }
    };
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    await next;
  }

  get count(): number {
    return this.linesWritten;
  }
}

// ---------------------------------------------------------------------------
// Memory-layer mirror: writes a unified <memory_root>/meetings/<slug>.md file
// alongside the per-meeting `transcript.md`. Spec: INTERFACES.md §13.

export interface MemoryMeetingMeta {
  /** Meeting ID, e.g. "2026-04-25-david-roadmap-sync". */
  meeting_id: string;
  /** Meeting title (free text). */
  title: string;
  /** ISO date string YYYY-MM-DD. */
  date: string;
  /** Participant aliases. */
  participants: string[];
  /** Source label (e.g. "discord"). */
  source?: string;
}

/** Lowercased hyphenated slug; alphanumerics only. Matches Python `slugify_for_memory`. */
export function slugifyForMemory(title: string): string {
  const lower = title.trim().toLowerCase();
  let s = lower.replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-");
  s = s.replace(/^-|-$/g, "");
  return s.length > 0 ? s : "untitled";
}

export function memoryMeetingFilename(meta: MemoryMeetingMeta): string {
  return `${meta.date}-${slugifyForMemory(meta.title)}.md`;
}

/**
 * Append-only writer for the unified memory meeting file. Initializes the file
 * with YAML frontmatter and a `## Transcript` heading on first append.
 */
export class MemoryMirrorWriter {
  private readonly path: string;
  private initialized = false;

  constructor(memoryRoot: string, meta: MemoryMeetingMeta) {
    const dir = join(memoryRoot, "meetings");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.path = join(dir, memoryMeetingFilename(meta));
    this.initialized = existsSync(this.path);
    if (!this.initialized) {
      const fm = renderFrontmatter(meta);
      writeFileSync(this.path, fm + "\n## Transcript\n\n", "utf8");
      this.initialized = true;
    }
  }

  /** Append a single transcript line (synchronous; called from inside the
   * transcript writer's serialized chain so we don't need our own mutex). */
  appendLine(line: string): void {
    const fd = openSync(this.path, "a");
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  get filePath(): string {
    return this.path;
  }
}

function renderFrontmatter(meta: MemoryMeetingMeta): string {
  const participants = meta.participants.map((p) => `  - ${p}`).join("\n");
  const source = meta.source ?? "discord";
  return [
    "---",
    `date: ${meta.date}`,
    `title: ${jsonString(meta.title)}`,
    `source: ${source}`,
    `meeting_id: ${meta.meeting_id}`,
    "participants:",
    participants || "  []",
    "---",
    "",
  ].join("\n");
}

function jsonString(s: string): string {
  // YAML-safe quoted string. JSON.stringify gives us correct escaping for any
  // input. Works because YAML accepts JSON-style double-quoted strings.
  return JSON.stringify(s);
}
