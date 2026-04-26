# `@tangerine/source-linear`

Linear source connector for Tangerine. Watches one or more workspace teams
and turns every issue, status change, and comment into an **atom** in your
team-memory tree. The atom format is documented in [`../README.md`](../README.md);
all atoms are routed through Module A's `event_router` via the
`tmi.daemon_cli emit-atom` subprocess (same pattern as the GitHub source).

Linear is the #2 source of engineering signal after voice meetings — issue
status, decisions in comment threads, and assignment changes all live there
and rarely make it into a meeting transcript.

## Install

This package is part of the Tangerine monorepo and is not published to npm.

```bash
cd sources/linear
npm install
npm run build
```

The CLI is installed as `tangerine-linear` if you `npm link` from this
directory; otherwise invoke `node dist/cli.js`.

## Quick start

### 1. Get a Linear Personal API Key

Visit `https://linear.app/<your-workspace>/settings/api`, click "Create new
key", give it a name (e.g. `tangerine`), and copy the value. The key carries
all of your read permissions — anything you can see in the Linear UI is
readable through it. No OAuth dance is required for v1.

### 2. Set the token

```bash
tangerine-linear auth set
# (input will be visible) Paste Linear PAT and press enter: <PASTE>
# token saved for you@example.com
```

The token is stored in your OS keychain via `keytar` (Keychain on macOS,
Credential Manager on Windows, libsecret on Linux). It never lives on disk
in plaintext.

Verify:

```bash
tangerine-linear auth status
# OK — token belongs to you@example.com
```

### 3. Pick teams to ingest

```bash
tangerine-linear teams list
#     ENG      Engineering
#     DSGN     Design
#     OPS      Operations
#
#   * = currently configured. Use `teams add <key>` to subscribe.

tangerine-linear teams add ENG
# added ENG (Engineering)

tangerine-linear teams add DSGN --projects=v1-launch,frontend
# added DSGN (Design) projects=[v1-launch,frontend]
```

`--projects` tags every atom from that team with the given project IDs (in
addition to any auto-detected from labels / titles).

### 4. Poll

One-shot:

```bash
tangerine-linear poll
# processed 2 team(s) — 47 atom(s) seen, 47 new
#   ENG: 31 atoms, 31 written, 0 dup, cursor=2026-04-26T11:30:00Z
#   DSGN: 16 atoms, 16 written, 0 dup, cursor=2026-04-26T11:28:00Z
```

Daemon (polls every `poll_interval_sec`, default 60s):

```bash
tangerine-linear watch
```

`--dry-run` produces atoms in memory but does NOT write to disk:

```bash
tangerine-linear poll --dry-run
# [dry-run] processed 1 team(s) — 12 atom(s) generated, none written
#   ENG: 12 atoms, cursor=2026-04-26T11:30:00Z
```

## Where atoms live

Atoms are written by Module A under `~/.tangerine-memory/` by default
(override with `--memory-root=<path>` or `MEMORY_ROOT`). The connector owns
config + identity files; everything else is Module A's:

```
~/.tangerine-memory/
├── timeline/
│   └── 2026-04-26.md            # Module A: chronological feed
├── threads/
│   └── linear-eng-123.md        # Module A: per-issue feed
├── people/
│   └── daizhe.md                # Module A: per-person mentions
├── projects/
│   └── v1-launch.md             # Module A: per-project mentions
└── .tangerine/
    ├── timeline.json            # Module A: atom index
    └── sources/
        ├── linear.config.json   # Connector: teams + cursors
        └── linear.identity.json # Connector: Linear handle → Tangerine alias
```

## Atom kinds emitted

Module A's canonical kind vocabulary is narrow — the upstream Linear verb
is preserved on `refs.linear.action`.

| Kind | refs.linear.action | When |
| --- | --- | --- |
| `ticket_event` | `issue_created` | Issue is created |
| `ticket_event` | `issue_state_changed` | State / assignee / priority moved (default for any issue update) |
| `ticket_event` | `issue_completed` | Issue moved to a Completed-type state |
| `ticket_event` | `issue_canceled` | Issue moved to a Canceled-type state |
| `comment` | `comment_created` | Issue comment added |
| `decision` | `comment_created` | Comment body matches the decision sniffer (e.g. "we decided", "going with") |
| `decision` | `issue_completed` | Completed issue's description matches the decision sniffer |

## Identity mapping

Linear handle ≠ Tangerine alias. The connector maintains
`linear.identity.json` — keys are Linear emails (preferred) or display names,
values are Tangerine aliases:

```json
{
  "daizhe@berkeley.edu": "daizhe",
  "Eric Wang": "eric"
}
```

On first encounter of an unknown handle, it self-maps so the atom still
emits with a usable actor. Edit the file at any time to remap; future polls
pick up the new mapping.

## Project + thread detection

- **Threads** — every issue maps to one thread `linear-<lowercase identifier>`
  (e.g. `linear-eng-123`). Comments join their parent issue's thread.
- **Projects** — extracted from:
  1. labels with the configured prefix (default `project:`) — `project:v1-launch` → `v1-launch`
  2. title-prefix regex (default `^\[(.+?)\]`) — `[v1] migration` → `v1`
  3. the `--projects=` flag from `teams add` (always merged in)
- **Decisions** — bodies matching `\b(decided|agreed|we'll go with|let's go with|locked in|conclusion:|going with|ship it)\b` produce a `kind: decision` atom for downstream surfacing.

## Module A integration

Every atom is handed to Module A's `event_router` via the
`tmi.daemon_cli emit-atom` subprocess (atom JSON over stdin). Module A
handles timeline + thread + people + project fan-out, the AGI hook
validation, and `on_atom` dispatch.

Atom ids follow the Module-A canonical format: `evt-<YYYY-MM-DD>-<10-hex>`
from `sha256(source|kind|source_id|ts)`. The TypeScript `makeAtomId` helper
in `normalize.ts` computes the same hash as Python's `make_event_id` so
atoms read with a stable id before they hit the router.

Tests inject a deterministic in-memory router via `setRouterForTesting()`
plus a stub Linear client so unit tests don't need a Python interpreter or
Linear credentials.

## Real-API verification

Linear doesn't have a "public read-only" mode like GitHub does (no
unauthenticated endpoints), so the only way to verify against the real API
is with a workspace PAT. To kick the tires:

```bash
tangerine-linear auth set            # paste a PAT for any test workspace
tangerine-linear teams list          # confirms the connection works
tangerine-linear teams add <KEY>
tangerine-linear poll --memory-root=/tmp/tg-linear-demo --dry-run
```

If the dry-run reports a sane atom count, the connector is wired correctly
end-to-end. The unit + integration tests below exercise the full code path
with a stubbed Linear SDK so CI can run without credentials.

## CLI reference

```
tangerine-linear auth set                       set/refresh PAT (reads from stdin)
tangerine-linear auth status                    check stored PAT validity
tangerine-linear teams list                     list teams visible to your PAT
tangerine-linear teams add <team-key-or-uuid> [--projects=a,b]
tangerine-linear teams remove <team-key>
tangerine-linear poll [--dry-run]               one-shot ingest of all configured teams
tangerine-linear watch                          daemon — poll forever

Common:
  --memory-root=<path>     override memory root (default: ~/.tangerine-memory)
  --help, -h               this message

Env:
  MEMORY_ROOT              same as --memory-root
  TARGET_REPO              <TARGET_REPO>/memory used as memory root if MEMORY_ROOT unset
  PYTHON_BIN               override python invocation for emit-atom (default: python)
```

## Architecture

```
src/
├── auth.ts          PAT storage in OS keychain (keytar)
├── client.ts        @linear/sdk wrapper — minimal LinearLike surface
├── ingest/
│   ├── issues.ts    listIssuesForTeam → ticket_event atoms
│   ├── comments.ts  listCommentsForTeam → comment / decision atoms
│   └── projects.ts  Stage 1 stub — Linear projects come through issue.project
├── poll.ts          one-shot + daemon loop, cursor advancement
├── normalize.ts     Linear object → atom mapping (canonical Module-A id + kind)
├── memory.ts        atom → daemon_cli emit-atom subprocess (Module A router)
├── types.ts         Atom + config + identity types
├── index.ts         public re-exports
└── cli.ts           tangerine-linear CLI
```

## Tests

```bash
npm test
```

Coverage: auth (keytar mocked), normalize (every kind under the Module-A
vocabulary, decision sniffer, mention extraction, project extraction,
canonical id stability), memory writer (router stub, payload conversion,
batch sort/dedup), CLI commands with stubbed Linear client, end-to-end
ingest with stubbed Linear SDK + stubbed Module-A router.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
