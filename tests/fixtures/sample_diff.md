<!-- TMA knowledge-diff schema_version=1 meeting_id=2026-04-24-david-sync -->

## Block 1 · append · knowledge/session-state.md
**Reason**: Decision on v1 scope (David sync, 2026-04-24, Topic 1)
**Transcript refs**: L47, L52, L58
**Block-ID**: 1

```diff
+ ### 2026-04-24 — David sync
+ - v1 scope locked to Discord input + Claude Code output (Zoom deferred)
+ - Decided by daizhe; hongyu agreed after L52 exchange
+ - Action: @daizhe ship Discord bot prototype by 2026-04-28
```

---

## Block 2 · insert · CLAUDE.md
**Reason**: Weekly TMA dogfood commitment from Topic 2
**Transcript refs**: L112
**Anchor**: ## Workflow rules
**Block-ID**: 2

```diff
+ ### Meeting discipline
+ - Run every Monday standup through TMA (prep -> start -> wrap -> review)
+ - Owner: @daizhe
```

---

## Block 3 · create · knowledge/whisper-latency.md
**Reason**: New fact surfaced by advisor (L141)
**Transcript refs**: L141
**Block-ID**: 3

```markdown
# Whisper API latency observations

- CN-region: ~1.2s per 10s chunk (advisor measurement, 2026-04-24)
- Acceptable for live transcript use case
- Re-test after OpenAI's CN endpoint rollout
```
