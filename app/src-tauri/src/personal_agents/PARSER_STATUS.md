# Personal Agent Parser Status

Wave 4-B real-world validation pass. Each parser's schema source, whether it
has been validated against actual files on a real user's machine, and what
that validation found.

| Agent | Schema source | Real-file validated | Status |
|-------|---------------|---------------------|--------|
| Cursor | `~/.cursor/conversations/*.json` | NO — Cursor not installed on validation machine | Schema assumed (no real-world validation possible without install) |
| Claude Code | `~/.claude/projects/<slug>/<uuid>.jsonl` | YES — 41 sessions, 8483 messages, CEO machine 2026-04-26 | Parser robust + idempotence bug fixed |
| Codex | `~/.config/openai/sessions/*` | NO — Codex not installed on validation machine | Schema assumed (no real-world validation possible without install) |
| Windsurf | `~/.windsurf/conversations/*.json` (Cursor-shaped) | NO — Windsurf not installed on validation machine | Schema assumed (no real-world validation possible without install) |
| Devin | API webhook + REST poll | NO — API-based, requires license/token to validate live | API stub (parser exercised via fixture payloads only) |
| Replit | API REST poll | NO — API-based, requires token to validate live | API stub (parser exercised via fixture payloads only) |
| Apple Intelligence | Local sqlite/plist (macOS only) | NO — running on Windows | Schema assumed (cannot run on validation machine) |
| MS Copilot | Microsoft Graph activities API | NO — API-based, requires license/token to validate live | API stub (parser exercised via fixture payloads only) |

## Claude Code — confirmed-working file format

Each session writes a JSONL file at `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`.
Each line is a JSON object. Top-level `type` discriminator observed in the
wild (CEO machine, Apr 2026):

```
ai-title              attachment              authentication_error
assistant             compact_file_reference  custom-title
deferred_tools_delta  direct                  error
file                  hook_success            hook_system_message
last-prompt           mcp_instructions_delta  message
plan_file_reference   queue-operation         queued_command
skill_listing         summary                 system
text                  thinking                todo_reminder
tool_reference        tool_result             tool_use
update                user
```

The parser only consumes `type:"user"` and `type:"assistant"` events; the
rest are diagnostic noise from the user's perspective and ignored.

User event shape (string-content prompt):

```json
{"parentUuid":null,"type":"user","message":{"role":"user","content":"..."},
 "uuid":"...","timestamp":"2026-04-18T22:19:07.322Z","sessionId":"...",
 "version":"2.1.111","gitBranch":"HEAD","cwd":"..."}
```

User event shape (tool_result reply — content is array, parser correctly
skips because no top-level `type:"text"` block):

```json
{"type":"user","message":{"role":"user","content":[
  {"tool_use_id":"toolu_...","type":"tool_result","content":[
    {"type":"text","text":"..."}]}]}, ...}
```

Assistant event shape (thinking + text blocks):

```json
{"type":"assistant","message":{"model":"claude-opus-4-7","role":"assistant",
 "content":[{"type":"thinking","thinking":"...","signature":"..."},
            {"type":"text","text":"..."}]},
 "timestamp":"...","sessionId":"..."}
```

Parser's `ClaudeCodeMessage::body()` walks the `content` array, picks
`type:"text"` blocks, concatenates them, ignores `thinking` and tool
blocks. Confirmed correct against real CEO sessions.

## Idempotence bug found and fixed (2026-04-26)

Bug: `capture_one_session` checked the atom path built from the
**filename stem** before reading the JSONL. When the in-file `sessionId`
disagrees with the filename uuid (happens after session resume/fork), the
final atom is written to a different path. The provisional pre-check
always missed, so every heartbeat re-parsed and re-wrote the same atom.

Reproduction on CEO machine: 9 of 43 sessions had stem != sessionId;
second `capture()` call rewrote 9 atoms instead of being a no-op.

Fix: after `parse_jsonl` resolves the real `atom_path`, also check
`read_atom_source_mtime(atom_path) >= src_nanos` and skip if so. Added a
real-world capture test under `tests/personal_agents_realworld.rs` that
re-runs `capture()` and asserts `written == 0` on the second pass.

## Real-world validation test

`app/src-tauri/tests/personal_agents_realworld.rs` (gated `#[ignore]`,
runs only with `cargo test ... -- --ignored`). Two cases:

1. `claude_code_parses_every_real_session_without_error` — walks
   `~/.claude/projects/`, parses every JSONL under 50 MB, asserts no
   parse errors and every parsed atom has a non-empty body and stable
   conversation id.
2. `claude_code_capture_writes_real_atoms_to_temp_dir` — runs the full
   `capture()` against a temp output dir, samples one atom, validates
   YAML frontmatter shape and role labels, then re-runs capture and
   asserts the second pass writes 0 atoms (idempotence).

The test never copies user data into the repo. CEO conversation files
stay read-only at `~/.claude/projects/`.

## What changes if we want real-world validation for the other 7 agents

- Cursor / Codex / Windsurf — install on a dev machine, run the same
  pattern: walk the conversation dir, parse every file, fix any schema
  mismatches.
- Apple Intelligence — needs a macOS dev machine with the agent
  enabled.
- Devin / Replit / MS Copilot — provision real API tokens, replace the
  stub `poll_recent` with a live call against a sandbox account, capture
  one real conversation, diff against current parser.
