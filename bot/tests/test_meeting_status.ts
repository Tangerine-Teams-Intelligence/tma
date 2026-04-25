// Meeting context + status writer tests.

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { MeetingContext } from "../src/meeting.js";
import { StatusWriter } from "../src/status.js";

function makeMeetingDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tmi-mt-"));
  writeFileSync(
    join(dir, "meeting.yaml"),
    yaml.dump({
      schema_version: 1,
      id: "2026-04-24-test",
      title: "test",
      created_at: "2026-04-24T18:00:00+08:00",
      participants: [
        { alias: "daizhe", display_name: "Daizhe", discord_id: "111111111111111111" },
        { alias: "hongyu", display_name: "Hongyu", discord_id: null },
      ],
      target_adapter: "tangerine-main",
    }),
  );
  return dir;
}

describe("MeetingContext.resolveAlias", () => {
  it("returns mapped alias for known discord_id", () => {
    const m = new MeetingContext(makeMeetingDir());
    expect(m.resolveAlias("111111111111111111")).toBe("daizhe");
  });
  it("assigns monotonic GUEST:N for unknown ids", () => {
    const m = new MeetingContext(makeMeetingDir());
    expect(m.resolveAlias("999")).toBe("GUEST:1");
    expect(m.resolveAlias("888")).toBe("GUEST:2");
    expect(m.resolveAlias("999")).toBe("GUEST:1"); // stable
  });
});

describe("StatusWriter", () => {
  it("writes only the bot subtree, preserves siblings", async () => {
    const dir = makeMeetingDir();
    const path = join(dir, "status.yaml");
    writeFileSync(
      path,
      yaml.dump({
        schema_version: 1,
        state: "live",
        observer: { pid: 12345 },
      }),
    );
    const w = new StatusWriter(path);
    await w.updateBot({ pid: 67890, voice_channel_id: "abc", connected: true });
    const after = yaml.load(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(after.state).toBe("live");
    expect((after.observer as { pid: number }).pid).toBe(12345);
    const bot = after.bot as { pid: number; voice_channel_id: string };
    expect(bot.pid).toBe(67890);
    expect(bot.voice_channel_id).toBe("abc");
  });
  it("creates status.yaml when absent", async () => {
    const dir = makeMeetingDir();
    const path = join(dir, "status.yaml");
    expect(existsSync(path)).toBe(false);
    const w = new StatusWriter(path);
    await w.updateBot({ pid: 1 });
    expect(existsSync(path)).toBe(true);
    const data = yaml.load(readFileSync(path, "utf8")) as { bot: { pid: number } };
    expect(data.bot.pid).toBe(1);
  });
  it("pushes errors to both top-level and bot subtree", async () => {
    const dir = makeMeetingDir();
    const path = join(dir, "status.yaml");
    const w = new StatusWriter(path);
    await w.pushError("whisper_timeout", "chunk=1 reason=timeout");
    const data = yaml.load(readFileSync(path, "utf8")) as {
      errors: Array<{ code: string }>;
      bot: { errors: Array<{ code: string }> };
    };
    expect(data.errors[0].code).toBe("whisper_timeout");
    expect(data.bot.errors[0].code).toBe("whisper_timeout");
  });
});
