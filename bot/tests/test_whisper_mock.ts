// Whisper client tests with mocked fetch — no network.

import { describe, it, expect, vi } from "vitest";
import { WhisperClient, pcm16ToWav } from "../src/whisper.js";

function silentPcm(seconds = 2): Buffer {
  return Buffer.alloc(16000 * 2 * seconds);
}

describe("pcm16ToWav", () => {
  it("emits valid 44-byte RIFF header", () => {
    const wav = pcm16ToWav(silentPcm(1));
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.subarray(12, 16).toString()).toBe("fmt ");
    expect(wav.subarray(36, 40).toString()).toBe("data");
    expect(wav.readUInt32LE(24)).toBe(16000);
  });
});

describe("WhisperClient.transcribe", () => {
  it("returns text on success", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "hello world" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = new WhisperClient({
      apiKey: "sk-test",
      model: "whisper-1",
      language: null,
      fetchImpl: fakeFetch,
      sleepMs: () => Promise.resolve(),
    });
    const r = await client.transcribe(silentPcm(2));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("hello world");
  });

  it("retries 3x on 5xx then returns failure", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response("upstream error", { status: 503 }),
    ) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const client = new WhisperClient({
      apiKey: "sk-test",
      model: "whisper-1",
      language: null,
      fetchImpl: fakeFetch,
      sleepMs: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const r = await client.transcribe(silentPcm(2));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.attempts).toBe(3);
      expect(r.reason).toBe("http_503");
    }
    expect((fakeFetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("succeeds on retry after one transient failure", async () => {
    let calls = 0;
    const fakeFetch = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(new Response("err", { status: 500 }));
      return Promise.resolve(
        new Response(JSON.stringify({ text: "recovered" }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    const client = new WhisperClient({
      apiKey: "sk-test",
      model: "whisper-1",
      language: null,
      fetchImpl: fakeFetch,
      sleepMs: () => Promise.resolve(),
    });
    const r = await client.transcribe(silentPcm(2));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("recovered");
  });
});
