# DSH Commander 优化实施与验收

实施依据：[优化方案](/E:/dsh/dsh-commander-optimization-plan.md)。日期：2026-09-14。

## 完成内容

1. `waitFor=actionable` 默认忽略普通文本和工具进度，权限、未读已结束轮次和终态可唤醒；`change` 支持积压事件即时返回。
2. `compact` 默认不带 events/turns/运行正文；最终结果通过调用方 `afterResultVersion` 确认；有效报告不附前面进度，fallback 为最多 2000 字符尾部。报告 JSON 最多 12000 字符，超限显式 fallback。完整原文与产物路径可按需读取。
3. start/continue 实际派发均注入短合同，原始 prompt 独立保存作幂等比较。合同要求完成整个交付物、核实事实、保持范围、遇阻给证据与选项、不得编造检查结果，并按固定标记输出 JSON。
4. 指挥技能新增路由标准、任务卡、执行自主边界、升级条件、两轮返工后重新诊断和独立验收要求。四类中文模板按需加载，不把完整手册放进每轮提示。

## 保留的已有修复

[verify-dist-hang-fix.md](verify-dist-hang-fix.md) 中的异常清理、隔离控制服务定位、报告文件与快照区分、损坏快照跳过以及 report artifact 路径修复均保留。未扩展处理该文档所列的状态回收、Node PATH 或 Windows ACL 项目。

复核又补充了：旧任务 seq/resultVersion 迁移、重启后执行轮部分证据保存、诊断 result/finalText 路径指向实际完成轮、continue 不重复上一轮报告、Windows 工作目录大小写串行比较。报告 decision_required 无问题文本时拒绝解析，避免空升级请求。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| `npm test` | 46 个测试全部通过 |
| `npm run build` | dist/server.mjs 与 dist/daemon.mjs 构建成功 |
| `npm run verify` | 4 项断言通过；自身临时 controller stopped/pipeGone 均 true |
| skill-creator quick_validate | 通过 |
| plugin-creator validate_plugin | 通过 |
| 已安装 MCP 服务真实调用 | 两轮通过，均合法结构化报告，无 fallback |

安装版本：`0.1.0+codex.20260914152306`。安装副本：`C:\Users\22712\.codex\plugins\cache\personal\dsh-commander\0.1.0+codex.20260914152306`。

实际路由为 `deepseek-official / deepseek-flash`，沿用当前 npm 启动配置。冒烟第一轮执行 PowerShell + Node 打印 `INSTALLED_DSH_PLUGIN_OK`，验证 checks 与 report artifact；第二轮不调用工具，在同一原生会话复述标记，验证 continue 注入合同及上下文恢复。结果版本为 1、2，相同版本重复请求 reportState=omitted，报告文件路径保持可见。

原生 sessionId：`eb8b5bbb-8709-495f-ad39-d1860b3d08db`。完整冒烟证据保存在用户状态目录 `verification/installed-smoke/evidence-*.json`。仅关闭本次冒烟任务；更新前确认控制服务没有活动任务后平滑重启，验收后 activeTasks=0。

## 协议开销测量的范围

`scripts/overhead-eval.mjs` 和 [overhead-eval.json](overhead-eval.json) 使用模拟后端。约 50754 字符累计输出的旧初始快照为 33196 UTF-8 字节，新报告回包约 3235，确认后约 1700。新协议实际一次 actionable 等待返回 1 次；期间记录了 305 个 change 信号。信号数不是旧版 MCP 调用次数，更不是 Astra 轮次；不再使用假定轮询频率推算模型节省倍数。

这些数字证明该合成场景的回包缩小、无效进度不唤醒；不证明实际 ChatGPT 订阅额度节省百分比。

## 指挥规则情景检查与边界

- 目标明确、步骤多的实现：一张任务卡交付完整成果；局部实现自主，末尾统一报告。
- 根因未知、存在架构选择：先只读调查，提供证据和候选，再由主代理决策并续派。
- 需要越范围或缺凭据：停相关写入，报告 blocked/decision_required，不通过替代供应商绕开。
- 两轮验收返工仍不收敛：主代理重新诊断或缩小任务，不重复泛泛指令。

技能模板已做上述情景核对，真实模型验收仅覆盖短执行任务和同会话续接；未做复杂业务任务的大样本质量/额度对照实验。新版技能和 MCP 参数请在新 Codex 任务加载；本任务工具 schema 可能仍是启动时版本。

