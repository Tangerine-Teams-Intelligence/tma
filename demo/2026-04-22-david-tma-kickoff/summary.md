---
schema_version: 1
generated_at: 2026-04-22T19:08:14+08:00
meeting_id: 2026-04-22-david-tma-kickoff
participants: [daizhe, hongyu, advisor]
duration_minutes: 6
---

# David sync — TMA kickoff

## Topics covered

### Topic 1: v1 输入平台拍板
- **Outcome**: A 选定——Discord-only v1，Zoom 延 v1.1（立项书 §6.1 已记录）
- **Decided by**: daizhe (proposed) + hongyu (concurred)
- **Stance changes**: hongyu C → A，driven by 4-week vs 6-7-week ship 时间证据 @ L7
- **Transcript refs**: L1, L2-L7, L8

### Topic 2: dual-stream feasibility
- **Outcome**: WASAPI loopback per-user 不可行，v1 走 Discord bot 内部 receiver.subscribe per-user。@discordjs/voice 的 deprecation warning 须写进 INTERFACES.md §10
- **Decided by**: hongyu (reported) + daizhe (ratified)
- **Stance changes**: 无
- **Transcript refs**: L9-L15

### Topic 3: legal RFP 时间线
- **Outcome**: advisor 4/26 给 RFP draft + TI-2026-006 ARM detail 修复；DZ 4/27 review
- **Decided by**: 共识
- **Stance changes**: 无
- **Transcript refs**: L16-L22

## Topics raised but not resolved

- v1 阶段 bandwidth / 招聘讨论（hongyu @ L23）—— 显式 deferred to 下周 1on1，不进本会议 commitments

## Topics in intents but not raised

- 无

## Action items

- [ ] @daizhe — 立项书 §6.1 锁 v1 = Discord-only / v1.1 = Zoom adapter（today）
- [ ] @daizhe — INTERFACES.md §10 加 discord.js voice 包 deprecation 监控（today）
- [ ] @advisor — TI-2026-006 Claim 1 ARM detail 修复（by 2026-04-25）
- [ ] @advisor — RFP draft（by 2026-04-26）
- [ ] @daizhe — RFP review（2026-04-27）

## New facts surfaced

- @discordjs/voice 0.17 已有 npm deprecation warning（旧加密模式）。能跑，但需要 upgrade path 进 INTERFACES.md §10
- WASAPI system loopback 不能 per-user 区分 speaker——确认归档 legacy
