---
schema_version: 1
author: daizhe
created_at: 2026-04-22T18:42:00+08:00
locked: true
locked_at: 2026-04-22T18:51:14+08:00
---

## Topics

### Topic 1: v1 输入平台拍板
- **Type**: decision
- **Goal**: 锁 A=Discord-only / B=Zoom-only / C=both
- **Expected disagreement**: Hongyu 会推 C，理由是不锁单一渠道
- **Current stance**: A——Zoom 延 v1.1，先 ship

### Topic 2: dual-stream feasibility 验证
- **Type**: verify
- **Goal**: 确认 Hongyu 测的 WASAPI loopback 能不能 per-user 区分 speaker
- **Expected disagreement**: 应该没有
- **Current stance**: 已知 loopback 把所有 voice 打成一个 user，需要 Discord bot per-user

### Topic 3: legal RFP 时间线
- **Type**: sync
- **Goal**: Advisor 同步 RFP 当前状态（4/30 截止，6 天）
- **Expected disagreement**: 无
- **Current stance**: 等 advisor 给数字

## Writeback expectations

- Decision on v1 平台 → `knowledge/session-state.md`
- Per-user 转录路径选型 → `knowledge/tma-decisions.md`（新建）
- legal RFP 状态 → 不进 knowledge，下次 sync 再处理
