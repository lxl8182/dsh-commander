# DSH Commander

让 Codex 主会话（例如订阅 GPT-6）指挥完整 DeepSeek Harness，默认使用你本地已配置的 **DeepSeek 标准供应商 / deepseek-flash**。

```text
Codex GPT-6 → 插件 MCP 工具 → 本地后台控制服务 → acpx/runtime → DSH ACP → DeepSeek 标准供应商
```

DSH 自己管理上下文、模型调用、文件和 PowerShell 工具、执行循环与压缩。插件管理任务、续接、排队、进度和生命周期。GPT-6 的订阅登录留在 Codex，DSH 继续使用自己的供应商凭据。

## 使用

安装后，新建一个 Codex 会话，选择 GPT-6，输入：

> 使用 DSH Commander，让 DeepSeek 标准供应商的 V4.1 Flash 在当前项目完成以下任务：……。由你检查结果，必要时让它在原会话返工，最后验收。

也可以说“查看 DSH 任务进度”“继续上一个 DSH 任务”“取消这个 DSH 任务”。插件技能会选择对应工具。任务默认使用主 Codex 会话当前工作目录，Codex MCP roots 会自动传给插件；因此不需要另行指定目录。任务会修改这个目录，应明确任务范围。

插件会拒绝把新任务提交到与主 Codex 根目录不同的目录。只有独立 MCP 客户端没有 roots 时，才使用显式绝对路径或 `DSH_COMMANDER_WORKDIR` 作为兼容回退。

## 安装与环境

本机通过个人插件市场安装：

```powershell
codex plugin add dsh-commander@personal
```

MCP 服务和控制服务已打包在 `dist/`，运行不需要 `npm install`。需要本机 Node.js 22.19+，以及已构建、能运行 ACP 的 DSH。本机默认 DSH 路径为 `E:/dsh/deepseek-harness`。插件在启动时调用公开 CLI `apps/cli/lib/bin.js --profile acp --patch ...`，使用默认 base + ACP 组合，不加载 Web UI 插件或 Web 专属 persona。

安装 ZIP 到另一台机器时，将插件根目录放入个人市场对应的 `~/plugins/dsh-commander`，使用 Codex 的 plugin-creator 将该目录登记到个人市场，再安装。ZIP 不包含 DSH 本体或任何凭据。

插件源码：`~/plugins/dsh-commander`。Codex 使用安装缓存副本，编辑源文件后需要构建并使用 plugin-creator 的 cachebuster/reinstall 流程更新。

## 本地配置

按需创建 `~/.dsh-commander/config.json`，覆盖这些默认值：

```json
{
  "dshRoot": "E:/dsh/deepseek-harness",
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "reasoningEffort": "high",
  "maxConcurrent": 3,
  "turnTimeoutMs": 1800000,
  "startupTimeoutMs": 90000
}
```

`dshHome` 默认沿用 `DSH_HOME` 或 `~/.dsh`。`DSH_COMMANDER_HOME` 可以更换插件状态目录；`DSH_COMMANDER_CONFIG` 可以指定配置文件。变更配置后重启控制服务，再开始任务。已有任务保留创建时的供应商、模型和推理强度。

DeepSeek 标准供应商的凭据引用为 `DEEPSEEK_API_KEY`，由 DSH 的凭据服务读取。插件不复制、打印或要求在聊天中提供密钥。全局 DSH 默认模型不被修改；每一轮通过 ACP 确认指定路由后才提交提示词。不会在失败时更换供应商或模型。

## 工具

| 工具 | 功能 |
|---|---|
| `dsh_doctor` | 检查配置和控制服务，不发送模型请求 |
| `dsh_start_task` | 新建持久任务并立即返回 ID |
| `dsh_get_task` | 增量进度、结果、等待授权；最长等待 55 秒 |
| `dsh_continue_task` | 同一会话多轮指挥；忙时顺序排队 |
| `dsh_list_tasks` | 找回当前或历史任务 |
| `dsh_cancel_task` | 取消当前轮与排队指令 |
| `dsh_close_task` | 释放 Harness 进程，保留历史 |
| `dsh_respond_permission` | 一次性回应 DSH 的授权请求 |

每次提交使用独立 `requestId`；网络或工具超时重试相同操作时复用 ID，参数不同会报错，防止重复写文件。

## 状态与恢复

`queued → starting → running → completed / failed / cancelled`。需要回应权限时为 `waiting_permission`；控制服务异常重启时，未完成任务变为 `interrupted`，不会自动重放。先检查文件和结果，再明确继续。

MCP 连接关闭后任务继续运行；后台控制服务独立持有 DSH 进程。关闭任务后仍能恢复同一原生 ACP 会话。DSH 的标准 `session/resume` 不回放旧 transcript，但模型会恢复持久上下文；插件保留自己的历史结果和进度。

同一物理目录中的任务串行执行，不同目录最多同时执行 `maxConcurrent` 个。并行开发可由主代理先准备独立 Git worktree；插件不自动创建分支、提交或合并。任务完成后使用 `dsh_close_task` 释放空闲的 Harness 进程。

关闭、取消、失败都不会回滚已经写入的文件。DSH 使用本地已有的权限设置；主代理须遵守用户授权与主会话权限，不通过外部 Harness 绕过限制。

## 输出与存储

`~/.dsh-commander/tasks/` 保存任务快照、逐行事件和每轮完整结果。工具返回最近 40 条事件、最多 16000 字符结果，并附上完整文件路径。使用返回的 `cursor` 获取后续变化。插件进度不转发模型隐藏推理；DSH 自己的原生日志仍由 DSH 管理。

`~/.dsh-commander/acpx/` 保存 ACPX 会话记录，`daemon.log` 保存控制服务诊断。插件缓存可更新，任务数据留在独立状态目录。本地 IPC 使用命名管道（Windows）或 Unix socket，并校验本地控制令牌；不监听公开网络端口。

## 开发与验证

```powershell
npm ci --ignore-scripts
npm test
npm run build
npm run doctor
node scripts/e2e.mjs
```

`e2e.mjs` 会真实调用已配置的模型并消耗其额度，在独立验收目录中测试文件编辑、命令执行、同会话返工、断开重连、重启恢复和取消。单元测试使用模拟后端，不调用模型。

本地运维命令（源码目录需安装开发依赖）：

```powershell
node scripts/control.mjs doctor
node scripts/control.mjs list
node scripts/control.mjs shutdown
```

`shutdown` 停止插件自己的控制服务并关闭其持有的 DSH 会话，不停止独立运行的 DSH Web 服务。下次工具调用会自动启动控制服务。

## 复用来源

- 运行时直接依赖 [openclaw/acpx](https://github.com/openclaw/acpx)，版本固定为 0.15.1（MIT）。
- 使用官方 MCP SDK；供应商执行由本地 DSH 提供。
- 调度接口设计参考 [claude-code-codex-subagents](https://github.com/xuio/claude-code-codex-subagents) 和 [codex-plugin-cc](https://github.com/openai/codex-plugin-cc)，没有复制这两个项目的源代码。
- 打包依赖与许可证见 `dist/dependencies.json`、`dist/THIRD_PARTY_LICENSES.txt`。
