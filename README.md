# Meeting Live

Realtime dual-stream transcription + Claude live observer for Discord meetings.

- **Mic** (you) + **WASAPI loopback** (everything Discord plays) → faster-whisper large-v3 on GPU → `transcript.md`
- A separate Claude Code session in this directory polls the transcript, flags inconsistencies against Tangerine ground truth, and writes `summary.md` at the end.

No API cost. Claude session uses your existing Claude Code subscription.

---

## First-time setup (~5 min)

```powershell
cd "C:\Users\daizhe zo\Desktop\meeting-live"
pip install -r requirements.txt
python list_devices.py
```

**Check the output:**
- `CUDA devices: 1` → GPU path will work (large-v3 float16)
- `WASAPI default mic` → your actual mic
- `WASAPI default output` → the output device Discord plays to (usually your headphones)

If CUDA check fails: make sure `nvidia-smi` works, then `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12`.

**First run of `transcribe.py` downloads the model (~3 GB) to `~/.cache/huggingface/`. Do this before meeting, not during.**

---

## Meeting start (2 commands, 2 terminals)

### Terminal 1 — transcription
```powershell
cd "C:\Users\daizhe zo\Desktop\meeting-live"
python transcribe.py
```
Wait for `Listening on Mic + Discord loopback.` Leave it running, minimize.

### Terminal 2 — Claude observer
```powershell
cd "C:\Users\daizhe zo\Desktop\meeting-live"
claude
```
Claude auto-reads `CLAUDE.md` (the session prompt in this directory). Then type:
```
/loop 每 60s 读 transcript.md 最后 2 分钟，挑盲点和矛盾，3 条以内
```
Put Terminal 2 on your side monitor. Glance at it during the meeting.

---

## During the meeting (in Terminal 2)

- Just talk. Observations auto-appear every ~60s.
- `现在说说` → immediate observation (skip wait)
- `/loop stop` → pause the loop

## Meeting end

In Terminal 2:
```
写总结
```
Claude reads the full transcript, writes `summary.md` with decisions + action items + open questions. Then `Ctrl+C` in Terminal 1.

---

## Files created

| File | Purpose |
|---|---|
| `transcript.md` | Full raw transcript, timestamped, speaker-labeled (`DZ` / `CTO`) |
| `summary.md`    | Post-meeting summary written by Claude |
| `advice.md`     | (optional) Claude's live observation history |

---

## Known constraints / gotchas

- **Loopback captures ALL system audio.** Close YouTube / Spotify / anything else making sound during the meeting.
- **Every voice on Discord gets tagged `CTO`.** For a 2-person call this is fine. For group calls you'd need Discord's per-user audio (not supported here).
- **Stereo Mix** (if enabled in Windows) will double-up audio. Disable it: Sound settings → Recording → Stereo Mix → Disable.
- **Model first download** is ~3 GB. Happens on first `transcribe.py` run. Do it ahead of time.

## Override device choice

If auto-detect picks the wrong device:
```powershell
$env:MIC_DEV=5      # from list_devices.py output
$env:LOOP_DEV=12
python transcribe.py
```

Other env overrides:
- `CHUNK_SECONDS=8` — processing window (default 10)
- `MODEL=medium` — smaller / faster model

---

## Architecture

```
Discord app audio ─┐
                   ├─► sounddevice (WASAPI loopback)  ─┐
Mic input          ┘                                    │
                                                        ▼
                                            soxr resample → 16kHz mono
                                                        ▼
                                 faster-whisper large-v3 (GPU, float16)
                                                        ▼
                                           transcript.md (append-only)
                                                        ▼
                              [new Claude Code terminal, /loop 60s]
                                                        ▼
                                       live observations in terminal
                                                        ▼
                                         "写总结" → summary.md
```
