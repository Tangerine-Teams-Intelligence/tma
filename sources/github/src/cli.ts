#!/usr/bin/env node
// CLI for the GitHub source connector. Verbs:
//   tangerine-github auth set
//   tangerine-github auth status
//   tangerine-github repos add <owner/name> [--projects=a,b,c]
//   tangerine-github repos remove <owner/name>
//   tangerine-github repos list
//   tangerine-github poll [--dry-run]
//   tangerine-github watch
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
import { defaultMemoryRoot, makePaths, readConfig, writeConfig } from "./memory.js";
import { runOnce, runForever } from "./poll.js";
import type { RepoConfig } from "./types.js";

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

const HELP = `Tangerine — GitHub source connector

Usage:
  tangerine-github auth set                       set/refresh PAT (reads from stdin)
  tangerine-github auth status                    check stored PAT validity
  tangerine-github repos add <owner/name>         add a repo to the ingest list
                              [--projects=a,b]    optionally tag every atom with these projects
  tangerine-github repos remove <owner/name>      remove a repo
  tangerine-github repos list                     list configured repos
  tangerine-github poll [--dry-run]               one-shot ingest of all configured repos
  tangerine-github watch                          daemon — poll forever (uses config interval)

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
      // We don't have a mute prompt without an extra dep; warn the user.
      output.write(`(input will be visible) ${prompt}`);
      const t = await rl.question("");
      return t.trim();
    } finally {
      rl.close();
    }
  }
  // Non-TTY — read everything from stdin.
  const chunks: Buffer[] = [];
  for await (const c of input) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function cmdAuthSet(): Promise<number> {
  const t = await readSecret("Paste GitHub PAT and press enter: ");
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
  output.write(`token saved for @${v.login}\n`);
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
    output.write(`OK — token belongs to @${v.login}\n`);
    return 0;
  }
  output.write(`FAIL — ${v.reason}\n`);
  return 2;
}

async function cmdReposAdd(args: Argv): Promise<number> {
  const name = args.positional[2];
  if (!name) {
    output.write("usage: tangerine-github repos add <owner/name> [--projects=a,b,c]\n");
    return 1;
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) {
    output.write(`invalid repo name: ${name} (want owner/name)\n`);
    return 1;
  }
  const projectsRaw = args.flags["projects"];
  const projects = typeof projectsRaw === "string" ? projectsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  const paths = makePaths(root(args.flags));
  const cfg = await readConfig(paths);
  if (cfg.repos.find((r) => r.name === name)) {
    output.write(`already configured: ${name}\n`);
    return 0;
  }
  const entry: RepoConfig = { name };
  if (projects) entry.projects = projects;
  cfg.repos.push(entry);
  await writeConfig(paths, cfg);
  output.write(`added ${name}${projects ? ` (projects: ${projects.join(", ")})` : ""}\n`);
  return 0;
}

async function cmdReposRemove(args: Argv): Promise<number> {
  const name = args.positional[2];
  if (!name) {
    output.write("usage: tangerine-github repos remove <owner/name>\n");
    return 1;
  }
  const paths = makePaths(root(args.flags));
  const cfg = await readConfig(paths);
  const before = cfg.repos.length;
  cfg.repos = cfg.repos.filter((r) => r.name !== name);
  if (cfg.repos.length === before) {
    output.write(`not configured: ${name}\n`);
    return 1;
  }
  await writeConfig(paths, cfg);
  output.write(`removed ${name}\n`);
  return 0;
}

async function cmdReposList(args: Argv): Promise<number> {
  const paths = makePaths(root(args.flags));
  const cfg = await readConfig(paths);
  if (cfg.repos.length === 0) {
    output.write("no repos configured. add one with `tangerine-github repos add <owner/name>`\n");
    return 0;
  }
  for (const r of cfg.repos) {
    const proj = r.projects?.length ? ` projects=[${r.projects.join(",")}]` : "";
    const cur = r.cursor ? ` cursor=${r.cursor}` : "";
    output.write(`  ${r.name}${proj}${cur}\n`);
  }
  return 0;
}

async function cmdPoll(args: Argv): Promise<number> {
  const dryRun = args.flags["dry-run"] === true;
  const r = await runOnce({ memoryRoot: root(args.flags), dryRun });
  if (dryRun) {
    output.write(`[dry-run] processed ${r.repos.length} repo(s) — ${r.totalAtoms} atom(s) generated, none written\n`);
  } else {
    output.write(`processed ${r.repos.length} repo(s) — ${r.totalAtoms} atom(s) seen, ${r.totalWritten} new\n`);
  }
  for (const repo of r.repos) {
    if (repo.error) {
      output.write(`  ${repo.repo}: ERROR ${repo.error}\n`);
    } else {
      output.write(`  ${repo.repo}: ${repo.atomCount} atoms${dryRun ? "" : `, ${repo.written} written, ${repo.skipped} dup`}${repo.newCursor ? `, cursor=${repo.newCursor}` : ""}\n`);
    }
  }
  return r.repos.some((x) => x.error) ? 2 : 0;
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
    if (verb === "auth" && sub === "set") return await cmdAuthSet();
    if (verb === "auth" && sub === "status") return await cmdAuthStatus();
    if (verb === "repos" && sub === "add") return await cmdReposAdd(args);
    if (verb === "repos" && sub === "remove") return await cmdReposRemove(args);
    if (verb === "repos" && sub === "list") return await cmdReposList(args);
    if (verb === "poll") return await cmdPoll(args);
    if (verb === "watch") return await cmdWatch(args);
  } catch (err) {
    output.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
  output.write(`unknown command: ${verb}${sub ? ` ${sub}` : ""}\n\n${HELP}`);
  return 1;
}

// Only invoke main when run as a script — keeps the file importable for tests.
const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
               process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts");
if (isMain) {
  main().then((code) => process.exit(code));
}
