# DSH Commander

让 Codex 主会话（例如 GPT-6）指挥一个完整的 DeepSeek Harness（DSH）子代理。DSH 保留自己的上下文、工具、执行循环和持久会话；Codex 负责拆解任务、查看结果、继续返工和最终验收。

```text
Codex 主会话 → DSH Commander MCP → ACP → DeepSeek Harness → DeepSeek 标准供应商
```

插件会把 DSH 子代理放在当前 Codex 会话的工作目录中。子代理可以读写项目文件、执行命令并跨多轮继续工作，主会话可以随时查询进度或要求返工。

仓库：[github.com/lxl8182/dsh-commander](https://github.com/lxl8182/dsh-commander) · [发行版](https://github.com/lxl8182/dsh-commander/releases)

## 安装

DSH Commander 是包含 MCP 服务和技能的 Codex 插件。它声明了本地进程，因此需要 Codex CLI 或 Codex 桌面端的本地执行能力；仅能运行远程网页会话的环境无法启动 DSH 进程。

### 从 GitHub marketplace 安装（推荐）

仓库已经包含 `.agents/plugins/marketplace.json`。有仓库读取权限的用户可以把它作为 Codex marketplace 添加，然后安装插件：

```powershell
codex plugin marketplace add lxl8182/dsh-commander
codex plugin add dsh-commander@dsh-commander-marketplace
```

检查安装状态：

```powershell
codex plugin list
```

在支持工作区插件的 Codex 桌面端，也可以打开 **Workspace settings → Plugins → Add → Import marketplace**，将 `https://github.com/lxl8182/dsh-commander` 填入 **Source**，Path 留空；导入后安装 **DSH Commander**。私有仓库需要先授权可读取该仓库的 GitHub 账户。

### 从发行 ZIP 安装

从[发行页面](https://github.com/lxl8182/dsh-commander/releases)下载 `dsh-commander.zip`，解压后把解压目录作为本地 marketplace：

```powershell
$pluginDir = "<解压目录>\dsh-commander"
codex plugin marketplace add $pluginDir
codex plugin add dsh-commander@dsh-commander-marketplace
```

ZIP 已包含 `dist/`、技能、配置模板和 marketplace 清单，不包含 DSH 本体、`node_modules` 或任何凭据。升级 GitHub marketplace 时运行：

```powershell
codex plugin marketplace upgrade dsh-commander-marketplace
```

### 从源码安装

```powershell
git clone https://github.com/lxl8182/dsh-commander.git
Set-Location .\dsh-commander
codex plugin marketplace add (Get-Location).Path
codex plugin add dsh-commander@dsh-commander-marketplace
```

源码安装适合需要审阅或修改插件的用户；普通使用者直接使用 marketplace 或发行 ZIP 即可。

## 使用前准备

1. 安装 [Node.js](https://nodejs.org/) 22.19 或更高版本。
2. 选择一种 DSH 启动方式并完成对应准备：
   - **npm**：无需源码 checkout，首次启动时由 `npx` 解析 `@deepseek-ai/dsh` 包。
   - **source**：安装 pnpm，准备一个已构建并支持 ACP 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) checkout；先在仓库根目录运行 `pnpm install`、`pnpm run build`，该目录必须包含 `apps/cli/lib/bin.js`。
3. 在 DSH 中启用 DeepSeek 标准供应商，并准备它所需的凭据。默认路由为 `deepseek-official / deepseek-flash`，凭据引用为 `DEEPSEEK_API_KEY`。
4. 在 Codex 中打开要处理的项目，并确认插件已安装且启用。

插件不会把 DeepSeek 密钥写入配置、发送到 Codex，或要求用户在聊天中粘贴密钥；凭据由 DSH 在请求时读取。Codex 的订阅登录和 DeepSeek 的供应商凭据是两套独立配置。

## 配置

首次使用前创建用户配置文件 `~/.dsh-commander/config.json`（Windows 下对应 `%USERPROFILE%\.dsh-commander\config.json`）。公共配置项如下：

```json
{
  "dshLaunchMode": "npm",
  "dshPackage": "@deepseek-ai/dsh@latest",
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "reasoningEffort": "high",
  "maxConcurrent": 3,
  "turnTimeoutMs": 1800000,
  "startupTimeoutMs": 90000
}
```

使用源码启动时改为：

```json
{
  "dshLaunchMode": "source",
  "dshRoot": "C:/path/to/deepseek-harness",
  "provider": "deepseek-official",
  "model": "deepseek-flash"
}
```

`dshLaunchMode` 只能是 `npm` 或 `source`。npm 模式使用与 `npx @deepseek-ai/dsh web` 相同的 npm CLI，默认包规格为 `@deepseek-ai/dsh@latest`；插件会把 profile 设为 `acp`，以便通过 stdio 与 Codex 通信。源码模式使用与在 DSH 根目录执行 `pnpm dsh web` 相同的源码 CLI，插件实际调用 `pnpm --dir <dshRoot> dsh --profile acp`。两种模式都不会启动 Web UI 端口。

打包模板默认使用 npm 模式，因此普通安装不需要填写 DSH 根目录；需要从 checkout 运行时，把 `dshLaunchMode` 改为 `source` 并填写 `dshRoot`。npm 模式会忽略 `dshRoot`。

| 配置项 | 说明 |
| --- | --- |
| `dshLaunchMode` | DSH 启动方式：`npm` 或 `source`。 |
| `dshPackage` | npm 模式的包规格，默认 `@deepseek-ai/dsh@latest`，可改为固定版本或 `next` 标签。 |
| `dshRoot` | source 模式的 DSH 根目录，必须是绝对路径并能找到 `apps/cli/lib/bin.js`。npm 模式不需要。 |
| `provider` / `model` | DSH ACP 使用的路由，默认 `deepseek-official` / `deepseek-flash`。 |
| `reasoningEffort` | 传给 DSH 的推理强度。 |
| `maxConcurrent` | 不同工作目录最多同时运行的任务数，范围 1–16。 |
| `turnTimeoutMs` | 单轮任务超时，默认 30 分钟。 |
| `startupTimeoutMs` | 启动 DSH 进程的超时，默认 90 秒。 |

可用环境变量：

| 环境变量 | 用途 |
| --- | --- |
| `DSH_COMMANDER_CONFIG` | 指定配置文件路径。 |
| `DSH_COMMANDER_HOME` | 指定插件状态目录。 |
| `DSH_HOME` | 指定 DSH 的状态和凭据目录。 |
| `DSH_COMMANDER_WORKDIR` | 没有 MCP roots 时指定兼容工作目录。 |

改完配置后重新打开 Codex 任务，或重启插件控制服务。`dsh_doctor` 可以在不发送模型请求的情况下检查启动方式、DSH 路径（source 模式）、路由和凭据引用。

## 开始一个任务

在已启用插件的 Codex 会话中直接描述任务，例如：

> 使用 DSH Commander，让 DeepSeek 标准供应商的 V4.1 Flash 在当前项目完成以下任务：实现登录接口、补充测试并运行验证。由你检查改动，必要时让它在原会话返工，最后验收。

也可以使用自然语言请求：

- “查看 DSH 任务进度。”
- “让上一个 DSH 任务继续修复失败的测试。”
- “取消这个 DSH 任务。”
- “关闭已经完成的 DSH 会话。”

Codex 支持 MCP roots 时，插件自动读取当前会话的项目根目录，并将同一个目录传给 DSH 子代理。通常不需要填写 `cwd`；插件也会拒绝把任务提交到主会话根目录之外的路径。独立 MCP 客户端没有 roots 时，才使用 `DSH_COMMANDER_WORKDIR` 或工具参数中的绝对路径。

## 提供的工具

| 工具 | 用途 |
| --- | --- |
| `dsh_doctor` | 检查 DSH 路径、路由和控制服务，不调用模型。 |
| `dsh_start_task` | 创建持久 DSH 任务并立即返回 `taskId`。 |
| `dsh_get_task` | 读取增量进度、结果和待处理的权限请求。 |
| `dsh_continue_task` | 在同一 DSH 会话中继续一轮指挥；忙时顺序排队。 |
| `dsh_list_tasks` | 列出当前或历史任务，用于找回 `taskId`。 |
| `dsh_cancel_task` | 取消当前轮和排队指令。 |
| `dsh_close_task` | 释放 Harness 进程并保留会话历史。 |
| `dsh_respond_permission` | 回应 DSH 发出的单次授权请求。 |

每次请求都带有独立 `requestId`。网络或工具超时后重试同一操作时复用原 ID，可避免重复提交文件写入；更改参数后必须使用新的 ID。

## 任务和权限行为

- 任务状态依次可能为 `queued`、`starting`、`running`、`waiting_permission`、`completed`、`failed`、`cancelled` 或 `interrupted`。
- MCP 连接关闭后，后台控制服务仍会持有 DSH 进程；控制服务重启后，未完成任务会标为 `interrupted`，不会自动重放写入操作。
- 同一个物理工作目录中的任务会串行执行；不同目录可按 `maxConcurrent` 并行。
- 取消、失败或关闭不会回滚已经写入的文件。并行开发请先由主代理创建独立 Git worktree。
- DSH 的权限策略和 Codex 的用户授权继续生效，插件不会绕过审批或切换到其他供应商。

## 状态目录和清理

默认状态目录为 `~/.dsh-commander/`：

- `tasks/`：任务快照、事件和结果；
- `acpx/`：ACPX 会话记录；
- `daemon.log`：控制服务诊断日志。

本地 IPC 使用命名管道（Windows）或 Unix socket，并校验控制令牌，不监听公开网络端口。完成任务后可以调用 `dsh_close_task` 释放空闲 Harness 进程；任务历史仍然保留。

## 故障排查

1. 先调用 `dsh_doctor`。
2. source 模式若提示找不到 `apps/cli/lib/bin.js`，检查 `dshRoot` 是否指向已构建的 DSH 根目录，而不是它的父目录或 `apps/cli` 子目录。
3. npm 模式若 `npx` 无法解析包，检查 Node.js、npm 网络或缓存，并确认 `dshPackage` 的包名和版本标签正确；如果机器上存在旧的全局 DSH，保留 `@latest` 或填写明确版本可避免误用旧包。
4. 若提示供应商或模型不可用，检查 DSH 标准供应商配置、`deepseek-flash` 模型目录和 `DEEPSEEK_API_KEY` 的凭据来源。
5. 若提示无法确定工作目录，在主 Codex 项目会话中重试；独立 MCP 客户端请设置 `DSH_COMMANDER_WORKDIR`。
6. 任务已经被标记为 `interrupted` 时，先检查工作区和 `dsh_get_task` 的结果，再明确要求 `dsh_continue_task`，不要盲目重复提交写入任务。

## 开发者验证

修改源码后可运行：

```powershell
npm ci --ignore-scripts
npm test
npm run build
npm run doctor
python scripts/package.py
```

`npm test` 使用模拟后端，不调用模型。需要端到端验证时再运行 `node scripts/e2e.mjs`；它会使用配置的 DSH 路由并消耗模型额度。发布前请确认 ZIP 不含 `node_modules`、凭据或任务数据，并通过 Codex 插件校验器。

## 许可证和致谢

项目代码采用 [MIT License](LICENSE)。运行时使用 [openclaw/acpx](https://github.com/openclaw/acpx)（0.15.1）和官方 MCP SDK；依赖许可证见 `dist/THIRD_PARTY_LICENSES.txt`。

Codex 插件的 marketplace 格式和 GitHub 导入流程参见 [OpenAI 插件管理文档](https://learn.chatgpt.com/docs/enterprise/plugin-management)；插件安装与工作区权限受 Codex 账户和工作区策略控制。
