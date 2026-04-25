// transcript.md formatter + append-with-fsync writer.
// Spec: INTERFACES.md §2.3.

import { openSync, writeSync, fsyncSync, closeSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
 */
export class TranscriptWriter {
  private readonly path: string;
  private chain: Promise<void> = Promise.resolve();
  private linesWritten = 0;

  constructor(path: string) {
    this.path = path;
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
    };
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    await next;
  }

  get count(): number {
    return this.linesWritten;
  }
}
