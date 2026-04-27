# Screenshots — placeholder

Screenshots will be captured during the next dogfood run (CEO self-test or first outside tester) and committed to this folder. Each phase of `CHECKLIST.md` gets one canonical screenshot.

## Filenames to capture

- `01-install.png` — installer wizard mid-flow (or post-launch desktop with shortcut visible)
- `02-welcome-card-1.png` — "No new AI subscription"
- `03-welcome-card-2.png` — "AGI brain is markdown"
- `04-welcome-card-3.png` — "Cross-vendor visibility"
- `05-welcome-card-4.png` — "10 AI tools aligned" with sidebar preview
- `06-cothinker-init.png` — `/co-thinker` route after first heartbeat, brain.md visible
- `07-sidebar-aitools.png` — left sidebar "AI TOOLS" section, one tool starred
- `08-feedback-form.png` — Phase 8 free-form questions, ideally with sample answer

## Capture rules

- Native resolution (no scaling). 1080p or higher.
- PNG only. No JPEG.
- Crop to app window (no taskbar / desktop bg).
- No personal data visible (redact `~/.tangerine-memory/personal/<name>/` paths if name is real).
- Keep file size < 500KB each — use `pngquant` or similar if larger.

## Out of scope here

These are not generated yet. Generating them requires running the app, which is out of scope for the dogfood-prep doc pass. Capture happens during the actual dogfood run.
