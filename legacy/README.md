# Legacy — WASAPI proof of concept

This is the original approach: local faster-whisper + Windows WASAPI dual-stream capture + `/loop`-based Claude observer. It works but has hard constraints that made it the wrong foundation for Tangerine Meeting Assistant v1:

- **Windows-only** (WASAPI is not cross-platform)
- **All Discord voices get labeled as one speaker** (system loopback can't separate per-user audio)
- **Single-member only** (no pre-meeting intent capture, no multi-member coordination)
- **No knowledge writeback** (summary.md is a dead end — it doesn't flow into CLAUDE.md or knowledge/)

The v1 architecture replaces this with:
- Discord bot using `@discordjs/voice` (cross-platform, per-user audio streams)
- Whisper API (no local GPU requirement)
- Structured pre-meeting intent capture per member
- Post-meeting diff review and writeback to target knowledge repo

See the root [PLAN.md](../PLAN.md) for the full spec.

Files in this directory are preserved for reference only. Do not extend them.
