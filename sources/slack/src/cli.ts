#!/usr/bin/env node
// CLI for the Slack source connector. Verbs:
//   tangerine-slack auth set [--mode=bot|user]
//   tangerine-slack auth status
//   tangerine-slack channels add <id|#name> [--projects=a,b,c]
//   tangerine-slack channels remove <id>
//   tangerine-slack channels list [--remote]
//   tangerine-slack poll [--dry-run]
//   tangerine-slack watch
//
// Common flags:
//   --memory-root=<path>   override memory root
//   --help / -h
//
// Auth set reads the token from stdin to avoid leaving it in shell history /
// process listings. Falls back to TTY prompt if stdin is a TTY.

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { setToken, getToken, validateToken, hasToken } from "./auth.js";
import {
  defaultMemoryRoot,
  makePaths,
  readConfig,
  writeConfig,
} from "./memory.js";
import { runOnce, runForever } from "./poll.js";
import { makeClient } from "./client.js";
import { listRemoteChannels } from "./ingest/channels.js";
import type { ChannelConfig } from "./types.js";

interface Argv {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Argv {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      flags.help = true;
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const HELP = `Tangerine — Slack source connector

Usage:
  tangerine-slack auth set [--mode=bot|user]      set/refresh Slack token (stdin)
  tangerine-slack auth status                     check stored token validity
  tangerine-slack channels add <id|#name>         add a channel to ingest
                              [--projects=a,b]    optionally tag every atom with these projects
  tangerine-slack channels remove <id>            remove a channel
  tangerine-slack channels list [--remote]        list configured (or remote) channels
  tangerine-slack poll [--dry-run]                one-shot ingest of all configured channels
  tangerine-slack watch                           daemon — poll forever

Common:
  --memory-root=<path>     override memory root (default: ~/.tangerine-memory)
  --help, -h               this message

Env:
  MEMORY_ROOT              same as --memory-root
  TARGET_REPO              <TARGET_REPO>/memory used as memory root if MEMORY_ROOT unset
`;

function root(flags: Record<string, string | boolean>): string {
  const m = flags["memory-root"];
  return typeof m === "string" && m.length > 0 ? m : defaultMemoryRoot();
}

async function readSecret(prompt: string): Promise<string> {
  if (input.isTTY) {
    const rl = createInterface({ input, output });
    try {
      output.write(`(input will be visible) ${prompt}`);
      const t = await rl.question("");
      return t.trim();
    } finally {
      rl.close();
    }
  }
  const chunks: Buffer[] = [];
  for await (const c of input) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function cmdAuthSet(args: Argv): Promise<number> {
  const modeRaw = args.flags["mode"];
  const mode: "bot" | "user" = modeRaw === "user" ? "user" : "bot";
  const t = await readSecret(
    `Paste Slack ${mode === "user" ? "User" : "Bot"} token (xox${mode === "user" ? "p" : "b"}-…) and press enter: `,
  );
  if (!t) {
    output.write("no token provided\n");
    return 1;
  }
  const v = await validateToken(t);
  if (!v.ok) {
    output.write(`token validation failed: ${v.reason}\n`);
    return 2;
  }
  try {
    await setToken(t, mode);
  } catch (err) {
    output.write(`save failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  output.write(`token saved for ${v.user}@${v.team} (${mode} mode)\n`);
  return 0;
}

async function cmdAuthStatus(): Promise<number> {
  const has = (await hasToken("bot")) || (await hasToken("user"));
  if (!has) {
    output.write("no token configured\n");
    return 1;
  }
  const t = (await getToken("bot")) ?? (await getToken("user"));
  if (!t) {
    output.write("no token configured\n");
    return 1;
  }
  const v = await validateToken(t);
  if (v.ok) {
    output.write(`OK — token belongs to ${v.user}@${v.team}\n`);
    return 0;
  }
  output.write(`FAIL — ${v.reason}\n`);
  return 2;
}

function parseChannelArg(arg: string): { id?: string; name?: string } {
  // Accept either Slack id (C0XXXXXXX) or #channel-name. Names are stored
  // alongside id only after a `--remote` lookup; for now we accept either.
  if (/^C[A-Z0-9]+$/.test(arg)) return { id: arg };
  if (arg.startsWith("#")) return { name: arg.slice(1) };
  return { name: arg };
}

async function cmdChannelsAdd(args: Argv): Promise<number> {
  const raw = args.positional[2];
  if (!raw) {
    output.write("usage: tangerine-slack channels add <C012ABCDEFG | #name> [--projects=a,b,c]\n");
    return 1;
  }
  const parsed = parseChannelArg(raw);
  if (!parsed.id && !parsed.name) {
    output.write(`invalid channel: ${raw}\n`);
    return 1;
  }
  const projectsRaw = args.flags["projects"];
  const projects = typeof projectsRaw === "string"
    ? projectsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const paths = makePaths(root(args.flags));
  const cfg = await readConfig(paths);
  const matchKey = parsed.id ?? parsed.name;
  if (cfg.channels.find((c) => c.id === matchKey || c.name === matchKey)) {
    output.write(`already configured: ${matchKey}\n`);
    return 0;
  }
  const entry: ChannelConfig = parsed.id
    ? { id: parsed.id }
    : { id: parsed.name!, name: parsed.name }; // name-only entries treat the name as the id placeholder
  if (projects) entry.projects = projects;
  if (parsed.name && parsed.id) entry.name = parsed.name;
  cfg.channels.push(entry);
  await writeConfig(paths, cfg);
  output.write(`added ${matchKey}${projects ? ` (projects: ${projects.join(", ")})` : ""}\n`);
  return 0;
}

async function cmdChannelsRemove(args: Argv): Promise<number> {
  const id = args.positional[2];
  if (!id) {
    output.write("usage: tangerine-slack channels remove <id>\n");
    return 1;
  }
  const paths = makePaths(root(args.flags));
  const cfg = await readConfig(paths);
  const before = cfg.channels.length;
  cfg.channels = cfg.channels.filter((c) => c.id !== id && c.name !== id);
  if (cfg.channels.length === before) {
    output.write(`not configured: ${id}\n`);
    return 1;
  }
  await writeConfig(paths, cfg);
  output.write(`removed ${id}\n`);
  return 0;
}

async function cmdChannelsList(args: Argv): Promise<number> {
  if (args.flags["remote"] === true) {
    const t = (await getToken("bot")) ?? (await getToken("user"));
    if (!t) {
      output.write("no token configured. run `tangerine-slack auth set` first\n");
      return 1;
    }
    try {
      const client = makeClient(t);
      const channels = await listRemoteChannels(client);
      for (const c of channels) {
        output.write(`  ${c.id}  #${c.name}\n`);
      }
      return 0;
    } catch (err) {
      output.write(`remote list failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }
  const paths = makePaths(root(args.flags));
  const cfg = await readConfig(paths);
  if (cfg.channels.length === 0) {
    output.write("no channels configured. add one with `tangerine-slack channels add <id|#name>`\n");
    return 0;
  }
  for (const c of cfg.channels) {
    const name = c.name ? ` #${c.name}` : "";
    const proj = c.projects?.length ? ` projects=[${c.projects.join(",")}]` : "";
    const cur = c.cursor ? ` cursor=${c.cursor}` : "";
    output.write(`  ${c.id}${name}${proj}${cur}\n`);
  }
  return 0;
}

async function cmdPoll(args: Argv): Promise<number> {
  const dryRun = args.flags["dry-run"] === true;
  const r = await runOnce({ memoryRoot: root(args.flags), dryRun });
  if (dryRun) {
    output.write(`[dry-run] processed ${r.channels.length} channel(s) — ${r.totalAtoms} atom(s) generated, none written\n`);
  } else {
    output.write(`processed ${r.channels.length} channel(s) — ${r.totalAtoms} atom(s) seen, ${r.totalWritten} new\n`);
  }
  for (const c of r.channels) {
    const tag = c.channelName ? `${c.channel} (#${c.channelName})` : c.channel;
    if (c.error) {
      output.write(`  ${tag}: ERROR ${c.error}\n`);
    } else {
      output.write(`  ${tag}: ${c.atomCount} atoms${dryRun ? "" : `, ${c.written} written, ${c.skipped} dup`}${c.newCursor ? `, cursor=${c.newCursor}` : ""}\n`);
    }
  }
  return r.channels.some((x) => x.error) ? 2 : 0;
}

async function cmdWatch(args: Argv): Promise<number> {
  const ac = new AbortController();
  const onSig = (): void => ac.abort();
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);
  output.write(`watching — Ctrl+C to stop\n`);
  await runForever({ memoryRoot: root(args.flags) }, ac.signal);
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.help || args.positional.length === 0) {
    output.write(HELP);
    return 0;
  }
  const verb = args.positional[0];
  const sub = args.positional[1];
  try {
    if (verb === "auth" && sub === "set") return await cmdAuthSet(args);
    if (verb === "auth" && sub === "status") return await cmdAuthStatus();
    if (verb === "channels" && sub === "add") return await cmdChannelsAdd(args);
    if (verb === "channels" && sub === "remove") return await cmdChannelsRemove(args);
    if (verb === "channels" && sub === "list") return await cmdChannelsList(args);
    if (verb === "poll") return await cmdPoll(args);
    if (verb === "watch") return await cmdWatch(args);
  } catch (err) {
    output.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
  output.write(`unknown command: ${verb}${sub ? ` ${sub}` : ""}\n\n${HELP}`);
  return 1;
}

const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
               process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts");
if (isMain) {
  main().then((code) => process.exit(code));
}
