// Voice channel join + per-user audio capture.
// Spec: INTERFACES.md §5.3, §10.2.

import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import prism from "prism-media";
import { Readable } from "node:stream";
import { MeetingContext } from "./meeting.js";
import { TranscriptWriter, formatLine, formatSttFailedLine } from "./transcript.js";
import { StatusWriter } from "./status.js";
import type { IWhisperClient } from "./whisper.js";

export interface VoiceCaptureOptions {
  meeting: MeetingContext;
  transcript: TranscriptWriter;
  status: StatusWriter;
  whisper: IWhisperClient;
  chunkSeconds: number;
  /** Max reconnect attempts; spec §10.2 says 3. */
  maxReconnects?: number;
  /** Backoff schedule in ms; spec §10.2 says 5s/15s/30s. */
  reconnectBackoffMs?: number[];
  log: (msg: string) => void;
}

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // Int16

/** One subscription per Discord user. */
class UserStream {
  private buffer: Buffer[] = [];
  private bufferedBytes = 0;
  private flushing = false;
  private chunkCounter = 0;
  private readonly bytesPerChunk: number;

  constructor(
    private readonly userId: string,
    private readonly opts: VoiceCaptureOptions,
  ) {
    this.bytesPerChunk = SAMPLE_RATE * BYTES_PER_SAMPLE * opts.chunkSeconds;
  }

  feed(pcm: Buffer): void {
    this.buffer.push(pcm);
    this.bufferedBytes += pcm.length;
    if (this.bufferedBytes >= this.bytesPerChunk) {
      void this.flush(false);
    }
  }

  /** Flush remaining audio (called when user stops speaking or bot leaves). */
  async flush(final: boolean): Promise<void> {
    if (this.flushing) return;
    if (this.bufferedBytes === 0) return;
    if (!final && this.bufferedBytes < this.bytesPerChunk) return;
    this.flushing = true;
    try {
      const pcm = Buffer.concat(this.buffer);
      this.buffer = [];
      this.bufferedBytes = 0;
      this.chunkCounter += 1;
      await this.transcribeAndWrite(pcm, this.chunkCounter);
    } finally {
      this.flushing = false;
    }
  }

  private async transcribeAndWrite(pcm: Buffer, chunkId: number): Promise<void> {
    if (pcm.length < SAMPLE_RATE * BYTES_PER_SAMPLE) {
      // <1s of audio — skip; Whisper hallucinates on silence.
      return;
    }
    const result = await this.opts.whisper.transcribe(pcm);
    if (!result.ok) {
      const line = formatSttFailedLine(chunkId, result.reason, result.attempts);
      await this.opts.transcript.append(line);
      await this.opts.status.pushError(
        "whisper_timeout",
        `chunk_id=${chunkId} reason=${result.reason}`,
      );
      this.opts.log(`whisper failed user=${this.userId} chunk=${chunkId} reason=${result.reason}`);
      return;
    }
    if (result.text.length === 0) return;
    const alias = this.opts.meeting.resolveAlias(this.userId);
    const line = formatLine(alias, result.text);
    await this.opts.transcript.append(line);
  }
}

export class VoiceCapture {
  private connection: VoiceConnection | null = null;
  private channel: VoiceBasedChannel | null = null;
  private streams: Map<string, UserStream> = new Map();
  private reconnects = 0;
  private stopped = false;

  constructor(private readonly opts: VoiceCaptureOptions) {}

  async join(channel: VoiceBasedChannel): Promise<void> {
    this.channel = channel;
    this.stopped = false;
    this.reconnects = 0;
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      // discord.js and @discordjs/voice ship slightly mismatched discord-api-types
      // versions; the adapterCreator is structurally identical. Cast around it.
      adapterCreator: channel.guild
        .voiceAdapterCreator as unknown as Parameters<typeof joinVoiceChannel>[0]["adapterCreator"],
      selfDeaf: false,
      selfMute: true,
    });
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    await this.opts.status.updateBot({
      connected: true,
      voice_channel_id: channel.id,
      listening_since: new Date().toISOString(),
    });
    this.attachReceiver();
    this.attachReconnect();
    this.opts.log(`joined voice channel ${channel.id} guild=${channel.guild.id}`);
  }

  private attachReceiver(): void {
    if (!this.connection) return;
    const receiver = this.connection.receiver;
    receiver.speaking.on("start", (userId: string) => {
      if (this.streams.has(userId)) return;
      const stream = new UserStream(userId, this.opts);
      this.streams.set(userId, stream);
      const opus = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
      });
      const decoder = new prism.opus.Decoder({
        rate: SAMPLE_RATE,
        channels: 1,
        frameSize: 960,
      });
      const pcmStream = (opus as unknown as Readable).pipe(decoder);
      pcmStream.on("data", (chunk: Buffer) => {
        stream.feed(chunk);
      });
      pcmStream.on("end", () => {
        void stream.flush(true);
        this.streams.delete(userId);
      });
      pcmStream.on("error", (err: Error) => {
        this.opts.log(`pcm stream error user=${userId}: ${err.message}`);
        this.streams.delete(userId);
      });
    });
  }

  private attachReconnect(): void {
    if (!this.connection) return;
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.stopped) return;
      const max = this.opts.maxReconnects ?? 3;
      const backoffs = this.opts.reconnectBackoffMs ?? [5_000, 15_000, 30_000];
      try {
        // First try the library's auto-rejoin path (network blip vs evicted).
        await Promise.race([
          entersState(this.connection!, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection!, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Recovered.
        return;
      } catch {
        // Need full rejoin.
      }
      while (this.reconnects < max && !this.stopped) {
        const wait = backoffs[Math.min(this.reconnects, backoffs.length - 1)];
        this.reconnects += 1;
        await this.opts.status.updateBot({ reconnect_count: this.reconnects });
        this.opts.log(`reconnect attempt ${this.reconnects}/${max} after ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        try {
          if (this.channel) await this.join(this.channel);
          this.opts.log(`reconnect succeeded`);
          return;
        } catch (err) {
          this.opts.log(`reconnect failed: ${(err as Error).message}`);
        }
      }
      // Out of retries — fatal.
      await this.opts.status.pushError(
        "voice_disconnect",
        `reconnect failed after ${max} attempts`,
      );
      await this.opts.status.updateBot({ pid: null, connected: false, voice_channel_id: null });
      this.opts.log(`fatal: reconnect exhausted, exiting`);
      process.exit(1);
    });
  }

  async leave(): Promise<void> {
    this.stopped = true;
    // Final flush of any in-flight buffers.
    await Promise.allSettled(
      Array.from(this.streams.values()).map((s) => s.flush(true)),
    );
    this.streams.clear();
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
    if (this.channel) {
      const existing = getVoiceConnection(this.channel.guild.id);
      existing?.destroy();
    }
    await this.opts.status.updateBot({
      connected: false,
      voice_channel_id: null,
      listening_since: null,
    });
    this.opts.log("left voice channel");
  }

  isConnected(): boolean {
    return this.connection !== null;
  }
}
