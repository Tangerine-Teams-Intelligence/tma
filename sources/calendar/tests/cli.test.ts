// CLI smoke tests.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tg-cal-cli-"));
}

describe("cli (in-process)", () => {
  let writes: string[] = [];
  let origWrite: any;

  beforeEach(() => {
    writes = [];
    origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: any) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as any;
  });
  afterEach(() => {
    process.stdout.write = origWrite;
  });

  it("prints help with no args", async () => {
    const code = await main([]);
    expect(code).toBe(0);
    const out = writes.join("");
    expect(out).toContain("Tangerine — Calendar source connector");
    expect(out).toContain("add-ical");
    expect(out).toContain("poll");
    expect(out).toContain("watch");
    expect(out).toContain("briefs");
  });

  it("add-ical add + list + remove flow", async () => {
    const root = tmpRoot();
    const url = "https://calendar.google.com/calendar/ical/test/public/basic.ics";
    let code = await main(["add-ical", url, "--name=Acme Eng", `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("added ical-");

    writes.length = 0;
    code = await main(["add-ical", url, `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("already configured");

    writes.length = 0;
    code = await main(["list", `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("ical-");
    expect(writes.join("")).toContain("Acme Eng");
    expect(writes.join("")).toContain(url);

    // Need to find the id we generated to remove it.
    const idMatch = /ical-([a-z0-9]+)/.exec(writes.join(""));
    expect(idMatch).toBeTruthy();
    const id = `ical-${idMatch![1]}`;
    writes.length = 0;
    code = await main(["remove", id, `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain(`removed ${id}`);
  });

  it("add-ical rejects non-http url", async () => {
    const root = tmpRoot();
    const code = await main(["add-ical", "ftp://nope/x.ics", `--memory-root=${root}`]);
    expect(code).toBe(1);
    expect(writes.join("")).toContain("invalid url");
  });

  it("add-google reports Stage 2 not implemented", async () => {
    const code = await main(["add-google"]);
    expect(code).toBe(1);
    expect(writes.join("")).toContain("Stage 2");
  });

  it("list with no calendars prints helpful hint", async () => {
    const root = tmpRoot();
    const code = await main(["list", `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("no calendars configured");
  });

  it("remove non-existent calendar fails", async () => {
    const root = tmpRoot();
    const code = await main(["remove", "ical-nope", `--memory-root=${root}`]);
    expect(code).toBe(1);
    expect(writes.join("")).toContain("not configured");
  });

  it("unknown command exits non-zero with help", async () => {
    const code = await main(["banana"]);
    expect(code).toBe(1);
    expect(writes.join("")).toContain("unknown command");
  });

  it("briefs prints empty msg when no calendars", async () => {
    const root = tmpRoot();
    const code = await main(["briefs", `--memory-root=${root}`]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("no upcoming events");
  });
});
