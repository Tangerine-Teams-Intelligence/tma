// OpenAI Whisper API client. Non-streaming POST per chunk.
// Spec: INTERFACES.md §10.1 — 3x retry with backoff (1s, 2s, 4s).

export interface WhisperResult {
  ok: true;
  text: string;
}

export interface WhisperFailure {
  ok: false;
  reason: string;
  attempts: number;
}

export interface WhisperOptions {
  apiKey: string;
  model: string;
  language: string | null;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Override sleep for tests. */
  sleepMs?: (ms: number) => Promise<void>;
  /** Per-request wall-clock timeout. */
  requestTimeoutMs?: number;
}

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

export class WhisperClient {
  private readonly opts: Required<WhisperOptions>;

  constructor(opts: WhisperOptions) {
    this.opts = {
      apiKey: opts.apiKey,
      model: opts.model,
      language: opts.language,
      fetchImpl: opts.fetchImpl ?? fetch,
      sleepMs: opts.sleepMs ?? defaultSleep,
      requestTimeoutMs: opts.requestTimeoutMs ?? 30_000,
    } as Required<WhisperOptions>;
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

function shortReason(s: string): string {
  if (s.includes("aborted") || s.toLowerCase().includes("timeout")) return "timeout";
  if (s.startsWith("http_")) return s.split(":")[0];
  return s.slice(0, 60);
}
