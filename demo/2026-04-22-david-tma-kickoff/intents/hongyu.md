---
schema_version: 1
author: hongyu
created_at: 2026-04-22T18:55:00+08:00
locked: true
locked_at: 2026-04-22T18:58:40+08:00
---

## Topics

### Topic 1: v1 输入平台
- **Type**: decision
- **Goal**: 我倾向 both——Zoom 用户基数大，dogfood 要照顾两个客户场景
- **Expected disagreement**: DZ 会想锁 Discord-only 抢时间
- **Current stance**: C（both），但如果 4 周 vs 6 周 ship 时间证据强可以撤

### Topic 2: dual-stream feasibility
- **Type**: verify
- **Goal**: 报告 WASAPI loopback 测试结果——能跑但 per-user 区分不出，结论 v1 必须用 Discord bot 内部 receiver.subscribe
- **Expected disagreement**: 无
- **Current stance**: 路径已清，技术上做得到

## Writeback expectations

- 转录 stack 决策 → `knowledge/tma-decisions.md`
- 不期望多写 rule
