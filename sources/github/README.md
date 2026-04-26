# `@tangerine/source-github`

GitHub source connector for Tangerine. Watches one or more repos and turns every PR, issue, comment, and review into an **atom** in your team-memory tree. The atom format is documented in [`../README.md`](../README.md).

GitHub PR + Issues + comments are the #2 most-important communication channel for engineering teams (after voice meetings) — 80% of technical decisions live there.

## Install

This package is part of the Tangerine monorepo and is not published to npm.

```bash
cd sources/github
npm install
npm run build
```

The CLI is installed as `tangerine-github` if you `npm link` from this directory; otherwise invoke `node dist/cli.js`.

## Quick start

### 1. Get a GitHub Personal Access Token

Tangerine uses a classic PAT (or fine-grained token, both work). Required scopes:

- `repo` — read PRs / issues / comments on private repos
- `read:user` — resolve actor logins on the `/user` validation call

Generate at [github.com/settings/tokens](https://github.com/settings/tokens). Copy the token — you'll paste it next.

### 2. Set the token

```bash
tangerine-github auth set
# (input will be visible) Paste GitHub PAT and press enter: <PASTE>
# token saved for @yourlogin
```

The token is stored in your OS keychain via `keytar` (Keychain on macOS, Credential Manager on Windows, libsecret on Linux). It never lives on disk in plaintext.

Verify:

```bash
tangerine-github auth status
# OK — token belongs to @yourlogin
```

### 3. Add repos to ingest

```bash
tangerine-github repos add myorg/api
tangerine-github repos add myorg/web --projects=v1-launch,frontend
tangerine-github repos list
#   myorg/api
#   myorg/web projects=[v1-launch,frontend]
```

`--projects` tags every atom from that repo with the given project IDs (in addition to any auto-detected from labels / titles).

### 4. Poll

One-shot:

```bash
tangerine-github poll
# processed 2 repo(s) — 47 atom(s) seen, 47 new
#   myorg/api: 31 atoms, 31 written, 0 dup, cursor=2026-04-26T11:30:00Z
#   myorg/web: 16 atoms, 16 written, 0 dup, cursor=2026-04-26T11:28:00Z
```

Daemon (polls every `poll_interval_sec`, default 60s):

```bash
tangerine-github watch
```

`--dry-run` produces atoms in memory but does NOT write to disk:

```bash
tangerine-github poll --dry-run
# [dry-run] processed 1 repo(s) — 12 atom(s) generated, none written
#   myorg/api: 12 atoms, cursor=2026-04-26T11:30:00Z
```

## Where atoms live

Atoms are written under `~/.tangerine-memory/` by default (override with `--memory-root=<path>` or `MEMORY_ROOT`):

```
~/.tangerine-memory/
├── timeline/
│   └── 2026-04-26.md            # chronological feed for the day
├── threads/
│   ├── pr-myorg-api-47.md       # one file per PR
│   └── issue-myorg-api-88.md    # one file per issue
└── .tangerine/
    └── sources/
        ├── github.config.json   # repos + cursors
        └── github.identity.json # GitHub login → Tangerine alias
```

Each atom (after Module A writes it) is YAML frontmatter + markdown:

```yaml
---
id: evt-2026-04-26-aBc12dEf01
ts: 2026-04-26T09:30:00.000Z
source: github
actor: eric
actors: [eric, daizhe]
kind: comment
refs:
  github:
    repo: myorg/api
    pr: 47
    comment_id: 12345
    url: https://github.com/myorg/api/pull/47#issuecomment-12345
    action: comment_created
  meeting: null
  decisions: []
  people: [eric, daizhe]
  projects: [v1-launch]
  threads: [pr-myorg-api-47]
status: active
sample: false
---
**eric** commented on PR #47 (postgres-migration):

> @daizhe — should we add time-series tables in this migration or split it?

Original at: https://github.com/myorg/api/pull/47#issuecomment-12345
```

Module A also stamps the 8 Stage 2 future-proof fields (embedding/concepts/
confidence/alternatives/source_count/reasoning_notes/sentiment/importance)
into the `.tangerine/timeline.json` index — non-default values surface, the
defaults stay implicit to keep the index lean.

## Atom kinds emitted

Module A's canonical kind vocabulary is narrow — the upstream verb (e.g.
"opened" vs "merged") is preserved on `refs.github.action`.

| Kind | refs.github.action | When |
| --- | --- | --- |
| `pr_event` | `opened` | PR is created or first observed |
| `pr_event` | `merged` | PR was merged (carries merger + merge SHA) |
| `pr_event` | `closed` | PR was closed without merge |
| `pr_event` | `review_approved` | Reviewer submitted "Approve" |
| `pr_event` | `review_changes_requested` | Reviewer submitted "Request changes" |
| `pr_event` | `review_dismissed` / `review_commented` | Other review states |
| `comment` | `comment_created` | PR conversation tab comment, PR inline diff comment, or issue comment |
| `ticket_event` | `issue_opened` | Issue is created or first observed |
| `ticket_event` | `issue_closed` | Issue is closed (carries `state_reason` in body) |
| `decision` | `comment_created` | Comment body matches a decision sniffer pattern (e.g. "we decided", "going with") — promoted from `comment` |

## Identity mapping

GitHub login ≠ Tangerine alias. The connector maintains `github.identity.json`:

```json
{
  "ericfromgithub": "eric",
  "daizhe-z": "daizhe"
}
```

On first encounter of an unknown GitHub login, it self-maps (`"newdev": "newdev"`) so the atom still emits with a usable actor. Edit the file at any time to remap; future polls pick up the new mapping.

## Project + thread detection

- **Threads** — every PR maps to one thread `pr-<repo>-<num>`, every issue to `issue-<repo>-<num>`. Comments and reviews join their parent's thread.
- **Projects** — extracted from:
  1. labels with the configured prefix (default `project:`) — `project:v1-launch` → `v1-launch`
  2. title-prefix regex (default `^\[(.+?)\]`) — `[v1] migration` → `v1`
  3. the `--projects=` flag from `repos add` (always merged in)
- **Decisions** — bodies matching `\b(decided|agreed|we'll go with|let's go with|locked in|conclusion:|going with)\b` produce a `kind: decision` atom for downstream surfacing in the Inbox (Module C, planned).

## Rate-limit handling

The connector reads `x-ratelimit-*` headers on every response. When `remaining < 50`, it backs off until the reset time (capped at 5 minutes per single sleep). The daemon loop also honors any backoff signal between iterations. With a PAT you have 5,000 req/hr — plenty for a small team's worth of repos.

## Webhook mode (optional)

`src/ingest/webhook.ts` exports `processWebhook(eventName, payload, ctx)` which converts a GitHub webhook payload into the same atoms produced by polling. The connector does NOT start an HTTP server itself — the desktop app (or a future hosted gateway) is responsible for hosting the endpoint and verifying signatures. This keeps the dependency footprint small.

Supported events: `pull_request` (opened/closed/edited/reopened), `issues` (same), `issue_comment.created`, `pull_request_review_comment.created`, `pull_request_review.submitted`.

## CLI reference

```
tangerine-github auth set                       set/refresh PAT (reads from stdin)
tangerine-github auth status                    check stored PAT validity
tangerine-github repos add <owner/name> [--projects=a,b]
tangerine-github repos remove <owner/name>
tangerine-github repos list
tangerine-github poll [--dry-run]               one-shot ingest of all configured repos
tangerine-github watch                          daemon — poll forever

Common:
  --memory-root=<path>     override memory root (default: ~/.tangerine-memory)
  --help, -h               this message

Env:
  MEMORY_ROOT              same as --memory-root
  TARGET_REPO              <TARGET_REPO>/memory used as memory root if MEMORY_ROOT unset
  TANGERINE_GH_PUBLIC=1    skip auth and use unauthenticated public reads (60 req/hr)
```

## Real-repo verification

To kick the tires against a public repo without a PAT:

```bash
TANGERINE_GH_PUBLIC=1 tangerine-github repos add octocat/hello-world
TANGERINE_GH_PUBLIC=1 tangerine-github poll --memory-root=/tmp/tg-demo
```

Note: unauthenticated requests share the GitHub anon rate limit (60 req/hr per IP). Use a PAT for anything beyond a smoke test.

## Architecture

```
src/
├── auth.ts          PAT storage in OS keychain (keytar)
├── client.ts        @octokit/core wrapper (paginate + REST methods)
├── ingest/
│   ├── prs.ts       /pulls list → pr_opened / pr_merged / pr_closed atoms
│   ├── issues.ts    /issues list → issue_opened / issue_closed atoms
│   ├── comments.ts  /issues/comments + /pulls/comments → comment atoms
│   ├── reviews.ts   /pulls/{n}/reviews → pr_review atoms
│   └── webhook.ts   webhook payload → atoms (opt-in)
├── poll.ts          one-shot + daemon loop, cursor advancement
├── normalize.ts     GitHub object → atom mapping (no IO)
├── memory.ts        atom → timeline + thread file writer (dedup)
├── types.ts         Atom + config + identity types
├── index.ts         public re-exports
└── cli.ts           tangerine-github CLI
```

## Module A integration

Every atom is handed to Module A's `event_router` via the
`tmi.daemon_cli emit-atom` subprocess. The connector builds the atom dict in
`normalize.ts` (with the canonical Module-A id + kind), then `memory.ts`
spawns Python over stdin. Module A handles timeline + thread + people +
project fan-out, the AGI hook validation, and `on_atom` dispatch.

Atom ids follow the Module-A canonical format: `evt-<YYYY-MM-DD>-<10-hex>`
from `sha256(source|kind|source_id|ts)`. The TypeScript `makeAtomId` helper
in `normalize.ts` computes the same hash as Python's `make_event_id` so atoms
read with a stable id before they hit the router.

Atom kinds use the Module-A canonical vocabulary: PR opens / merges /
closes / reviews all flatten to `pr_event` (with the narrow verb on
`refs.github.action`); PR + issue conversation comments flatten to `comment`
(promoted to `decision` on sniff hit); issue opens / closes flatten to
`ticket_event`.

Tests inject a deterministic in-memory router via `setRouterForTesting()` so
unit tests don't need a Python interpreter. The integration test exercises
the full Octokit + Module-A wire format with the same stub.

## Tests

```bash
npm test
```

85 tests. Coverage: auth (keytar mocked), normalize (every kind under the
Module-A vocabulary, decision sniffer, mention extraction, project
extraction, alias resolution, canonical id stability), webhook payloads,
memory writer (router stub, payload conversion, batch sort/dedup), client
wrapper + rate-limit math, CLI commands, end-to-end integration with
stubbed GitHub API + stubbed Module-A router.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
