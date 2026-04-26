#!/usr/bin/env node
// CLI for the Linear source connector. Verbs:
//   tangerine-linear auth set
//   tangerine-linear auth status
//   tangerine-linear teams list
//   tangerine-linear teams add <team-key-or-uuid> [--projects=a,b,c]
//   tangerine-linear teams remove <team-key>
//   tangerine-linear poll [--dry-run]
//   tangerine-linear watch
//
// Common flags:
//   --memory-root=<path>   override memory root
//   --help / -h
//
// `teams list` queries Linear for available teams (so the user can pick one
// to subscribe to). `teams add` accepts either the team UUID or the team key
// (e.g. "ENG"); we resolve the key into the UUID via the API on add.

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { setToken, getToken, validateToken, hasToken } from "./auth.js";
import { defaultMemoryRoot, makePaths, readConfig, writeConfig } from "./memory.js";
import { runOnce, runForever } from "./poll.js";
import { makeClient, type LinearLike } from "./client.js";
import type { TeamConfig } from "./types.js";

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

const HELP = `Tangerine — Linear source connector

Usage:
  tangerine-linear auth set                       set/refresh PAT (reads from stdin)
  tangerine-linear auth status                    check stored PAT validity
  tangerine-linear teams list                     list teams visible to your PAT
  tangerine-linear teams add <team>               subscribe to a team (key or UUID)
                              [--projects=a,b]    optionally tag every atom with these projects
  tangerine-linear teams remove <team>            unsubscribe (by key)
  tangerine-linear poll [--dry-run]               one-shot ingest of all configured teams
  tangerine-linear watch                          daemon — poll forever

Common:
  --memory-root=<path>     override memory root (default: ~/.tangerine-memory)
  --help, -h               this message

Env:
  MEMORY_ROOT              same as --memory-root
  TARGET_REPO              <TARGET_REPO>/memory used as memory root if MEMORY_ROOT unset
  PYTHON_BIN               override python invocation for emit-atom (default: python)
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

async function cmdAuthSet(): Promise<number> {
  const t = await readSecret("Paste Linear PAT and press enter: ");
  if (!t) {
    output.write("no token provided\n");
    return 1;
  }
  const v = await validateToken(t);
  if (!v.ok) {
    output.write(`token validation failed: ${v.reason}\n`);
    return 2;
  }
  await setToken(t);
  output.write(`token saved for ${v.user}\n`);
  return 0;
}

async function cmdAuthStatus(): Promise<number> {
  const has = await hasToken();
  if (!has) {
    output.write("no token configured\n");
    return 1;
  }
  const t = await getToken();
  if (!t) {
    output.write("no token configured\n");
    return 1;
  }
  const v = await validateToken(t);
  if (v.ok) {
    output.write(`OK — token belongs to ${v.user}\n`);
    return 0;
  }
  output.write(`FAIL — ${v.reason}\n`);
  return 2;
}

interface TeamsCmdOpts {
  /** Tests pass a stub client to avoid touching the real Linear API. */
  client?: LinearLike;
}

async function makeAuthedClient(opts: TeamsCmdOpts): Promise<LinearLike> {
  if (opts.client) return opts.client;
  const t = await getToken();
  if (!t) throw new Error("No Linear PAT configured. Run `tangerine-linear auth set`.");
  return makeClient(t);
}

async function cmdTeamsList(args: Argv, opts: TeamsCmdOpts = {}): Promise<number> {
  let client: LinearLike;
  try {
    client = await makeAuthedClient(opts);
  } catch (err) {
    output.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  let teams;
  try {
    teams = await client.listTeams();
  } catch (err) {
    output.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (teams.length === 0) {
    output.write("no teams visible to this token\n");
    return 0;
  }
  // Already-configured teams get a `*` next to their entry.
  const cfg = await readConfig(makePaths(root(args.flags)));
  const subscribed = new Set(cfg.teams.map((t) => t.uuid));
  for (const t of teams) {
    const star = subscribed.has(t.id) ? "*" : " ";
    output.write(`  ${star} ${t.key.padEnd(8)} ${t.name}\n`);
  }
  output.write("\n  * = currently configured. Use `teams add <key>` to subscribe.\n");
  return 0;
}

async function cmdTeamsAdd(args: Argv, opts: TeamsCmdOpts = {}): Promise<number> {
  const ref = args.positional[2];
  if (!ref) {
    output.write("usage: tangerine-linear teams add <team-key-or-uuid> [--projects=a,b,c]\n");
    return 1;
  }
  const projectsRaw = args.flags["projects"];
  const projects = typeof projectsRaw === "string" ? projectsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  let client: LinearLike;
  try {
    client = await makeAuthedClient(opts);
  } catch (err) {
    output.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  let teams;
  try {
    teams = await client.listTeams();
  } catch (err) {
    output.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const matched = teams.find((t) => t.key.toLowerCase() === ref.toLowerCase() || t.id === ref);
  if (!matched) {
    output.write(`team not found: ${ref}. Try \`tangerine-linear teams list\`.\n`);
    return 1;
  }

  const paths = makePaths(root(args.flags));
  const cfg = await readConfig(paths);
  if (cfg.teams.find((t) => t.uuid === matched.id)) {
    output.write(`already configured: ${matched.key}\n`);
    return 0;
  }
  const entry: TeamConfig = { uuid: matched.id, key: matched.key, name: matched.name };
  if (projects) entry.projects = projects;
  cfg.teams.push(entry);
  await writeConfig(paths, cfg);
  output.write(`added ${matched.key} (${matched.name})${projects ? ` projects=[${projects.join(",")}]` : ""}\n`);
  return 0;
}

async function cmdTeamsRemove(args: Argv): Promise<number> {
  const key = args.positional[2];
  if (!key) {
    output.write("usage: tangerine-linear teams remove <team-key>\n");
    return 1;
  }
  const paths = makePaths(root(args.flags));
  const cfg = await readConfig(paths);
  const before = cfg.teams.length;
  cfg.teams = cfg.teams.filter((t) => t.key.toLowerCase() !== key.toLowerCase());
  if (cfg.teams.length === before) {
    output.write(`not configured: ${key}\n`);
    return 1;
  }
  await writeConfig(paths, cfg);
  output.write(`removed ${key}\n`);
  return 0;
}

async function cmdPoll(args: Argv): Promise<number> {
  const dryRun = args.flags["dry-run"] === true;
  const r = await runOnce({ memoryRoot: root(args.flags), dryRun });
  if (dryRun) {
    output.write(`[dry-run] processed ${r.teams.length} team(s) — ${r.totalAtoms} atom(s) generated, none written\n`);
  } else {
    output.write(`processed ${r.teams.length} team(s) — ${r.totalAtoms} atom(s) seen, ${r.totalWritten} new\n`);
  }
  for (const t of r.teams) {
    if (t.error) {
      output.write(`  ${t.team}: ERROR ${t.error}\n`);
    } else {
      output.write(`  ${t.team}: ${t.atomCount} atoms${dryRun ? "" : `, ${t.written} written, ${t.skipped} dup`}${t.newCursor ? `, cursor=${t.newCursor}` : ""}\n`);
    }
  }
  return r.teams.some((x) => x.error) ? 2 : 0;
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

export interface MainOpts {
  /** Inject a Linear client for tests. */
  client?: LinearLike;
}

export async function main(argv: string[] = process.argv.slice(2), opts: MainOpts = {}): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.help || args.positional.length === 0) {
    output.write(HELP);
    return 0;
  }
  const verb = args.positional[0];
  const sub = args.positional[1];
  try {
    if (verb === "auth" && sub === "set") return await cmdAuthSet();
    if (verb === "auth" && sub === "status") return await cmdAuthStatus();
    if (verb === "teams" && sub === "list") return await cmdTeamsList(args, opts);
    if (verb === "teams" && sub === "add") return await cmdTeamsAdd(args, opts);
    if (verb === "teams" && sub === "remove") return await cmdTeamsRemove(args);
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
