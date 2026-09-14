# 验证记录

验证环境：Windows PowerShell、Node.js v24.16.0、Codex CLI 0.146.0、本地 DeepSeek Harness 0.1.5-rc.2。当前默认路由与最新实际确认值：`["deepseek-official","deepseek-flash"]`（DSH 标准供应商，目录显示 DeepSeek-V41-Flash）。

## 自动化行为测试

`npm test` 共 11 项通过，使用模拟后端验证：重复请求去重、参数冲突拒绝、同会话排队、同目录串行与跨目录并发、失败后不自动执行排队写操作、取消当前及排队任务、一次性授权隔离、重启中断标记、增量长轮询、输入约束、关闭与续接的竞态；另验证标准供应商内置目录及自定义目录检测。

## 真实 ACP / MCP 验证

通过插件 MCP 客户端调用 DeepSeek 标准供应商（2026-09-14）：

1. MCP 初始化并列出 8 个工具；确认指定路由。
2. 同一个 requestId 提交两次，只创建一个任务。
3. 任务运行中关闭 MCP 客户端，重新连接后继续查看。
4. DSH 实际创建 `calc.mjs` 和 `verify.mjs`，执行断言并打印 `DSH_TEST_OK`；主代理再次独立运行验证命令。
5. 向原会话追加乘法需求，DSH 修改文件、再次执行验证，并记住只存在于会话中的口令。
6. 关闭 DSH 会话、重启控制服务，再继续任务；恢复同一原生 DSH sessionId，并正确回答先前口令。
7. 取消活动轮次，状态最终为 `cancelled`。

## 工作目录继承验证

`dsh_start_task` 不再要求主代理手工传入目录。插件向当前 MCP 客户端请求 `roots/list`，将主 Codex 会话暴露的 `file:` 根目录解析为真实路径，并在提交到控制服务前固定该路径；如果调用方同时传入不同目录会被拒绝。独立 MCP 客户端仍可通过显式绝对路径或 `DSH_COMMANDER_WORKDIR` 运行。

本次真实验收通过 MCP roots 返回独立验收目录，启动和续接任务的 `cwd` 均为该根目录；未创建或修改插件安装目录中的文件。

本机原始证据：

`C:/Users/22712/.dsh-commander/verification/eeb2144b-340b-46f7-95f6-4050e8c621fa/evidence.json`

以上为实际模型与工具执行，不是仅检查 HTTP 或模拟响应。控制服务非正常退出后的“不自动重放”通过模拟状态恢复测试覆盖；真实重启验收使用正常关闭后恢复。

## Codex 安装入口

使用 `codex plugin add dsh-commander@personal` 安装后，通过 Codex App Server 的 `mcpServerStatus/list` 确认：

- 服务 `dsh_commander` 成功初始化，serverInfo 为 `dsh-commander / 0.1.0`。
- 全部 8 个工具可被 Codex 发现。
- 使用 `cwd: "."` 和相对入口路径，避免不被 Codex 展开的 `${CLAUDE_PLUGIN_ROOT}`。

插件规范验证与技能规范验证均通过。桌面界面中的新会话需要重新加载安装后的工具；未声称在当前旧会话热加载成功。

## 运行时限制

- 固定的是供应商声明的模型 ID；无法独立验证第三方供应商背后实际部署的模型权重。
- 本机 DSH 的默认权限为 `danger-full-access`，插件沿用 DSH 的既有设置；主代理继续约束用户授权范围。
- DSH Shell 中 `node` 简称未必可用，插件只在自己的 ACP 组合中追加已验证 Node 绝对路径提示。未修改系统 PATH。
- Windows 为真实验证平台；其他操作系统未进行实机验收。

历史 Koazy 路由曾完成同样的完整验收，证据保留在 `verification/25ecfcc3-2676-4135-b0d0-77267dab87b4/evidence.json`。随后安装副本的两次在线检查收到 Koazy 的 HTTP 503 `model_not_found`（default 分组没有可用模型通道）；插件记录为失败并返回调用方。用户随后明确要求切换为 DeepSeek 标准供应商，已更新默认配置并重新通过上面的完整验收。旧任务保留原路由，新任务使用标准供应商。
