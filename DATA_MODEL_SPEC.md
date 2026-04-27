# DATA_MODEL_SPEC.md

Single source of truth for every data shape Tangerine writes to or reads from disk. Generated 2026-04-26 against the v2.0-alpha.1 codebase.

---

## §0 Why unify

Atom shapes drifted per-source. Each connector landed at a different time (v1.5 GitHub, v1.6 Linear, v1.7 Slack/Discord, v1.7 W2a AGI fields, v1.8 voice-notes/email, v1.8 P4-B canvas) and each one made its own micro-decisions about frontmatter keys, where the sidecar metadata lives, and which fields are mandatory. The result: `decisions/sample-postgres-over-mongo.md` uses `source_id`, the email connector writes `message_ids` + `participants`, voice-notes writes `recorded_at` + `duration_sec`, the GitHub writeback path reads `external_id` *or* falls back to `source_id`. Two readers of "the same file" disagree on which key is canonical.

This spec freezes the shape, lists every field per kind, calls out where the schema branches, and gives the migration path so we can stop drifting. The frontend (`app/src/lib/`), the Rust daemon (`app/src-tauri/src/`), and the bundled samples (`app/resources/sample-memory/`) all read from this doc.

Three release lines covered:
- **v1.x** — flat `<memory_root>/{kind}/` layout, single-user, no AGI fields.
- **v2.0-alpha.1** (current) — layered `team/` + `personal/<user>/` split, 8 AGI fields, canvas surface, telemetry + suppression sidecars.
- **v2.5 / v3.0** — projected. Cloud sync (per-team git mirror) and personal-agent capture extension respectively.

---

## §1 Memory dir layout

Post-`migration::migrate_to_layered` (the v1.x → v2.0 shim in `app/src-tauri/src/migration.rs`), every install lands at this shape:

```
~/.tangerine-memory/
├── team/                                 ← committed to git, shared
│   ├── meetings/{slug}.md
│   ├── decisions/{slug}.md
│   ├── people/{slug}.md
│   ├── projects/{slug}.md
│   ├── threads/{source}/{slug}.md
│   └── glossary/{term}.md
├── personal/                             ← gitignored, local-only
│   └── {user}/
│       ├── meetings/  decisions/  people/
│       ├── projects/  threads/    glossary/
├── canvas/                               ← per-project ideation surface
│   └── {project-slug}/
│       └── {topic-slug}.md
├── agi/                                  ← co-thinker brain + audit trail
│   ├── co-thinker.md
│   ├── observations/{YYYY-MM-DD}.md
│   └── proposals/{type}-{slug}-{YYYY-MM-DD}.md
├── timeline/                             ← daemon-built activity index
├── .tangerine/                           ← sidecars, gitignored
│   ├── cursors/{source}.json
│   ├── timeline/index.json
│   ├── telemetry/{YYYY-MM-DD}.jsonl
│   └── suppression.json
└── .gitignore                            ← Tangerine rewrites on every boot
```

`team/` is the shared commit surface. `personal/<user>/` is opt-in capture per source — voice-notes pin to it (`sources::voice_notes::voice_threads_dir_for` in `app/src-tauri/src/sources/voice_notes.rs`), email defaults team-side, and the user can move atoms via the planned "promote to team" UI. `ATOM_KINDS` is fixed to six kinds (`memory_paths.rs::ATOM_KINDS`); adding a seventh requires a migration tick.

The canonical `.gitignore` body lives at `migration::canonical_gitignore_body`:

```
# Tangerine layered memory — generated v2.0-alpha.1
# Do not edit by hand — Tangerine rewrites this file on every boot.
.tangerine/
personal/
tmp/
```

`SIDECAR_DIRS` (`memory_paths.rs`) lists `.tangerine`, `agi`, `timeline`, `canvas`, `tmp` — these are NEVER moved by the migration shim. The shim only renames flat `team/`-bound kind dirs.

---

## §2 Atom schema

Every atom is markdown with YAML frontmatter:

```markdown
---
title: …
source: …
…
---

## Decision    ← H2 sections per-kind
…body…
```

### §2.1 Required frontmatter (every kind, every source)

| Field | Type | Notes |
|---|---|---|
| `title` | string | Used as Linear issue title, GitHub comment header. May be empty if `filename` is meaningful. |
| `source` | enum-ish string | `discord` / `slack` / `github` / `linear` / `notion` / `calendar` / `loom` / `zoom` / `email` / `voice-notes` / `canvas` / `meeting` / `manual`. The writeback router (`sources::parse_decision_frontmatter`) hard-matches `github` / `linear`; everything else falls through to `NotApplicable`. |
| `source_provenance` | object | See §7. Holds `external_id`, `url`, `line_number`, `sender`, `timestamp`. v1.x called this `source_id`; v2.x prefers an explicit `external_id` field but readers accept both (newer wins). |
| `status` | `"draft"` / `"open"` / `"locked"` / `"archived"` | The writeback watcher only fires on `locked`. Templates (`agi::templates`) read this to gate `decision_drift` and `long_thread`. |
| `created_at` | ISO 8601 | Frontend stamps on capture. Backward-compat: v1.x atoms used `date:` (YYYY-MM-DD only) — see sample at `app/resources/sample-memory/decisions/sample-postgres-over-mongo.md`. |
| `last_modified` | ISO 8601 | Re-stamped on every save. Used by `co_thinker::scan_atoms_since` for the incremental heartbeat scan. |

### §2.2 The 8 AGI fields (shipped in v1.7 W2a)

Every atom carries these — populated lazily by the embedding pipeline; default `null` until it runs:

| Field | Type | Cost | Notes |
|---|---|---|---|
| `embedding` | `float[]` (1536-dim) | ~0.5 KB | OpenAI `text-embedding-3-small`. Computed off the body, not the frontmatter. |
| `concepts` | `string[]` | tiny | Extracted noun phrases. Used by `glossary` cross-linking. |
| `confidence` | `0.0..1.0` | 1 byte | LLM-derived confidence the atom's claim is correct. Templates use this in tier promotion. |
| `alternatives` | `string[]` | small | Alternative phrasings considered but not picked. Surfaces in the "did you mean" affordance. |
| `source_count` | `int` | 1 byte | Number of distinct sources backing the same claim. ≥3 promotes confidence. |
| `reasoning_notes` | `string` | small | Free-text trail of why the atom was extracted this way. Audit-only. |
| `sentiment` | `-1.0..1.0` | 1 byte | Tone classifier output. Used by the brain doc to flag friction. |
| `importance` | `0.0..1.0` | 1 byte | Composite of `confidence`, `source_count`, recency. Drives the priority float in template ranking. |

These are *added* fields, not replacements — old atoms missing them still parse (the Rust reader at `commands::memory` defaults each to its zero value). Until v3.0 they are optional on read; the embedding pipeline populates them on first scan.

### §2.3 Per-kind optional fields

| Kind | Fields | Source |
|---|---|---|
| `meetings/` | `due_at`, `event_id`, `attendees[]`, `slack_channel`, `transcript_path` | Calendar / Discord ingestion |
| `decisions/` | `project`, `locked_by`, `dependencies[]`, `external_id`, `source_id` (legacy) | Manual + writeback flow |
| `people/` | `github_login`, `slack_user_id`, `linear_id`, `email`, `role` | People graph |
| `projects/` | `status` (`active` / `dormant` / `archived`), `owner`, `dependencies[]`, `target_date` | Manual + Linear sync |
| `threads/` | `thread_root_id`, `message_count`, `summary`, `participants[]`, `last_message_at` | Discord / Slack / Email |
| `canvas/` | `canvas_topic`, `canvas_project`, `sticky_count` | Canvas writer |
| `glossary/` | `term`, `aliases[]`, `linked_kind` | Glossary builder |

Voice-note threads (`sources::voice_notes::build_voice_atom`) add `recorded_at`, `duration_sec`, `mime_type` on top of the `threads/` baseline. Email threads (`sources::email`) add `subject`, `participants`, `last_message_at`, `message_ids`, `provider`.

### §2.4 Sample frontmatter (current, post-v1.7 W2a)

```yaml
---
title: Pricing $20/seat 3 seat min
source: meeting
source_provenance:
  external_id: sample-2026-04-25-roadmap-sync
  url: ""
  line_number: 1
  sender: ""
  timestamp: 2026-04-25T14:00:00Z
status: locked
created_at: 2026-04-25T14:32:00Z
last_modified: 2026-04-25T14:32:00Z
project: tangerine-pricing
locked_by: daizhe
dependencies: []
embedding: null
concepts: ["pricing", "seat-minimum", "annual-discount"]
confidence: 0.92
alternatives: []
source_count: 2
reasoning_notes: "David acked verbally; Daizhe wrote the line."
sentiment: 0.1
importance: 0.85
schema_version: 2.0
---
```

The bundled sample at `app/resources/sample-memory/decisions/sample-pricing-20-seat.md` is the v1.x shape — has `date`, `source_id`, `status: decided`, `sample: true`, no AGI fields. Both should round-trip cleanly through the reader.

---

## §3 Co-thinker brain doc shape

`agi/co-thinker.md` is the persistent stateful brain. Owner: `agi::co_thinker::CoThinkerEngine` in `app/src-tauri/src/agi/co_thinker.rs`. The user can `cat`, edit, or git-blame it.

### §3.1 Frontmatter

```yaml
---
last_heartbeat_ts: 2026-04-26T14:23:00Z
cadence: foreground       # foreground (5min) | background (30min) | manual
---
```

### §3.2 Required H2 sections (validation: all 5 or fall back)

`co_thinker::REQUIRED_HEADINGS` enforces these — if any are missing in an LLM response, the validator returns empty and the daemon does NOT overwrite the brain:

1. `## What I'm watching`
2. `## Active threads`
3. `## My todo (next 24h, ranked)`
4. `## Recent reasoning`
5. `## Cited atoms (grounding)`

### §3.3 Citation rule (load-bearing)

Every claim line (`- `, `* `, or `1. ` prefix) MUST contain `[path/to/atom.md]` (with `.md` inside the brackets) OR an explicit placeholder `(none)` / `(no atoms ...)`. `co_thinker::has_citation` is the gate. Uncited bullets are silently dropped by `validate_and_ground` before write — this keeps the brain 100% audit-grounded. Headings, blank lines, and the `Last heartbeat:` line pass through untouched. `THROW_STICKY:` / `COMMENT_STICKY:` sentinels are stripped (handled out-of-band by `apply_canvas_sentinels` — see §4.3).

### §3.4 Truncation rules

- Brain doc is rewritten in full each tick (atomic write-temp + rename, `co_thinker::atomic_write`). No append.
- The LLM prompt feeds the *current* brain back as context (`build_llm_request`), so each tick is an in-place edit.
- Sections that lose all grounded claims get a `- (No grounded claims yet.)` filler injected by `repair_missing_sections` rather than omitted — keeps the structure intact.
- Cold-start seed (`seed_brain_doc`) writes the 5-section skeleton with all-placeholder bullets.

### §3.5 Audit trail

Every tick appends ONE line to `agi/observations/{YYYY-MM-DD}.md`:

```
14:23:01 cadence=foreground atoms_seen=3 channel=mcp proposals=1 templates=2 brief="Pricing decision detected"
```

`PROPOSAL:` sentinels in the response → write `agi/proposals/{type}-{slug}-{YYYY-MM-DD}.md` with frontmatter `type`, `slug`, `proposed_at`, `status: pending`. `co_thinker::write_proposals` is the writer.

---

## §4 Canvas markdown shape

`canvas/<project>/<topic>.md`. Owner: `agi::canvas::{load_topic, save_topic}` in `app/src-tauri/src/agi/canvas.rs`. The writer surface is `agi::canvas_writer` (`canvas_writer.rs`).

### §4.1 Topic file frontmatter

```yaml
---
canvas_topic: weekly-sync
canvas_project: tangerine
created_at: 2026-04-26T14:23:00Z
sticky_count: 7
---
```

`canvas_writer::seed_topic_md` writes this on first throw. `bump_sticky_count` increments the count on every new sticky. Project + topic slugs are validated against `[a-z0-9_-]` — anything else returns `canvas_bad_slug`.

### §4.2 Per-sticky shape

Each sticky is one H2 section:

```markdown
## sticky-{12-hex-uuid}
<!-- canvas-meta: {"x":80,"y":80,"color":"orange","author":"tangerine-agi","is_agi":true,"created_at":"2026-04-26T14:23:00Z","comments":[{"author":"alice","body":"reply text","created_at":"2026-04-26T14:24:00Z"}]} -->

body text — markdown allowed

### Replies
- **alice** at 2026-04-26T14:23: ...
```

The `<!-- canvas-meta: {...} -->` JSON sidecar carries position (x/y), color (one of `yellow` / `pink` / `blue` / `green` / `orange` / `purple` — see `VALID_COLORS`), author, AGI flag, created_at, and a comments array. The frontend's `app/src/lib/canvas.ts` rehydrates this. Storage rule: comments live BOTH in the JSON metadata AND as `### Replies` bullets under each sticky — the JSON is canonical, the bullets are for human readability + git-diff legibility.

The 12-hex-char short UUID matches `lib/canvas.ts::shortUuid` so a sticky id round-trips identically between TS and Rust sides.

### §4.3 AGI peer behavior

`co_thinker::apply_canvas_sentinels` consumes two sentinel grammars in the LLM response:

```
THROW_STICKY: project=<p> topic=<t> body=<b> color=<c>
COMMENT_STICKY: project=<p> topic=<t> sticky_id=<id> body=<b>
```

Successful throws append a `- 2026-04-26 14:23 → AGI throw on canvas \`p/t\` — {blurb} [sticky:p/t/id] [canvas/p/t.md]` line to the brain doc's `## Recent reasoning` section so the /co-thinker route can scroll-anchor to the matching sticky.

---

## §5 Telemetry event shape (JSONL)

`~/.tangerine-memory/.tangerine/telemetry/{YYYY-MM-DD}.jsonl`. One JSON object per line, append-only via `O_APPEND`. Owner: `agi::telemetry::TelemetryEvent` (`telemetry.rs`) and `lib/telemetry.ts::TelemetryEvent`. Retention: 90 days; `prune_old` runs on app boot.

### §5.1 Common envelope

```json
{
  "event": "navigate_route",
  "ts": "2026-04-26T14:23:00.000Z",
  "user": "daizhe",
  "payload": { /* event-specific */ }
}
```

### §5.2 Closed-set event names (16)

From `lib/telemetry.ts::TelemetryEventName`:

| Event | Payload |
|---|---|
| `navigate_route` | `{ from: string, to: string }` |
| `edit_atom` | `{ atom_path: string, edit_kind: "create" \| "modify" \| "delete" }` |
| `open_atom` | `{ atom_path: string }` |
| `dismiss_chip` | `{ surface_id: string, content_hash?: string, template?: string, atom_path?: string }` |
| `dismiss_banner` | `{ surface_id: string, banner_kind: string, template?: string, atom_path?: string }` |
| `dismiss_toast` | `{ toast_id: string, kind?: string, template?: string, atom_path?: string }` |
| `dismiss_modal` | `{ surface_id: string, modal_kind?: string, template?: string, atom_path?: string }` |
| `accept_suggestion` | `{ tier: "chip" \| "banner" \| "toast" \| "modal", template_name: string, atom_ref?: string }` |
| `mute_channel` | `{ channel: string, muted: boolean }` |
| `trigger_heartbeat` | `{ manual: boolean }` |
| `co_thinker_edit` | `{ content_diff_size: number }` |
| `search` | `{ query: string, result_count: number }` |
| `canvas_throw_sticky` | `{ project, topic, color, is_agi }` |
| `canvas_propose_lock` | `{ project, topic, sticky_id }` |
| `suggestion_pushed` | `{ tier, template, surface_id?, confidence }` |
| `suggestion_dropped` | `{ template, scope, reason: "suppressed" \| "throttled" \| "below_floor" }` |

Plus three v1.9.0-beta.3 additions: `dismiss_suggestion`, `modal_budget_exceeded`, `dismiss_count_threshold_reached`. The Rust writer `telemetry::append_event` accepts ANY string for `event` so the frontend can ship a new closed-set value without a backend rebuild.

### §5.3 Atomicity

Each event is one `<line>\n` write. Single `f.write_all` ensures POSIX `O_APPEND` covers the whole record (sub-`PIPE_BUF` on every shipped platform). Tested in `test_concurrent_appends_no_corruption` — 10 parallel appends produce 10 valid lines.

---

## §6 Suppression entry shape

`~/.tangerine-memory/.tangerine/suppression.json`. Owner: `agi::suppression::SuppressionEntry` (`suppression.rs`). Single JSON object map (key → entry), atomically rewritten via tmp + rename.

```json
{
  "deadline_approaching:decisions/patent-rfp.md": {
    "key": "deadline_approaching:decisions/patent-rfp.md",
    "template": "deadline_approaching",
    "scope": "decisions/patent-rfp.md",
    "dismiss_count": 3,
    "last_dismiss_at": "2026-04-26T14:23:00Z",
    "suppressed_until": "2026-05-26T14:23:00Z"
  }
}
```

### §6.1 Field semantics

- `key` — `"{template}:{scope}"`. Stored explicitly so a serialized array of entries via `suppression_list` keeps the key visible.
- `template` — Mirrors `TemplateMatch::template`.
- `scope` — Resolution chain: first `atom_refs[0]` → fallback `surface_id` → fallback `"global"`. Per-`{template, scope}`, not global, so dismissing the deadline template for atom A 3× does NOT suppress it for atom B.
- `dismiss_count` — Capped only by available telemetry. ≥ `SUPPRESSION_THRESHOLD` (3) trips promotion.
- `suppressed_until` — `Some(last_dismiss_at + 30d)` once threshold trips; `None` until then.

Re-promotion does NOT extend the window (tested in `test_re_promotion_does_not_extend_window`). Carry-forward preserves `suppressed_until` across recomputes even if the dismiss events age out of the 30-day telemetry walk.

---

## §7 Source provenance per source

Every atom's `source_provenance` object carries the same outer shape but the inner fields vary by `source`. The reverse path (writeback) parses the same fields back out via `sources::SourceProvenance` (`sources/mod.rs`).

| Source | Fields (in `source_provenance`) | Writeback target |
|---|---|---|
| `discord` | `voice_channel_id`, `message_url`, `speaker_id`, `timestamp` | (none — read-only) |
| `github` | `external_id` = `https://github.com/<org>/<repo>/pull/<n>`, `url`, `comment_line_ref` | POST `/issues/{n}/comments` |
| `linear` | `external_id` = `ENG-123`, `url` = issue URL | `issueCreate` mutation |
| `slack` | `channel`, `ts`, `thread_ts`, `permalink` | (writeback v1.9 P4 — pending) |
| `notion` | `page_id`, `db_id`, `last_edited` | (none) |
| `calendar` | `event_id`, `start`, `attendees[]` | (none) |
| `loom` | `video_id`, `transcript_line` | (none) |
| `zoom` | `meeting_id`, `recording_line`, `participants[]` | (none) |
| `email` | `thread_id`, `message_id`, `sender`, `provider` | (none — IMAP read-only) |
| `voice-notes` | `recorded_at`, `duration_sec`, `mime_type` | (n/a — local capture) |
| `canvas` | `canvas_project`, `canvas_topic`, `sticky_id` | (n/a — file is the surface) |

The legacy `source_id` field is still accepted on read (`sources::parse_decision_frontmatter` walks both); new writes use `external_id` inside `source_provenance`. v3.0 will drop `source_id` aliases.

---

## §8 Migration paths

### §8.1 v1.x → v2.0-alpha.1 (shipped, code at `app/src-tauri/src/migration.rs`)

`migrate_to_layered` runs on every boot. Idempotent — second run no-ops via `already_layered()`. Atomic — uses `std::fs::rename` per kind dir, falling back to recursive copy when cross-device rename fails. Sidecars (`.tangerine/`, `agi/`, `timeline/`, `canvas/`) are NEVER moved. `.gitignore` is rewritten on every run from `canonical_gitignore_body`.

Fresh installs: `migrated_kinds = []`, but `team/` skeleton + `personal/<user>/{kind}` seed are still created.

### §8.2 v2.0 → v2.5 cloud sync (planned)

Per-team `team/` directory becomes a git mirror to a cloud-hosted bare repo. Implementation sketch:
- `commands::sync` adds `git_remote_set` / `git_pull` / `git_push` Tauri commands.
- Conflict resolution: 3-way merge per atom file, frontmatter merged via key-union, body via standard git merge driver.
- `personal/` stays local-only, never mirrors.

### §8.3 v2.5 → v3.0 personal agent capture (planned)

Extends `personal/<user>/threads/` with `{agent-type}/` subdirs. Each Tangerine personal agent (planning, journal, recall) writes its own subtree. Reader walks the union of all `threads/{agent-type}/`. Backward-compat: existing flat `threads/` files remain readable, default to `agent-type=manual`.

### §8.4 Backward-compatible read window

Until v4.0, every reader walks the union of:
1. `team/{kind}/`
2. `personal/<current_user>/{kind}/`
3. Legacy flat `<root>/{kind}/` (only when migration hasn't run yet)

`memory_paths::resolve_atom_dir` is the only writer-side path resolver — readers (e.g. `commands::memory`) iterate all three.

---

## §9 Versioning strategy

Add a `schema_version` frontmatter field to every atom written from v2.0-alpha.2 onward:

```yaml
schema_version: 2.0
```

Reader behavior:

| Version on disk | Reader action |
|---|---|
| missing | Treat as `1.0`. Default all 8 AGI fields to null. Default `status` from legacy `decided` → `locked`. |
| `1.0` | Same as missing. |
| `2.0` | Native read. |
| `≥3.0` | Forward-compat: log warning, fall back to "best effort" — read known fields, ignore unknowns. NEVER error. |

Writes always emit the latest version the writer was compiled against. There is no "downgrade" path — once a v2.0 install touches a v1.0 atom, the next save lifts it to v2.0.

This decouples atom schema evolution from the app version. v2.1 can add a new optional field without forcing a migration tick. Hard cuts (e.g. v3.0 dropping `source_id`) get a one-time rewrite pass at boot.

---

## §10 Open questions for CEO

Five things this spec assumes that need a decision before v2.0 final:

### 10.1 Add `schema_version` to atoms? (recommend: yes)

Adds 1 line to every atom's frontmatter. Cost: ~15 bytes × N atoms. Benefit: clean forward-compat without sniff-detection. Without it, every reader has to inspect field presence to guess the version, which gets brittle as we add fields. Recommend ship `schema_version: 2.0` in v2.0-alpha.2.

### 10.2 Which 8 AGI fields are mandatory vs optional?

Currently all 8 default to null in the reader, populated lazily by the embedding pipeline. Argument for mandatory: the suggestion engine's confidence math degenerates when fields are missing. Argument for optional: forces a blocking embedding step on every atom write, and a rate-limit OpenAI burst on first-run. Recommend: keep all 8 optional, but the embedding pipeline runs as a daemon subtask and SHOULD have populated each within 10s of write. Templates that read these check for null and skip.

### 10.3 Move canvas-meta JSON from HTML comment to frontmatter?

Currently `<!-- canvas-meta: {...} -->` lives in an HTML comment inside the body. Pro of moving: cleaner diffs, Git highlights individual sticky changes instead of "one big JSON line per sticky". Con: each sticky has its own coordinates, color, comments — the topic file would end up with N stickies × M frontmatter blocks, which breaks the "one frontmatter at the top" YAML convention. Alternative: a per-sticky frontmatter sub-block under each `## sticky-{id}` heading. Recommend: keep current shape until we hit the diff-friendliness pain — track via user feedback.

### 10.4 Should co-thinker brain doc have a size cap?

Currently unbounded. After 6 months of use the brain.md could grow to 10+ MB if heartbeats keep accumulating `## Recent reasoning` bullets. The LLM prompt feeds this back every tick, so unbounded growth means quadratic context cost. Recommend: cap at 256 KB (≈ 50K tokens), with the engine truncating the oldest `## Recent reasoning` bullets when exceeded. Cap is configurable via `agi.brain_doc_cap_bytes` in `~/.tmi/config.yaml`.

### 10.5 Should the telemetry envelope carry more closed-set fields?

Today it's `{event, ts, user, payload}`. Useful additions: `app_version` (for telemetry replay across releases), `session_id` (for grouping a user's actions per app launch), `route` (for "where was the user when this fired"). Each adds ~20 bytes per event. Recommend: ship `app_version` and `session_id` in v1.9.0 final — both are cheap and unblock future analytics. `route` already lives in `navigate_route` payloads, no need to duplicate.

---

End of spec. Owner: data model agent. Update on every schema change. The frontend, the daemon, and the bundled samples all read this doc.
