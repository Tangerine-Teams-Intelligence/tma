#!/usr/bin/env node
// CLI for the Calendar source connector. Verbs:
//   tangerine-calendar add-ical <url> [--name=...] [--projects=a,b]
//   tangerine-calendar add-google                       (Stage 2 / not implemented)
//   tangerine-calendar list
//   tangerine-calendar remove <id>
//   tangerine-calendar poll [--dry-run]
//   tangerine-calendar watch
//   tangerine-calendar briefs [--lead=5] [--window=10]  inspect upcoming brief triggers
//
// Common flags:
//   --memory-root=<path>   override memory root
//   --help / -h

import { stdout as output } from "node:process";
import {
  defaultMemoryRoot,
  makePaths,
  readConfig,
  writeConfig,
} from "./memory.js";
import { runOnce, runForever } from "./poll.js";
import { pollBriefTriggers } from "./briefs.js";
import type { CalendarConfig } from "./types.js";

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

const HELP = `Tangerine — Calendar source connector

Usage:
  tangerine-calendar add-ical <url> [--name=...] [--projects=a,b]   add an iCal feed
  tangerine-calendar add-google                                     OAuth flow (Stage 2 / NOT IMPLEMENTED)
  tangerine-calendar list                                           list configured calendars
  tangerine-calendar remove <id>                                    remove a calendar
  tangerine-calendar poll [--dry-run]                               one-shot ingest
  tangerine-calendar watch                                          daemon — poll forever
  tangerine-calendar briefs [--lead=5] [--window=10]                inspect upcoming brief triggers

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

function hashUrl(url: string): string {
  // Stable, short id from URL — not crypto-strong, just collision-resistant
  // enough to namespace per-feed config + cursor.
  let h = 5381;
  for (let i = 0; i < url.length; i++) {
    h = ((h << 5) + h + url.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 10);
}

async function cmdAddIcal(args: Argv): Promise<number> {
  const url = args.positional[1];
  if (!url) {
    output.write("usage: tangerine-calendar add-ical <url> [--name=...] [--projects=a,b]\n");
    return 1;
  }
  if (!/^https?:\/\//.test(url)) {
    output.write(`invalid url: ${url} (must start with http:// or https://)\n`);
    return 1;
  }
  const nameRaw = args.flags["name"];
  const projectsRaw = args.flags["projects"];
  const projects = typeof projectsRaw === "string"
    ? projectsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const paths = makePaths(root(args.flags));
  const cfg = await readConfig(paths);
  const id = `ical-${hashUrl(url)}`;
  if (cfg.calendars.find((c) => c.id === id)) {
    output.write(`already configured: ${id}\n`);
    return 0;
  }
  const entry: CalendarConfig = {
    id,
    provider: "ical",
    url,
    ...(typeof nameRaw === "string" ? { name: nameRaw } : {}),
    ...(projects ? { projects } : {}),
  };
  cfg.calendars.push(entry);
  await writeConfig(paths, cfg);
  output.write(`added ${id}${typeof nameRaw === "string" ? ` (${nameRaw})` : ""}${projects ? ` projects=[${projects.join(",")}]` : ""}\n`);
  return 0;
}

async function cmdAddGoogle(): Promise<number> {
  output.write(
    "Google Calendar OAuth is reserved for Stage 2 — not yet implemented.\n" +
      "Use `tangerine-calendar add-ical <url>` with a Google Calendar 'public ical' URL for now:\n" +
      "  https://calendar.google.com/calendar/ical/<your-id>/public/basic.ics\n",
  );
  return 1;
}

async function cmdRemove(args: Argv): Promise<number> {
  const id = args.positional[1];
  if (!id) {
    output.write("usage: tangerine-calendar remove <id>\n");
    return 1;
  }
  const paths = makePaths(root(args.flags));
  const cfg = await readConfig(paths);
  const before = cfg.calendars.length;
  cfg.calendars = cfg.calendars.filter((c) => c.id !== id);
  if (cfg.calendars.length === before) {
    output.write(`not configured: ${id}\n`);
    return 1;
  }
  await writeConfig(paths, cfg);
  output.write(`removed ${id}\n`);
  return 0;
}

async function cmdList(args: Argv): Promise<number> {
  const paths = makePaths(root(args.flags));
  const cfg = await readConfig(paths);
  if (cfg.calendars.length === 0) {
    output.write("no calendars configured. add one with `tangerine-calendar add-ical <url>`\n");
    return 0;
  }
  for (const c of cfg.calendars) {
    const name = c.name ? ` ${c.name}` : "";
    const proj = c.projects?.length ? ` projects=[${c.projects.join(",")}]` : "";
    const url = c.url ? ` url=${c.url}` : "";
    output.write(`  ${c.id} (${c.provider})${name}${proj}${url}\n`);
  }
  return 0;
}

async function cmdPoll(args: Argv): Promise<number> {
  const dryRun = args.flags["dry-run"] === true;
  const r = await runOnce({ memoryRoot: root(args.flags), dryRun });
  if (dryRun) {
    output.write(`[dry-run] processed ${r.calendars.length} calendar(s) — ${r.totalAtoms} atom(s) generated, none written\n`);
  } else {
    output.write(`processed ${r.calendars.length} calendar(s) — ${r.totalAtoms} atom(s) seen, ${r.totalWritten} new\n`);
  }
  for (const c of r.calendars) {
    const tag = c.calendarName ? `${c.calendar} (${c.calendarName})` : c.calendar;
    if (c.error) {
      output.write(`  ${tag}: ERROR ${c.error}\n`);
    } else {
      output.write(`  ${tag}: ${c.atomCount} atoms${dryRun ? "" : `, ${c.written} written, ${c.skipped} dup`}${c.newCursor ? `, cursor=${c.newCursor}` : ""}\n`);
    }
  }
  return r.calendars.some((x) => x.error) ? 2 : 0;
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

async function cmdBriefs(args: Argv): Promise<number> {
  const triggers = await pollBriefTriggers({ memoryRoot: root(args.flags) });
  if (triggers.length === 0) {
    output.write("no upcoming events in the brief window\n");
    return 0;
  }
  for (const t of triggers) {
    output.write(`  ${t.start}  T-${t.minutesUntil}m  ${t.title}  [${t.calendar}]\n`);
  }
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.help || args.positional.length === 0) {
    output.write(HELP);
    return 0;
  }
  const verb = args.positional[0];
  try {
    if (verb === "add-ical") return await cmdAddIcal(args);
    if (verb === "add-google") return await cmdAddGoogle();
    if (verb === "list") return await cmdList(args);
    if (verb === "remove") return await cmdRemove(args);
    if (verb === "poll") return await cmdPoll(args);
    if (verb === "watch") return await cmdWatch(args);
    if (verb === "briefs") return await cmdBriefs(args);
  } catch (err) {
    output.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
  output.write(`unknown command: ${verb}\n\n${HELP}`);
  return 1;
}

const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
               process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts");
if (isMain) {
  main().then((code) => process.exit(code));
}
