# CEO Self-Test Script — Tangerine Teams v1.9.1

For CEO to run himself end-to-end, with timing markers, before handing the build to an outside tester. Same flow as `CHECKLIST.md` but with stopwatch checkpoints.

**Pre-flight (do this once before starting timer):**
- Wipe old install: `rmdir /s "%LOCALAPPDATA%\Programs\Tangerine.AI.Teams"` (Windows)
- Wipe brain: `rmdir /s "%USERPROFILE%\.tangerine-memory"` (Windows)
- Close all editors and AI tools
- Start stopwatch at "Launch installer" below

---

## Phase 1 — Install (budget 5 min, target 3 min)

| t (mm:ss) | Step | Expected |
|-----------|------|----------|
| 0:00 | Click installer `.exe` | UAC prompt within 2s |
| 0:05 | Click through installer wizard (Next / Next / Install) | Default install path; no dependency errors |
| 1:30 | Installer finishes | Desktop shortcut + Start menu entry created |
| 1:45 | Launch app | Window appears within 10s |
| 2:00 | App ready | WelcomeOverlay Card 1 visible |

**Red flag**: if window takes > 15s to appear, log a perf bug.

---

## Phase 2 — WelcomeOverlay (budget 30 sec, target 25 sec)

| t (mm:ss) | Step | Expected |
|-----------|------|----------|
| 2:00 | Card 1 visible — "No new AI subscription" | Headline + 1 sentence + Next button |
| 2:07 | Click Next → Card 2 — "AGI brain is markdown" | Animated transition < 300ms |
| 2:14 | Click Next → Card 3 — "Cross-vendor visibility" | Logo strip of 5–10 AI tools |
| 2:21 | Click Next → Card 4 — "10 AI tools aligned" | Sidebar preview screenshot |
| 2:28 | Click "Get started" | Overlay dismisses, main app visible |

**Red flag**: any card > 10 sec to read = copy is too long. Cut.

---

## Phase 3 — Co-thinker init (budget 10 sec, target 8 sec)

| t (mm:ss) | Step | Expected |
|-----------|------|----------|
| 2:30 | Click `/co-thinker` in nav | Route loads < 500ms |
| 2:32 | Read explainer card | 2–3 sentences, no jargon |
| 2:35 | Click "Initialize" | Spinner + "thinking..." indicator |
| 2:40 | First heartbeat completes | `brain.md` preview rendered in app |
| 2:45 | Verify content | Not empty, not lorem ipsum |

**Red flag**: heartbeat > 15s = LLM call hanging or rate-limited.

---

## Phase 4 — Markdown brain edit (budget 2 min active + idle wait)

| t (mm:ss) | Step | Expected |
|-----------|------|----------|
| 2:45 | Open Notepad, navigate to `%USERPROFILE%\.tangerine-memory\team\co-thinker.md` | File exists, ~500–2000 chars |
| 3:00 | Add line `TEST: edited at <time>` | File saves cleanly |
| 3:05 | Switch back to Tangerine app | App stays running |
| 3:10 | (idle) wait 5 min for next heartbeat | Heartbeat triggers automatically |
| 8:10 | Re-open `co-thinker.md` | Edit still present |
| 8:12 | Check for AGI acknowledgement | Bonus: AGI mentions the edit in next response |

**Red flag**: AGI overwrites the manual edit silently. That breaks moat #2.

---

## Phase 5 — AI tools sidebar (budget 1 min, target 40 sec)

| t (mm:ss) | Step | Expected |
|-----------|------|----------|
| 8:12 | Open left sidebar | "AI TOOLS" section visible |
| 8:20 | Star first tool | Star fills, persists on reload |
| 8:25 | Click "Auto-configure" | Toast "Copied to clipboard" |
| 8:30 | Paste in Notepad | Valid JSON, has `mcpServers` key, has `tangerine` entry |

**Red flag**: clipboard contains placeholder text → MCP config generator is broken.

---

## Phase 6 — Cross-vendor parser (passive, 30 min)

CEO uses Cursor or Claude Code normally for 30 min real work. Then:

| t (mm:ss) | Step | Expected |
|-----------|------|----------|
| 38:30 | Navigate to `%USERPROFILE%\.tangerine-memory\personal\<name>\threads\` | Folder exists |
| 38:35 | Open `claude-code/` (or whichever vendor used) | At least 1 `.md` atom file |
| 38:40 | Open atom file | Real prompt + response captured, not empty |

**Known status**: Claude Code parser confirmed working as of v1.9.0. Cursor/Codex/Windsurf parsers in progress — note which produce atoms.

---

## Phase 7 — MCP sampling (budget 5 min, OPTIONAL)

Only if CEO has Cursor running.

| t (mm:ss) | Step | Expected |
|-----------|------|----------|
| 38:40 | Open `~/.cursor/mcp.json` | File exists |
| 38:45 | Paste tangerine MCP entry from clipboard | JSON valid |
| 38:50 | Add env `TANGERINE_SAMPLING_BRIDGE=1` | Saved |
| 38:55 | Quit + reopen Cursor | MCP servers load |
| 40:00 | Tangerine app → `/ai-tools/cursor` → "Test Query" | Real LLM response, not canned |

**Red flag**: response is "MCP not connected" or canned text. Means sampling bridge regression.

---

## Phase 8 — Self-feedback (5 min)

CEO writes answers to the same 3 questions in `CHECKLIST.md` Phase 8 — but as if seeing v1.9.1 fresh. Compare against expected outside-tester response. If CEO's own answers are vague or hesitant, the build isn't ready to hand to a tester.

---

## Total budget

- Phases 1–5: ~10 min active
- Phase 6: 30 min passive (do real work)
- Phase 7: 5 min optional
- Phase 8: 5 min
- **Grand total**: ~50 min including 30 min passive observation

If any phase fails, fix before scheduling outside tester.
