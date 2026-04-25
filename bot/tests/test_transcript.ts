// Unit tests for transcript formatter + writer.

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatLine,
  formatSttFailedLine,
  formatTimestamp,
  sanitizeText,
  TranscriptWriter,
} from "../src/transcript.js";

describe("formatTimestamp", () => {
  it("zero-pads HH:MM:SS", () => {
    const d = new Date();
    d.setHours(7, 3, 9);
    expect(formatTimestamp(d)).toBe("[07:03:09]");
  });
});

describe("sanitizeText", () => {
  it("collapses LF to U+2424", () => {
    expect(sanitizeText("a\nb")).toBe("a\u2424b");
  });
  it("collapses CRLF to U+2424", () => {
    expect(sanitizeText("a\r\nb")).toBe("a\u2424b");
  });
  it("trims trailing whitespace", () => {
    expect(sanitizeText("hi   ")).toBe("hi");
  });
});

describe("formatLine", () => {
  it("matches spec [HH:MM:SS] alias: text", () => {
    const d = new Date();
    d.setHours(19, 2, 14);
    const line = formatLine("daizhe", "所以我们先只做 Discord 对吧？", d);
    expect(line).toBe("[19:02:14] daizhe: 所以我们先只做 Discord 对吧？\n");
  });
  it("escapes embedded newlines", () => {
    const d = new Date();
    d.setHours(19, 0, 0);
    const line = formatLine("daizhe", "line1\nline2", d);
    expect(line).toBe("[19:00:00] daizhe: line1\u2424line2\n");
  });
});

describe("formatSttFailedLine", () => {
  it("matches spec STT_FAILED format", () => {
    const d = new Date();
    d.setHours(19, 3, 1);
    const line = formatSttFailedLine(42, "timeout", 3, d);
    expect(line).toBe("[19:03:01] [STT_FAILED]: chunk_id=42 reason=timeout retries=3\n");
  });
});

describe("TranscriptWriter", () => {
  it("appends and serializes concurrent writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmi-tx-"));
    const path = join(dir, "transcript.md");
    const writer = new TranscriptWriter(path);
    await Promise.all([
      writer.append("[19:00:00] a: one\n"),
      writer.append("[19:00:01] a: two\n"),
      writer.append("[19:00:02] a: three\n"),
    ]);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBe(3);
    expect(writer.count).toBe(3);
  });
});
