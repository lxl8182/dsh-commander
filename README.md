# DSH Commander

<p align="center"><img src="assets/commander.jpg" alt="DSH Commander：快给我干活！" width="480" /></p>

让 Codex 主会话（例如 GPT-6）指挥一个完整的 DeepSeek Harness（DSH）子代理。DSH 保留自己的上下文、工具、执行循环和持久会话；Codex 负责拆解任务、查看结果、继续返工和最终验收。

```text
Codex 主会话 → DSH Commander MCP → DSH Web / ACP → 所选供应商与模型（默认 DeepSeek 官方）
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
2. 选择后端并完成对应准备：
   - **Web（需要界面同步时推荐）**：启动现有 DSH Web 服务，配置下方的 `dshBackend` 和 `dshWebUrl`。Commander 在同一 Web 进程中创建工作区会话，界面直接接收实时输出。
   - **npm**：无需源码 checkout，首次启动时由 `npx` 解析 `@deepseek-ai/dsh` 包。
   - **source**：安装 pnpm，准备一个已构建并支持 ACP 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) checkout；先在仓库根目录运行 `pnpm install`、`pnpm run build`，该目录必须包含 `apps/cli/lib/bin.js`。
3. 在 DSH 中启用所需供应商并准备其凭据。默认路由为 `deepseek-official / deepseek-flash`，默认凭据引用为 `DEEPSEEK_API_KEY`；使用 littleapi 等自定义供应商时，先在 DSH 中配置该供应商和实际模型 ID。
4. 在 Codex 中打开要处理的项目，并确认插件已安装且启用。

插件不会把 DeepSeek 密钥写入配置、发送到 Codex，或要求用户在聊天中粘贴密钥；凭据由 DSH 在请求时读取。Codex 的订阅登录和 DeepSeek 的供应商凭据是两套独立配置。

## 配置

### 在 DSH 界面中按工作区显示并实时输出

在 `~/.dsh-commander/config.json` 中配置运行中的本机 Web 服务：

```json
{
  "dshBackend": "web",
  "dshWebUrl": "http://127.0.0.1:3080",
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "reasoningEffort": "high"
}
```

端口以实际 DSH Web 服务为准。`dshHome` 可选，默认 `~/.dsh`，必须与 Web 服务使用的 DSH home 一致。仅接受本机回环 HTTP(S) 地址；本地 owner 会话凭据用于认证，不写入插件配置或日志。Web 服务须先启动，Commander 不负责启动或关闭它。显式选择 Web 后连接失败会报告错误，不会自动切回 ACP。

新任务通过 `workspace/create` 注册当前目录，再由 `session/create(workspaceId)` 建立会话。续接保留原会话 ID，并恢复工作区归属。Web UI 接收逐字流式输出；给 Codex 的回报仍使用精简状态和按版本返回的交付报告。`close` 仅释放 Commander 的订阅，保留会话历史。

取消优先移除属于该请求的排队消息，已开始的请求等待自己的 `turn/end`。连接中断或取消超时会明确报告；确认状态前不要重派可能已经执行的写操作。Web 使用现有的 DSH 权限配置，额外审批转发给 Commander，取消审批会同步撤销父会话中的等待。

### 使用独立 ACP 后端

未配置 Web 时使用 ACP。用户配置文件为 `~/.dsh-commander/config.json`（Windows 下对应 `%USERPROFILE%\.dsh-commander\config.json`）。公共配置项如下：

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
| `provider` / `model` | Web 与 ACP 新任务的默认路由，默认 `deepseek-official` / `deepseek-flash`；创建任务时可成对覆盖。 |
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

全局配置在 Commander 控制服务启动时读取。改完配置后，需要在现有任务结束后重启 Commander 控制服务；仅新开 Codex 任务不保证长驻控制服务重新加载配置。安装新增工具的版本后，还需新开 Codex 任务以加载工具定义。`dsh_doctor` 可以在不发送模型请求的情况下检查启动方式、DSH 路径（source 模式）、路由和凭据引用。

### 为子代理选择供应商与模型

默认配置保持 `deepseek-official / deepseek-flash`。可以在创建任务时选择另一组路由，不需要修改全局默认，也不改变 Codex 主会话模型。

1. 调用 `dsh_list_routes` 查看 DSH 配置中的供应商和模型 ID。返回值只包含路由元数据，不包含密钥或 API 地址；候选列表不代表远端模型已验证可用。
2. 创建任务时同时传入 `provider` 与 `model`。两项都省略时使用全局默认；只传一项会报错，避免错误搭配。
3. 后端在每轮执行前确认所选路由，无法使用时明确失败，不静默换到官方供应商。续接、关闭后恢复都保留任务创建时的路由；要换供应商或模型，请新建任务。

例如可以直接说：

> 使用 DSH Commander，先列出 littleapi 的模型；使用我选定的模型完成当前任务，默认配置继续保留官方。

底层 `dsh_start_task` 参数示例（模型 ID 必须替换为 DSH 中实际配置的值）：

```json
{
  "cwd": "C:/path/to/project",
  "title": "实现指定功能",
  "prompt": "按已确认范围实现功能。",
  "requestId": "feature-littleapi-001",
  "provider": "littleapi",
  "model": "<DSH 中实际配置的模型 ID>"
}
```

如果希望以后新任务都默认使用 littleapi，在 `~/.dsh-commander/config.json` 中同时修改 `provider` 和 `model`；其余后端配置保留原值。凭据仍由 DSH 管理，不填写到 Commander 配置或任务参数里。

`dsh_doctor` 也接受成对的 `provider` / `model`，用于只读检查指定路由的本地配置，不调用模型，不证明凭据或远端服务有效。自定义模型还需支持任务使用的推理强度；Commander 不猜测能力或自动回退。

## 开始一个任务

在已启用插件的 Codex 会话中直接描述任务，例如：

> 使用 DSH Commander，让 DeepSeek 标准供应商的 V4.1 Flash 在当前项目完成以下任务：实现登录接口、补充测试并运行验证。由你检查改动，必要时让它在原会话返工，最后验收。

也可以使用自然语言请求：

- “查看 DSH 任务进度。”
- “让上一个 DSH 任务继续修复失败的测试。”
- “取消这个 DSH 任务。”
- “关闭已经完成的 DSH 会话。”

首次派发时，Codex 把当前任务环境中已确认的绝对工作目录作为 `cwd` 传入，不需要用户手填。部分 Codex 客户端未提供 MCP roots，显式路径可避免首次调用失败。有 roots 时，插件校验 `cwd` 属于其中一个根并选中该根；省略 `cwd` 时使用首个根。没有可用 roots 时，显式路径优先于 `DSH_COMMANDER_WORKDIR` 等环境变量和启动目录；无效的显式路径会报错，不静默切换项目，也不把插件安装目录当作默认工作区。

DSH 自行加载自己的 agent 指令与环境配置。任务卡只传目标、必要事实、修改范围、用户授权与验收，不重复注入 Codex 的 RTK、Shell 或网络代理习惯。

## 提供的工具

| 工具 | 用途 |
| --- | --- |
| `dsh_doctor` | 检查 DSH 路径、路由和控制服务，不调用模型；并报告控制服务跳过了多少个不可读的任务快照。 |
| `dsh_list_routes` | 列出 DSH 本地配置的供应商与模型候选，供创建任务时选择；不调用模型。 |
| `dsh_start_task` | 创建持久 DSH 任务，可成对指定 `provider` / `model`，立即返回 `taskId` 与精简状态。 |
| `dsh_get_task` | 等待可行动状态并读取结构化报告、待处理权限。 |
| `dsh_continue_task` | 在同一 DSH 会话中继续一轮指挥；忙时顺序排队。 |
| `dsh_list_tasks` | 列出当前或历史任务，用于找回 `taskId`。 |
| `dsh_cancel_task` | 取消当前轮和排队指令。 |
| `dsh_close_task` | 释放 Harness 进程并保留会话历史。 |
| `dsh_respond_permission` | 回应 DSH 发出的单次授权请求。 |

每次请求都带有独立 `requestId`。网络或工具超时后重试同一操作时复用原 ID，可避免重复提交文件写入；更改参数后必须使用新的 ID。

### 读取结果的约定

`dsh_get_task` 默认 `waitFor: "actionable"`：只有当前轮结束（成功、失败、取消、中断）、出现待处理权限或 `waitMs` 超时时才返回。普通文字与工具进度仍会写入事件日志，但不会唤醒主代理。需要逐条观察进度时显式使用 `waitFor: "change"`。

返回内容默认 `view: "compact"`：只包含状态、结构化报告和 artifact 路径，不回传运行中的累计正文、完整事件或全部历史轮次。需要诊断时使用 `view: "events"`，它按 `cursor` 顺序返回一页事件（`limit` 默认 50），并给出下一页使用的 `cursor`、`latestCursor`、`hasMore`、`eventsTruncated` 和 `eventsDroppedBefore`；超出内存保留窗口的事件仍完整保存在 `tasks/<id>.events.jsonl`。

每一轮结束都会得到 `resultVersion`（标识实际结束的那一轮）。把它转换为字符串 `String(resultVersion)` 作为 `afterResultVersion` 传回下一次调用时，相同版本的结果不会重复回传；其他客户端不传该参数，仍能首次取到结果——去重由调用方驱动，不使用全局已读标志。后续排队轮次不会掩盖已结束轮次的结果。

结果文本优先来自结构化报告；若报告缺失或畸形，则返回带 `resultFallback: true` 和 `resultFallbackReason` 的有限尾部摘要，完整原始输出始终保留在 `tasks/<id>.<turn>.result.txt`。

### 结构化报告

插件在真正发给 DSH 的每一轮前注入一段短执行约定，要求 DSH 在最终输出末尾给出：

```text
<<<DSH_REPORT>>>
{"outcome":"done|blocked|decision_required","summary":"...","changedFiles":["..."],"checks":[{"command":"...","status":"pass|fail|not_run","evidence":"..."}],"unresolved":["..."],"decision":{"question":"...","options":["..."],"recommendation":"..."}}
<<<END_DSH_REPORT>>>
```

只有完整、字段类型正确的单个报告块才会被接受；畸形、截断、重复或缺失都会走 fallback，不会被当作成功。`outcome: done` 表示 DS 自报交付物已完成，但不表示主代理验收通过，主代理仍需核对实际改动。提示词和报告都是任务数据，不会授予新的权限。

`scripts/overhead-eval.mjs` 用合成流量对比新旧回包的字符数与唤醒次数，结果写入 `docs/overhead-eval.json`。该指标只证明协议开销下降，不等于真实订阅额度节省。

## 任务和权限行为

- 任务状态依次可能为 `queued`、`starting`、`running`、`waiting_permission`、`completed`、`failed`、`cancelled` 或 `interrupted`。状态表示的是任务当前所处的阶段；某一轮的结果请以 `resultVersion` 和返回的报告为准。
- 权限属于控制状态，不会被精简回包或事件分页掩盖：`waiting_permission` 会立即结束 actionable 等待，并随快照返回完整权限请求。
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
node scripts/overhead-eval.mjs
npm run build
npm run doctor
npm run verify
python scripts/package.py
```

`npm test` 使用模拟后端，不调用模型，覆盖 actionable 等待、结果版本去重、事件分页、报告解析、快照恢复和既有生命周期行为。`node scripts/overhead-eval.mjs` 只生成合成协议开销证据，不消耗模型额度。`npm run verify` 校验已构建的 `dist/`：它用临时状态目录启动打包后的服务与控制服务，断言工具 schema 并读取 `doctor`，全程不调用模型，也不会读取或影响正在运行的控制服务——它只关停自己在临时目录里启动的那个进程。需要端到端验证时再运行 `node scripts/e2e.mjs`；它会使用配置的 DSH 路由并消耗模型额度，`node scripts/installed-smoke.mjs` 则对安装副本做同样的真实调用验收。发布前请确认 ZIP 不含 `node_modules`、凭据或任务数据，并通过 Codex 插件校验器。

## 许可证和致谢

项目代码采用 [MIT License](LICENSE)。运行时使用 [openclaw/acpx](https://github.com/openclaw/acpx)（0.15.1）和官方 MCP SDK；依赖许可证见 `dist/THIRD_PARTY_LICENSES.txt`。

Codex 插件的 marketplace 格式和 GitHub 导入流程参见 [OpenAI 插件管理文档](https://learn.chatgpt.com/docs/enterprise/plugin-management)；插件安装与工作区权限受 Codex 账户和工作区策略控制。

报告 JSON 硬上限为 12000 字符；超限明确回退。有效报告不附带前面的进度正文，fallback 尾部最多 2000 字符，完整输出和报告产物路径保持可读。旧版任务快照在恢复时补齐轮次与结果版本，未完成执行轮的已有输出以 interrupted 证据保留。
