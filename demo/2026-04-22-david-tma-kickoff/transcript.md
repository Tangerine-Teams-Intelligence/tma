[19:01:08] daizhe: 开始。今天 sync 三件事——v1 输入平台、dual-stream feasibility、legal RFP 时间线。先 v1 平台。
[19:01:24] hongyu: 我会前 intent 写的是 both。Zoom 用户基数大，不想 v1 就锁 Discord。
[19:01:42] daizhe: 数字层面：Zoom Marketplace 审核 2-3 周，外加 OAuth 流程实现。Discord bot 一个晚上。
[19:01:58] daizhe: 4 周 vs 6-7 周 ship。我想抢 narrative 窗口。
[19:02:18] hongyu: 嗯……如果只差两周，我接受。但 v1.1 必须立刻接 Zoom 不要拖。
[19:02:32] daizhe: 同意，v1.1 第一件事就是 Zoom adapter。立项书 §6 写死。
[19:02:46] daizhe: Topic 1 拍了——A=Discord-only v1，Zoom 延 v1.1，立刻接。
[19:03:02] hongyu: OK。Topic 2 我同步：WASAPI loopback 我测了一晚上。
[19:03:18] hongyu: 能跑，转录质量也行。但所有 voice 都被打成一个 user，per-user 区分不出。
[19:03:34] hongyu: 走 Discord bot 内部 voice receiver subscribe 才能 per-user。
[19:03:48] daizhe: 那就是 v1 必须 Discord bot 模式，不能走 system loopback。
[19:04:02] hongyu: 对。@discordjs/voice 的 receiver.speaking + receiver.subscribe 是文档化的。
[19:04:14] hongyu: 风险点：discord.js 的 voice 包已经 npm deprecation warning，加密模式旧。能跑但要 upgrade path。
[19:04:30] daizhe: 知道了，写进 INTERFACES.md §10 failure modes。Topic 2 拍：v1 直接 Discord bot per-user 路径，WASAPI 进 legacy/。
[19:04:48] daizhe: Topic 3——advisor 你 RFP 时间线。
[19:05:02] advisor: 4/30 截止 6 天。P0 八件 docx 我 4/24 跑了一遍 audit——TI-2026-006 还有 1 FAIL，Claim 1 ARM detail。
[19:05:22] advisor: 我准备 4/26 给 RFP draft。需要 DZ 4/27 过一遍。
[19:05:36] daizhe: 4/27 我可以 review。但 006 的 ARM detail 谁修？
[19:05:50] advisor: 我修。这周内。
[19:06:04] daizhe: OK。Topic 3 拍：advisor 4/26 RFP draft + 006 ARM 修，DZ 4/27 review。这条不进 knowledge，进 action items。
[19:06:22] daizhe: 还有事吗？
[19:06:30] hongyu: 一件——TMA 立项书 §11 写 v1 阶段 0 招聘，但如果 v1 卡 D3 Discord 这块，我个人 bandwidth 撑不住两条线。
[19:06:48] daizhe: 这个挂起，下周 1on1 谈。不在今天 scope。
[19:07:00] daizhe: 收。wrap。
