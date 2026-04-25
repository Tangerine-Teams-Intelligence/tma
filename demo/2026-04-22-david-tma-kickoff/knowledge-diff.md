<!-- TMA knowledge-diff schema_version=1 meeting_id=2026-04-22-david-tma-kickoff -->

## Block 1 · append · knowledge/session-state.md
**Reason**: v1 输入平台决策落地（Topic 1）
**Transcript refs**: L1, L7, L8
**Block-ID**: 1

```diff
+ ### 2026-04-22 — David sync · TMA kickoff
+ - v1 输入平台锁定 = Discord-only（4 周 ship）
+ - v1.1 第一件事 = Zoom adapter（立项书 §6.1）
+ - Hongyu 立场 C → A，driven by 4-week ship 时间证据
+ - Action: @daizhe 今天更新立项书 §6.1
```

---

## Block 2 · append · CLAUDE.md
**Reason**: 监控 discord.js voice 包 deprecation 风险，写进运行时铁律
**Transcript refs**: L13, L14
**Block-ID**: 2

```diff
+ ### TMA 部署铁律（v1）
+ - @discordjs/voice 0.17 已有 npm deprecation warning（旧加密模式）。upgrade path 进 INTERFACES.md §10。每月 review 一次升级状态。
```

---

## Block 3 · create · knowledge/tma-decisions.md
**Reason**: 转录 stack 选型决策需新文件归档
**Transcript refs**: L9-L15
**Block-ID**: 3

```diff
+ # TMA 转录 stack 决策
+
+ ## 2026-04-22 — Discord bot per-user 路径
+
+ - WASAPI system loopback 不能 per-user 区分 speaker（Hongyu 实测确认）
+ - v1 走 @discordjs/voice receiver.subscribe per-user 路径
+ - 旧 WASAPI POC 归档 legacy/
+ - 缓冲策略：每 user 10s 段送 Whisper API（per INTERFACES.md §5）
+ - 转录延迟目标：12-15s 端到端
```

---

## Block 4 · append · knowledge/session-state.md
**Reason**: 标记 advisor RFP topic 为 action 而不是 decision，并记录修复 commitment
**Transcript refs**: L16-L22
**Block-ID**: 4

```diff
+ ### 2026-04-22 — RFP 进度追踪
+ - advisor 提交 RFP draft：deadline 2026-04-26
+ - TI-2026-006 Claim 1 ARM detail 修复：deadline 2026-04-25（advisor）
+ - DZ review RFP：2026-04-27
+ - 不进 knowledge rule 体系——这是 sync 不是 decision
```
