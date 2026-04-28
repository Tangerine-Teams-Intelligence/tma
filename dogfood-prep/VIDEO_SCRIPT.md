# Tangerine AI Teams v1.12 — 60-Second Dogfood Video Script

**Wave 25 deliverable.** A 60-second screen-record walkthrough that ships
on the landing page hero + every Twitter announcement. Same flow as the
WelcomeOverlay copy + first-run experience but visual.

## Goal

A first-time viewer should grok in 60 seconds:
1. **What it is** — your team's shared AI memory across Cursor / Claude / Codex.
2. **What you do** — install, link a repo, watch the dashboard light up.
3. **Why it's different** — markdown brain (not black box) + AI-tools-first sidebar.

The video does not explain pricing. CTA at end is "Connect your team — start free."

## Pre-flight

* Wipe install: `rmdir /s "%LOCALAPPDATA%\Programs\Tangerine.AI.Teams"`
* Wipe brain: `rmdir /s "%USERPROFILE%\.tangerine-memory"`
* Reinstall fresh `.exe` from latest release
* Don't launch yet — start recording first

## Tools

* **OBS Studio** (free, cross-platform) for screen recording
  * Scene → Display Capture, 1920×1080
  * Output → Recording Format: MP4 (H.264, 30 fps, ~6 Mbps)
  * Audio → Mic input on if voiceover live; off if voiceover layered later
* **QuickTime** on macOS as an alternative (File → New Screen Recording)
* **Voiceover layered later** in DaVinci Resolve (free) or CapCut (free)
* **GIF for tweet** — convert MP4 to 800px-wide GIF via `ffmpeg`:

  ```bash
  ffmpeg -i tangerine-v1.12-demo.mp4 -vf "fps=12,scale=800:-1:flags=lanczos" \
    -loop 0 tangerine-v1.12-demo.gif
  ```

## Output dir

* `dogfood-prep/video/tangerine-v1.12-demo.mp4` — full quality, 60s, 1920×1080
* `dogfood-prep/video/tangerine-v1.12-demo.gif` — 800px wide, < 8 MB for Twitter
* `dogfood-prep/video/voiceover.txt` — script (this file's voiceover sections)

## Resolution + format

* Recording: 1920×1080 @ 30 fps, MP4 H.264
* Twitter compatible: < 2:20, < 512 MB → easy fit
* Landing page hero: poster frame at 0:05, autoplay muted on hover

---

## Storyboard (60 seconds, second-by-second)

### 0:00 – 0:05 — Open Tangerine app

**Visual.** Click Tangerine icon on desktop. App window opens. WelcomeOverlay Card 1 fades in.

**Voiceover.** "Your team uses Cursor, Claude, ChatGPT. None of them see what the others are doing."

**Note.** Cold-start budget is < 2s; trim any frame after the window appears so the cut feels snappy.

---

### 0:05 – 0:10 — WelcomeOverlay 4 cards

**Visual.** Quick swipe through the 4 WelcomeOverlay cards:
1. "No new AI subscription"
2. "AGI brain is markdown"
3. "Cross-vendor visibility"
4. "10 AI tools aligned"

**Voiceover.** "Tangerine connects them — one shared memory. Markdown you can read, edit, git-diff."

**Note.** This is fast — ~1.2s per card. The viewer reads headlines, not body. Use Cmd+Right or click "Next" rapidly. Click "Get started" at 0:10.

---

### 0:10 – 0:25 — SetupWizard chat-driven (Wave 18)

**Visual.** OnboardingChat lands inline on /today.
* Type: `I use Claude Code, link github.com/myorg/myrepo`
* Hit Enter. Wizard responds with detected AI tool + repo confirmation.

**Voiceover.** "Tell it your stack in one line. It detects your editor, links your repo, sets up the brain."

**Note.** Have the GitHub repo URL valid in clipboard ready (`Cmd+V`). Don't fight typos on camera.

---

### 0:25 – 0:40 — /today dashboard appears with sample data + hero search

**Visual.** Wizard completes → /today dashboard appears with seeded sample atoms (DemoModeBanner visible at top). Click hero search bar → type `auth bug` → results list filters in real time.

**Voiceover.** "Today's dashboard is seeded with sample team activity. Hit search — instant context across every AI session your team's run."

**Note.** Wave 13 demo seed gives you ~30 sample atoms to filter against. If the seed didn't fire, manually drop a few `.md` files in `~/.tangerine-memory/team/threads/` first.

---

### 0:40 – 0:50 — /memory file tree → graph view toggle

**Visual.**
* Click "Memory" in sidebar.
* Show file tree on left, atom preview on right.
* Click "Graph" toggle (Wave 23) → tree morphs into a force-directed graph of atoms + edges.

**Voiceover.** "Browse the memory as a tree, or flip to the graph to see how atoms connect across vendors."

**Note.** Graph view is Wave 23 (sibling agent owns it). If the toggle isn't wired yet at recording time, hold on the tree view + show a separate clip of the graph from the spec mockup.

---

### 0:50 – 0:55 — /brain split-view edit → save

**Visual.**
* Click "Brain" in sidebar.
* Split view: rendered markdown on left, editor on right.
* Add a sentence: `TEAM CONTEXT: shipping v1.12 this week.`
* Hit Cmd+S. Subtle "Saved" toast.

**Voiceover.** "The AGI's brain is just a markdown file. Edit it directly. It picks up your edits next heartbeat."

**Note.** Brain editor is Wave 21. Use the existing layout — split view should already work.

---

### 0:55 – 0:60 — CTA card

**Visual.** Cut to a static end frame: Tangerine logo, tagline, single CTA button "Connect your team — start free." URL `tangerineintelligence.ai` underneath.

**Voiceover.** "Connect your team. Start free."

**Note.** Hold on the end card 2 full seconds so the CTA registers. Total runtime: 60-62s — Twitter cuts at 2:20 anyway.

---

## Voiceover script (clean copy)

> Your team uses Cursor, Claude, ChatGPT. None of them see what the others are doing.
>
> Tangerine connects them — one shared memory. Markdown you can read, edit, git-diff.
>
> Tell it your stack in one line. It detects your editor, links your repo, sets up the brain.
>
> Today's dashboard is seeded with sample team activity. Hit search — instant context across every AI session your team's run.
>
> Browse the memory as a tree, or flip to the graph to see how atoms connect across vendors.
>
> The AGI's brain is just a markdown file. Edit it directly. It picks up your edits next heartbeat.
>
> Connect your team. Start free.

Voiceover word count: ~110 words. At 110 words per 60s = 1.83 wps — well within
TED-talk pace. Comfortable, not rushed.

## Recording checklist

- [ ] Wipe install + brain pre-flight (above)
- [ ] Set screen resolution to 1920×1080
- [ ] Hide all desktop icons + close other windows
- [ ] Disable notifications (Focus mode on macOS / Focus Assist on Windows)
- [ ] Test audio levels if recording voiceover live (-12dB peak)
- [ ] OBS recording on, click Tangerine icon
- [ ] Hit each storyboard step on cue
- [ ] Stop recording at 60s (allow 2s buffer)
- [ ] Trim in DaVinci Resolve / CapCut
- [ ] Export MP4 + GIF per format spec above
- [ ] Drop in `dogfood-prep/video/`

## Iteration

If the first take feels wooden, take 3 cuts and pick the best:
1. **Take 1** — slow + clear (for landing page)
2. **Take 2** — fast + punchy (for Twitter)
3. **Take 3** — silent + captions overlay (for autoplay-muted contexts)

Caption overlay text lives in the storyboard sections above. CapCut handles
auto-caption from voiceover; manually correct any AI-tool name typos
(it loves "Cursore" and "Calude").

## Post-record

Drop the final MP4 in `dogfood-prep/video/` and notify CEO. Landing page
deploy will pick it up via the existing `apps/Tangerine-intelligence-Official-Site/sites/deck/`
asset pipeline.
