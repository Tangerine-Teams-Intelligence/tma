// Bot entrypoint. CLI invokes:
//   node bot/dist/index.js --meeting-id=... --meeting-dir=... --config=...
// Spec: INTERFACES.md §5.1.

import { readFileSync, existsSync, mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Client, Events, GatewayIntentBits, Interaction } from "discord.js";
import { loadConfig, resolveEnv } from "./config.js";
import { MeetingContext } from "./meeting.js";
import { TranscriptWriter, formatLine } from "./transcript.js";
import { StatusWriter } from "./status.js";
import { WhisperClient } from "./whisper.js";
import { VoiceCapture } from "./voice.js";
import { registerCommands } from "./commands/index.js";
import { handleJoin } from "./commands/join.js";
import { handleLeave } from "./commands/leave.js";
import { handleStatus } from "./commands/status.js";

interface CliArgs {
  meetingId: string;
  meetingDir: string;
  configPath: string;
  dryRun: boolean;
  dryRunFixture?: string;
  help: boolean;
}

const USAGE = `Tangerine Meeting Assistant — Discord bot

Usage:
  node bot/dist/index.js --meeting-id=<id> --meeting-dir=<path> --config=<path> [options]

Required:
  --meeting-id=<id>          Meeting ID (must match meeting.yaml id).
  --meeting-dir=<path>       Absolute path to the meeting directory.
  --config=<path>            Absolute path to ~/.tmi/config.yaml.

Optional:
  --dry-run                  Skip Discord; simulate audio from --fixture.
  --fixture=<path>           Audio fixture (raw PCM Int16 16kHz mono) for dry-run.
  --help, -h                 Show this message.

Env:
  DISCORD_BOT_TOKEN          Required unless --dry-run.
  OPENAI_API_KEY             Required.`;

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> & { dryRun?: boolean; help?: boolean } = {};
  for (const raw of argv) {
    if (raw === "--help" || raw === "-h") args.help = true;
    else if (raw === "--dry-run") args.dryRun = true;
    else if (raw.startsWith("--meeting-id=")) args.meetingId = raw.slice("--meeting-id=".length);
    else if (raw.startsWith("--meeting-dir=")) args.meetingDir = raw.slice("--meeting-dir=".length);
    else if (raw.startsWith("--config=")) args.configPath = raw.slice("--config=".length);
    else if (raw.startsWith("--fixture=")) args.dryRunFixture = raw.slice("--fixture=".length);
  }
  return {
    meetingId: args.meetingId ?? "",
    meetingDir: args.meetingDir ?? "",
    configPath: args.configPath ?? "",
    dryRun: args.dryRun ?? false,
    dryRunFixture: args.dryRunFixture,
    help: args.help ?? false,
  };
}

function makeLogger(meetingDir: string): (msg: string) => void {
  const path = join(meetingDir, ".tmi", "bot.log");
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return (msg: string): void => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
      const fd = openSync(path, "a");
      writeSync(fd, line);
      closeSync(fd);
    } catch {
      /* ignore */
    }
    process.stderr.write(line);
  };
}

async function runDryRun(args: CliArgs, log: (m: string) => void): Promise<void> {
  log(`dry-run mode: meeting-id=${args.meetingId}`);
  const meeting = new MeetingContext(args.meetingDir);
  const transcript = new TranscriptWriter(meeting.transcriptPath);
  const status = new StatusWriter(meeting.statusPath);
  await status.updateBot({
    pid: process.pid,
    started_at: new Date().toISOString(),
    voice_channel_id: "DRY-RUN",
    connected: true,
    listening_since: new Date().toISOString(),
  });
  // If a fixture was provided, write a single deterministic line; otherwise
  // emit a synthetic line so D5's E2E can assert on output.
  const aliases = meeting.participantAliases();
  const alias = aliases[0] ?? "GUEST:1";
  const text = args.dryRunFixture
    ? `dry-run audio from ${args.dryRunFixture}`
    : "dry-run synthetic transcript line";
  await transcript.append(formatLine(alias, text));
  await status.updateBot({ lines_written: transcript.count });
  log(`dry-run wrote 1 transcript line as alias=${alias}`);
  await status.updateBot({ pid: null, connected: false, voice_channel_id: null });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!args.meetingId || !args.meetingDir || !args.configPath) {
    process.stderr.write(`missing required flag\n${USAGE}\n`);
    process.exit(1);
  }
  args.meetingDir = resolve(args.meetingDir);
  args.configPath = resolve(args.configPath);

  const log = makeLogger(args.meetingDir);
  log(`bot starting pid=${process.pid} meeting=${args.meetingId}`);

  if (args.dryRun) {
    await runDryRun(args, log);
    return;
  }

  const config = loadConfig(args.configPath);
  const meeting = new MeetingContext(args.meetingDir);
  if (meeting.meeting.id !== args.meetingId) {
    log(
      `mismatch: --meeting-id=${args.meetingId} but meeting.yaml id=${meeting.meeting.id}`,
    );
    process.exit(1);
  }

  const transcript = new TranscriptWriter(meeting.transcriptPath);
  const status = new StatusWriter(meeting.statusPath);
  const whisper = new WhisperClient({
    apiKey: resolveEnv(config.whisper.api_key_env),
    model: config.whisper.model,
    language: config.whisper.language,
  });
  const capture = new VoiceCapture({
    meeting,
    transcript,
    status,
    whisper,
    chunkSeconds: config.whisper.chunk_seconds,
    log,
  });

  const token = resolveEnv(config.discord.bot_token_env);
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  client.once(Events.ClientReady, async (c) => {
    log(`logged in as ${c.user.tag} (${c.user.id})`);
    try {
      await registerCommands({
        token,
        appId: c.user.id,
        guildId: config.discord.guild_id,
        prefix: config.discord.command_prefix,
        log,
      });
    } catch (err) {
      log(`command registration failed: ${(err as Error).message}`);
    }
    await status.updateBot({
      pid: process.pid,
      started_at: new Date().toISOString(),
      connected: false,
      voice_channel_id: null,
    });
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guildId) return;
    const prefix = config.discord.command_prefix;
    try {
      if (interaction.commandName === `${prefix}-join`) {
        await handleJoin(interaction, capture, meeting);
        if (capture.isConnected()) {
          // Periodic lines_written update.
          await status.updateBot({ lines_written: transcript.count });
        }
      } else if (interaction.commandName === `${prefix}-leave`) {
        await handleLeave(interaction, capture, meeting, log);
      } else if (interaction.commandName === `${prefix}-status`) {
        await handleStatus(interaction, meeting);
      }
    } catch (err) {
      log(`interaction error: ${(err as Error).message}`);
    }
  });

  // Periodic status flush every 30s per spec §5.4.
  const flushTimer = setInterval(() => {
    void status.updateBot({
      lines_written: transcript.count,
      connected: capture.isConnected(),
    });
  }, 30_000);
  flushTimer.unref();

  // Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    log(`received ${signal}, shutting down`);
    clearInterval(flushTimer);
    try {
      await capture.leave();
    } catch (err) {
      log(`shutdown leave error: ${(err as Error).message}`);
    }
    try {
      await status.updateBot({ pid: null, connected: false });
    } catch {
      /* ignore */
    }
    try {
      client.destroy();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("uncaughtException", async (err) => {
    log(`uncaughtException: ${err.message}`);
    try {
      await status.pushError("uncaught_exception", err.message);
      await status.updateBot({ pid: null, connected: false });
    } catch {
      /* ignore */
    }
    process.exit(1);
  });

  await client.login(token);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
