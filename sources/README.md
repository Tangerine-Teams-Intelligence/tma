# Tangerine Source Connectors

Sources are the **inputs** that feed Tangerine's team-memory layer. Each connector watches one external system (GitHub, Linear, Slack, Calendar, …), translates events into the canonical **atom** schema, and appends them to the user's memory tree under `<memory>/timeline/` and `<memory>/threads/`.

A source is a self-contained npm package living under `sources/<name>/`. It ships its own CLI, has its own tests, and never imports from any other source. The contract a source must honor is documented in this file — implementing the contract is enough to add a new source.

## Inventory

| Source   | Status | Package                         | CLI                  |
| -------- | ------ | ------------------------------- | -------------------- |
| GitHub   | v1.6   | `sources/github`                | `tangerine-github`   |
| Linear   | planned (v1.6) | `sources/linear`         | `tangerine-linear`   |
| Slack    | planned (v1.8) | `sources/slack`          | `tangerine-slack`    |
| Calendar | planned (v1.7) | `sources/calendar`       | `tangerine-calendar` |

Discord predates the source-connector pattern and lives at `bot/`. New sources MUST follow the `sources/<name>/` layout — Discord will be migrated once it has a quiet release window.

## Layout

```
sources/<name>/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts          # entry — exports startWatch()/runOnce()
│   ├── auth.ts           # token storage (keytar)
│   ├── client.ts         # API wrapper for the external system
│   ├── ingest/           # one file per event family
│   │   └── *.ts
│   ├── poll.ts           # polling loop (default ingest mode)
│   ├── normalize.ts      # external event → atom
│   ├── memory.ts         # atom → memory tree writer
│   └── cli.ts            # CLI entry, registered via package.json bin
└── tests/
```

## Atom contract

Every source emits atoms with this shape (YAML frontmatter + markdown body, written to a single file):

```yaml
---
id: evt-<source>-<stable-key>            # globally unique, deterministic from upstream IDs
ts: 2026-04-26T09:30:00Z                 # RFC 3339, UTC
source: github                           # source name (matches package dir)
actor: eric                              # primary actor's Tangerine alias
actors: [eric, daizhe]                   # all participants/mentions, Tangerine aliases
kind: pr_comment                         # source-specific event kind
refs:
  github:
    repo: myorg/api
    pr: 47
    comment_id: 12345
  meeting: null                          # set if this atom was discussed in a meeting
  decisions: []                          # decision IDs this atom resolves
  people: [eric, daizhe]                 # mirror of actors, future-proofed for indirect refs
  projects: [v1-launch]
  threads: [pr-myorg-api-47]             # 1+ thread IDs this atom belongs to
status: active                           # active | superseded | archived
sample: false                            # true = onboarding fixture, never indexed
---
**Eric** commented on PR #47 (postgres-migration):

> @daizhe — should we add time-series tables in this migration or split it?

Original at: https://github.com/myorg/api/pull/47#issuecomment-12345
```

### Required fields

- `id` — must be deterministic, not random. Re-ingesting the same upstream event MUST produce the same id (so dedup works).
- `ts` — UTC, no local-time dancing.
- `source` — match the directory name exactly.
- `actor` / `actors` — Tangerine aliases, not raw upstream IDs (use the source's identity map).
- `kind` — namespaced; e.g. `pr_opened`, `issue_closed`. Source owns its own kind vocabulary.
- `refs.<source>` — typed back-pointer to the upstream object. Schema is source-specific.
- `refs.threads` — at least one thread id; this is what powers per-conversation digests.

### Optional fields

- `refs.meeting`, `refs.decisions`, `refs.projects` — set if the source can detect them; `null`/`[]` otherwise.

## Memory writes

A source writes each atom to two places:

1. `<memory>/timeline/<YYYY-MM-DD>.md` — chronological feed for the day.
2. `<memory>/threads/<thread-id>.md` — per-thread feed.

Both files are append-only. Atom files use `\n---\n` as the inter-atom separator (so the entire file is still a valid YAML stream when needed).

Re-ingesting the same atom (matched by `id`) is a no-op — sources are responsible for dedup at write time.

## Identity map

Each source maintains `<memory>/.tangerine/sources/<name>.identity.json`:

```json
{
  "ericfromgithub": "eric",
  "daizhe-z": "daizhe"
}
```

Mapping is upstream-id → Tangerine alias. On first encounter of an unknown upstream id, the source SHOULD write the raw id as the alias (so atoms still produce) and let the user remap later.

## Config map

Each source maintains `<memory>/.tangerine/sources/<name>.config.json`. Schema is source-specific but MUST include:

```json
{
  "schema_version": 1,
  "poll_interval_sec": 60
}
```

## Auth

Tokens live in the OS keychain via `keytar`, never on disk in plaintext. Service name MUST be `tangerine-<source>`.

## CLI surface

Every source exposes the same six verbs:

```
tangerine-<source> auth set            # set / refresh token
tangerine-<source> auth status         # check token validity
tangerine-<source> repos add <id>      # add upstream object (repo / project / channel) — verb name is source-specific
tangerine-<source> repos list
tangerine-<source> poll                # one-shot
tangerine-<source> watch               # daemon, polls forever
```

Two extra flags every source MUST honor:

- `--dry-run` — produce atoms in memory, print to stdout, do NOT write to disk.
- `--memory-root=<path>` — override `<memory>` (default: `~/.tangerine-memory`).

## Module A integration

When Module A's `event_router` lands, sources will fan out atoms via:

```python
from tmi.event_router import EventRouter
EventRouter(memory_root=...).process(atom_dict)
```

Until then, sources write directly to the timeline + threads files. Each `memory.ts` MUST leave a `// TODO(module-a)` comment at the integration point so the swap is mechanical.

## Adding a new source

1. Copy `sources/github/` to `sources/<your-source>/`.
2. Rewrite `client.ts` and `auth.ts` for the new API.
3. Map the source's events to atoms in `normalize.ts` (one `kind` per event family).
4. Decide thread granularity (one thread per PR for GitHub; per Linear issue; per Slack channel; etc.).
5. Update root `.gitignore` for the new `node_modules` / `dist`.
6. Add a row to the inventory table above.

The atom schema, memory layout, and CLI surface are non-negotiable — that's what makes the sinks (browser ext, MCP server) work uniformly.
