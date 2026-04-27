# Tangerine Teams v1.9.1 — Tester Checklist

Tick `- [x]` as you complete each step. If something fails, write `FAIL: <what happened>` on that line.

---

## Phase 1: Install (target < 5 min)

- [ ] Download `Tangerine.AI.Teams_1.9.0_x64-setup.exe` from https://github.com/Tangerine-Teams-Intelligence/tangerine-teams-app/releases/v1.9.1
- [ ] Run installer (Windows). If you're on macOS/Linux: those builds ship later in v1.9.x — skip the rest and tell CEO.
- [ ] Launch app from Start menu / desktop shortcut
- [ ] **PASS**: app window opens within 10s, no crash dialogs
- Time elapsed: ____ sec

---

## Phase 2: WelcomeOverlay (target 30 sec total)

Read each card. Click Next. Note your first reaction in one word (confused / clear / boring / interesting / scary).

- [ ] **Card 1** — "No new AI subscription"
  - Headline make sense without explanation? Y / N
  - Reaction: ______
- [ ] **Card 2** — "AGI brain is markdown"
  - Feels: scary / magical / boring / neutral (circle one)
- [ ] **Card 3** — "Cross-vendor visibility"
  - Do you understand which AI tools are listed? Y / N
- [ ] **Card 4** — "10 AI tools aligned"
  - Sidebar preview makes sense? Y / N
- [ ] Click "Get started"
- [ ] **PASS**: total elapsed < 30 sec, every card understood
- Time elapsed: ____ sec

---

## Phase 3: Co-thinker init (target 10 sec)

- [ ] Click into `/co-thinker` route in the app
- [ ] Read the explainer card
- [ ] Click "Initialize"
- [ ] Wait for first heartbeat (~5–10s)
- [ ] **PASS**: `brain.md` content visible, readable, sensible (not empty, not gibberish)

---

## Phase 4: Markdown brain edit (target 2 min, then idle wait)

- [ ] Open `~/.tangerine-memory/team/co-thinker.md` in Notepad / VSCode / any text editor
  - On Windows: `C:\Users\<you>\.tangerine-memory\team\co-thinker.md`
- [ ] Add a sentence somewhere in the file: `TEST: I edited this manually at <time>`
- [ ] Save
- [ ] Wait for next heartbeat (5 min idle / 30 min active — easiest is to leave the app open and walk away 5 min)
- [ ] Re-open the file
- [ ] **PASS**: your edit survived. Bonus pass: AGI acknowledged it (mentioned in next heartbeat output)

---

## Phase 5: AI tools sidebar (target 1 min)

- [ ] Open the sidebar (left side of app)
- [ ] Find the "AI TOOLS" section
- [ ] Star the first tool (click the star icon)
- [ ] Click "Auto-configure" if the button is available
- [ ] Paste your clipboard somewhere (Notepad) — confirm it's a JSON snippet, not garbage
- [ ] **PASS**: starred state persists after reload, clipboard contains valid JSON

---

## Phase 6: Cross-vendor parser (passive, ~30 min)

- [ ] Use your normal AI tool (Cursor / Claude Code / Codex / Windsurf / ChatGPT desktop) for any real task — at least 3 prompts.
- [ ] After ~30 min, check `~/.tangerine-memory/personal/<your-name>/threads/<vendor>/`
  - On Windows: `C:\Users\<you>\.tangerine-memory\personal\<your-name>\threads\<vendor>\`
- [ ] **PASS**: at least 1 atom file appears for the tool you used
- Which tool did you use? ______
- Did atoms appear? Y / N
- Note: Claude Code is confirmed working. Cursor / Codex / Windsurf may or may not — note which.

---

## Phase 7: MCP sampling (target 5 min, OPTIONAL — advanced)

Skip this phase if you don't use Cursor or don't have Cursor Pro.

- [ ] Open `~/.cursor/mcp.json` (or your editor's equivalent)
- [ ] Add the Tangerine MCP server entry from the auto-configure clipboard (Phase 5)
- [ ] Add env var `TANGERINE_SAMPLING_BRIDGE=1`
- [ ] Restart Cursor
- [ ] In Tangerine app, go to `/ai-tools/cursor` → click "Test Query"
- [ ] **PASS**: response is real Cursor LLM output (not canned text like "MCP not connected")

---

## Phase 8: Free-form (3 questions)

Write 1–3 sentences each. No need to be polite.

**Q1.** After 30 min, what would you tell a friend Tangerine is in one sentence?

> 

**Q2.** What confused you most?

> 

**Q3.** Would you keep using it tomorrow? Why / why not?

> 

---

## Send back to CEO

Email this filled-in checklist to **daizhe@berkeley.edu** or paste in a chat message. Done.
