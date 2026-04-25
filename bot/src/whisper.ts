// Whisper client. Two modes:
//   - "local"  (default): spawn the bundled Python `python -m tmi.transcribe`
//                          on a temp WAV file and parse its stdout JSON.
//   - "openai" (opt-in):   POST audio to OpenAI Whisper API. Kept for users who
//                          want max accuracy or have weak CPUs.
//
// Spec: INTERFACES.md §10.1 — 3x retry with backoff (1s, 2s, 4s) for the OpenAI
// path. Local mode does not retry network errors (there are none); it surfaces
// transcription errors directly so the bot can log + skip.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WhisperResult {
  ok: true;
  text: string;
}

export interface WhisperFailure {
  ok: false;
  reason: string;
  attempts: number;
}

export type WhisperMode = "local" | "openai";

export interface OpenAIWhisperOptions {
  mode?: "openai";
  language: string | null;
  apiKey: string;
  model: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Override sleep for tests. */
  sleepMs?: (ms: number) => Promise<void>;
  /** Per-request wall-clock timeout. */
  requestTimeoutMs?: number;
}

export interface LocalWhisperOptions {
  mode: "local";
  language: string | null;
  /** Absolute path to the bundled Python interpreter (PyInstaller --onedir). */
  pythonExe: string;
  /** Absolute path to the downloaded faster-whisper model directory. */
  modelDir: string;
  /** Per-call wall-clock timeout (ms). Default 60s. */
  timeoutMs?: number;
  /** Override spawn for tests. */
  spawnImpl?: typeof spawn;
}

export type WhisperOptions = OpenAIWhisperOptions | LocalWhisperOptions;

const BACKOFFS_MS = [1000, 2000, 4000];

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap a 16kHz mono PCM Int16 buffer into a minimal WAV container so Whisper
 * can decode it. RIFF header per http://soundfile.sapp.org/doc/WaveFormat/.
 */
export function pcm16ToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

/** Common interface — voice.ts only sees `transcribe(pcm)`. */
export interface IWhisperClient {
  transcribe(pcm: Buffer): Promise<WhisperResult | WhisperFailure>;
}

export function createWhisperClient(opts: WhisperOptions): IWhisperClient {
  if ("mode" in opts && opts.mode === "local") {
    return new LocalWhisperClient(opts);
  }
  return new OpenAIWhisperClient(opts as OpenAIWhisperOptions);
}

// ---------------------------------------------------------------------------
// Local: spawn `<python> -m tmi.transcribe --audio <wav> --model-dir <dir>`
// ---------------------------------------------------------------------------

interface ResolvedLocalOpts {
  language: string | null;
  pythonExe: string;
  modelDir: string;
  timeoutMs: number;
  spawnImpl: typeof spawn;
}

export class LocalWhisperClient implements IWhisperClient {
  private readonly opts: ResolvedLocalOpts;

  constructor(opts: LocalWhisperOptions) {
    this.opts = {
      language: opts.language,
      pythonExe: opts.pythonExe,
      modelDir: opts.modelDir,
      timeoutMs: opts.timeoutMs ?? 60_000,
      spawnImpl: opts.spawnImpl ?? spawn,
    };
  }

  async transcribe(pcm: Buffer): Promise<WhisperResult | WhisperFailure> {
    const wav = pcm16ToWav(pcm);
    const dir = mkdtempSync(join(tmpdir(), "tmi-whisper-"));
    const wavPath = join(dir, "chunk.wav");
    try {
      writeFileSync(wavPath, wav);
      const { stdout, stderr, code } = await this.runOnce(wavPath);
      if (code !== 0) {
        return {
          ok: false,
          reason: shortReason(stderr || `exit_${code}`),
          attempts: 1,
        };
      }
      let parsed: { text?: string };
      try {
        parsed = JSON.parse(stdout) as { text?: string };
      } catch (e) {
        return {
          ok: false,
          reason: shortReason(`parse: ${(e as Error).message}`),
          attempts: 1,
        };
      }
      return { ok: true, text: (parsed.text ?? "").trim() };
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private runOnce(
    wavPath: string,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const args = [
      "-m",
      "tmi.transcribe",
      "--audio",
      wavPath,
      "--model-dir",
      this.opts.modelDir,
    ];
    if (this.opts.language) args.push("--language", this.opts.language);

    return new Promise((resolve) => {
      const proc = this.opts.spawnImpl(this.opts.pythonExe, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, this.opts.timeoutMs);
      proc.stdout?.on("data", (b: Buffer) => {
        stdout += b.toString("utf8");
      });
      proc.stderr?.on("data", (b: Buffer) => {
        stderr += b.toString("utf8");
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: stderr || err.message, code: -1 });
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? -1 });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// OpenAI: POST audio/transcriptions (kept as opt-in fallback)
// ---------------------------------------------------------------------------

interface ResolvedOpenAIOpts {
  apiKey: string;
  model: string;
  language: string | null;
  requestTimeoutMs: number;
  fetchImpl: typeof fetch;
  sleepMs: (ms: number) => Promise<void>;
}

export class OpenAIWhisperClient implements IWhisperClient {
  private readonly opts: ResolvedOpenAIOpts;

  constructor(opts: OpenAIWhisperOptions) {
    this.opts = {
      apiKey: opts.apiKey,
      model: opts.model,
      language: opts.language,
      requestTimeoutMs: opts.requestTimeoutMs ?? 30_000,
      fetchImpl: opts.fetchImpl ?? fetch,
      sleepMs: opts.sleepMs ?? defaultSleep,
    };
  }

  /** Transcribe a 16kHz mono PCM buffer. Retries on timeout/5xx. */
  async transcribe(pcm: Buffer): Promise<WhisperResult | WhisperFailure> {
    const wav = pcm16ToWav(pcm);
    let lastReason = "unknown";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const text = await this.postOnce(wav);
        if (text.length === 0) {
          // Empty transcription = no speech. Treat as success with empty text;
          // caller filters out empty lines.
          return { ok: true, text: "" };
        }
        return { ok: true, text };
      } catch (err) {
        lastReason = err instanceof Error ? err.message : String(err);
        if (attempt < 3) {
          await this.opts.sleepMs(BACKOFFS_MS[attempt - 1]);
        }
      }
    }
    return { ok: false, reason: shortReason(lastReason), attempts: 3 };
  }

  private async postOnce(wav: Buffer): Promise<string> {
    const form = new FormData();
    // Copy into a fresh Uint8Array so the Blob constructor sees a plain
    // ArrayBuffer-backed view (Node Buffer pools can be SharedArrayBuffer-typed
    // under recent @types/node).
    const bytes = new Uint8Array(wav.byteLength);
    bytes.set(wav);
    const blob = new Blob([bytes], { type: "audio/wav" });
    form.append("file", blob, "chunk.wav");
    form.append("model", this.opts.model);
    if (this.opts.language) form.append("language", this.opts.language);
    form.append("response_format", "json");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.requestTimeoutMs);
    try {
      const res = await this.opts.fetchImpl(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.opts.apiKey}` },
          body: form,
          signal: ctrl.signal,
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (res.status >= 500 || res.status === 408 || res.status === 429) {
          throw new Error(`http_${res.status}: ${body.slice(0, 200)}`);
        }
        // 4xx other than rate limit = non-retryable but we still return as failure.
        throw new Error(`http_${res.status}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as { text?: string };
      return (data.text ?? "").trim();
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Backwards-compatible alias. Existing code/tests may import `WhisperClient`. */
export const WhisperClient = OpenAIWhisperClient;

function shortReason(s: string): string {
  if (s.includes("aborted") || s.toLowerCase().includes("timeout")) return "timeout";
  if (s.startsWith("http_")) return s.split(":")[0];
  return s.slice(0, 60);
}
