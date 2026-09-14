# verify-dist 挂死与清理缺陷：问题、修复与验证记录

本文档是 `scripts/verify-dist.mjs` 的完整记录：第一轮修掉挂死，第二轮复核又发现并修掉了清理路径的两个缺陷（其中一个比原挂死问题更严重）。所有结论都有本机可复现的命令与原始输出。

## 摘要

| 问题 | 状态 |
| --- | --- |
| ① 失败路径不释放句柄导致进程挂死 | 已修复（第一轮） |
| ② 清理目标算错，会关掉 live 控制器 | 已修复（第二轮） |
| ③ 自己启动的临时控制器从不被关闭，每次运行泄漏一个后台进程 | 已修复（第二轮） |
| ④ 单轮报告产物 `*.report.json` 被当成任务快照读取，导致控制器重启后无法启动 | 已修复（第二轮，复核中发现的独立严重缺陷） |
| ⑤ 错误回包未判别 `content` 就取值 | 已修复 |
| ⑥ 发布 ZIP 是旧包（不含新协议） | 已修复（重新构建并打包） |
| ⑦ 状态目录无回收策略；`.mcp.json` 依赖 PATH 中的 `node`；Windows 命名管道 ACL 未收紧 | 未处理，见"未处理与已知限制" |

当前状态：`npm run verify` → `exit=0`，独立运行 1.6–2.6s 返回，4 项断言全过；`npm test` 40/40 通过。

---

# 第一轮：挂死

## 现象

执行下面这条命令时，工具调用被记录但结果未落盘，harness 报出"outcome is unknown"：

```powershell
$out = & "C:\Program Files\nodejs\node.exe" scripts/verify-dist.mjs 2>&1; $LASTEXITCODE
$out | Select-String -Pattern '"ok"|checks|waitFor|afterResultVersion|"limit"|maximum|doctor|Invalid' | Select-Object -First 30
```

这不是 `verify-dist.mjs` 抛出的业务错误，而是 **进程一直不退出**：命令在 `timeoutMs=180000`（3 分钟）内没有返回，被 harness 强制中断，因此只有"调用已记录、结果未知"这一条信息，没有 exit code，也没有 stdout。

## 根因

当时的 `scripts/verify-dist.mjs`（60 行版本）在失败路径上存在两个缺陷，叠加成挂死。

### 1. 非法入参的返回值被当成成功响应解析

原第 48–49 行：

```js
const started=JSON.parse((await client.callTool({name:'dsh_get_task',arguments:{}},undefined,{timeout:30000})).content[0].text);
assert.match(started,/taskId|Invalid|required/i);
```

MCP 服务端对缺 `taskId` 的调用返回的是**错误结果**，不是 JSON 业务对象。实测原始回包：

```json
{
  "content": [
    { "type": "text",
      "text": "MCP error -32602: Input validation error: Invalid arguments for tool dsh_get_task: [ ... \"code\": \"invalid_type\", \"expected\": \"string\", \"received\": \"undefined\", \"path\": [ \"taskId\" ], \"message\": \"Required\" ...]" }
  ],
  "isError": true
}
```

`content[0].text` 以 `MCP error ` 开头，`JSON.parse` 必然抛错。复现两次，错误稳定为：

```
SyntaxError: Unexpected token 'M', "MCP error "... is not valid JSON
    at JSON.parse (<anonymous>)
    at scripts/verify-dist.mjs:41:22
```

即：**断言"非法输入必须被拒绝"的那一步，自己先以解析异常失败**，`evidence.checks` 只留下 3 条（缺少 `invalid dsh_get_task input is rejected without side effects`）。

> 备注：同结构的另一次复现中该步报的是 `Cannot read properties of undefined (reading '0')`（即 `.content` 为空）。两种消息指向同一处缺陷——对错误回包无保护地取 `content[0].text`。

### 2. 失败路径不关闭任何句柄，Node 事件循环永不排空

异常在 `await client.close()`（原第 51 行）**之前**抛出，直接跳到 `catch`，因此：

- `client.close()` 从不执行 → MCP stdio 管道保持打开；
- `client` 启动的 `dist/server.mjs` 进程、以及它经 `ensureDaemon`（`src/ipc.mjs:35-38`）拉起的 `dist/daemon.mjs` 都存活；
- 原 `finally`（第 58–60 行）只做 `fs.rmSync(scratch,{recursive:true,force:true})`，**既没有停 controller，也没有关 client**，而且在 daemon 仍运行时删掉了它的 state 目录。

实测 `rmSync` 之后的活跃句柄：

```
handles=["SimpleWriteWrap","PipeWrap","PipeWrap","PipeWrap","PipeWrap","PipeWrap","ProcessWrap","Timeout"]
```

`PipeWrap×5 + ProcessWrap` 使进程无法自然退出，于是 `pwsh` 一直等待 → 3 分钟超时被杀。

## 第一轮修复

（下表行号对应第一轮修复后的 84 行版本；第二轮已在该文件上继续改动，见后文。）

| 当时位置 | 改动 | 作用 |
| --- | --- | --- |
| `verify-dist.mjs:21-24` | 显式写入 `config.json` 并设置 `DSH_COMMANDER_CONFIG` | 临时 controller 拥有独立 state dir 与 IPC 管道 |
| `verify-dist.mjs:27` | 新增 `exitSoon()` | `process.exit` 兜底 |
| `verify-dist.mjs:58-63` | 非法入参改为 `try/catch` | 同时接受 `isError` 回包与抛出的 `McpError` |
| `verify-dist.mjs:72-83` | `finally` 中增加 `shutdown` → 轮询 `ping` → `client.close()` → `rmSync` → `exitSoon()` | 补上被跳过的释放动作 |

**这一轮真正让事件循环排空的是 `client.close()`**（下面的复核会给出证据），`exitSoon()` 只是兜底。

## 第一轮验证

```
exit=0 elapsed_ms=2599
{
  "ok": true,
  "checks": [
    "dist/server.mjs starts and completes the MCP handshake",
    "dist schemas expose waitFor, view (compact default) and afterResultVersion",
    "dist controller answers doctor from an isolated state directory",
    "invalid dsh_get_task input is rejected without side effects"
  ]
}
```

把 `exitSoon()` 换成空实现后再跑，仍然自然退出：

```
exit=0 elapsed_ms=2353
EXITSOON-DISABLED: not forcing process.exit
```

---

# 第二轮：复核发现的缺陷与修复

## 复核方法

1. 静态通读 `src/`、`scripts/`、`test/`，逐个核对"清理代码指向的配置是怎么解析出来的"。
2. 造一个真实运行中的**旁观控制器**（独立临时 HOME + `ensureDaemon`），再原封不动跑被测脚本，看它是否存活。
3. 用命名管道存活与否判断"该被关停的那个控制器"是否真的停了。
4. 直接连它自己的管道/端口验证是否留下孤儿进程；清点 `dist/daemon.mjs` 进程数与 `\\.\pipe\dsh-commander-*` 数量。
5. 恢复语义用独立探针复现"原代码会抛错、新代码不会"，探针用完即删。

## 缺陷 A：清理目标算错，关掉的是 live 控制器

原第 75 行：

```js
const isolated=loadConfig({...process.env,...env});
```

而 `src/config.mjs:11`：

```js
export function loadConfig() {                     // ← 不接受任何参数
  const stateDir = path.resolve(process.env.DSH_COMMANDER_HOME || path.join(os.homedir(), '.dsh-commander'));
```

`loadConfig` 没有形参，传入的对象被直接丢弃；脚本里 `DSH_COMMANDER_HOME` 只存在于局部变量 `env`，`process.env` 上是空的。实测：

```
cleanup target stateDir = C:\Users\22712\.dsh-commander            ← 真实用户状态目录
scratch             stateDir = C:\Users\22712\AppData\Local\Temp\dsh-commander-dist-verify-45940
```

`rpc` 用 `pipePath(config)`（`sha256(stateDir)` 派生命名管道）寻址，所以它敲的是**用户 live 控制器**的门。把真实控制器放进去实测：

```
LIVE daemon up: {"version":"0.1.0","pid":28244} pipe: \\.\pipe\dsh-commander-7ad2780a1dfa023e1
verify-dist exit= 0 elapsed= 2.1s
LIVE daemon after run: GONE -> ENOENT                 ← live 控制器被关掉
TEMP controller after run: STILL RUNNING              ← 自己的临时控制器没关
scratch dir still on disk? false
```

两个后果同时发生：

1. **误杀 live 控制器**：`shutdown` → `manager.shutdown()` → 关闭全部任务并退出进程（`src/daemon.mjs:26,40`）；失败还被 `.catch(()=>{})` 静默，用户不会有任何提示。
2. **自己的临时控制器永远关不掉**：shutdown 打错管道后，`ping` 轮询同样 ENOENT → 第一次就 `break`（所以看不到 5 秒等待，脚本"看起来"很快）。随后 `fs.rmSync(scratch)` 删掉了该 daemon 的 state 目录，而 `control.token` 就在里面——令牌被删后 `rpc` 只能生成不匹配的令牌，**这个 daemon 此后永远无法通过控制通道关闭**。

泄漏是每次运行都发生的。统计 `dist/daemon.mjs` 进程与管道：

| 时点 | daemon 进程 | 命名管道 |
| --- | --- | --- |
| 复核操作之前 | 5（18:44–18:56 的历史遗留） | 5 |
| 连跑 5 次脚本后 | 10 | 10 |
| 杀掉新增的 5 个后 | 5 | 5 |

### 修复

```js
}finally{
  // rpc derives both the pipe name and the control token from stateDir, so the
  // target is built directly from this run's scratch directory. Resolving it from
  // the ambient environment instead would stop the *live* controller and leave
  // this run's own temporary controller running forever.
  const isolated={stateDir:scratch};
  const stopped=await rpc(isolated,'shutdown',{},5000).then(()=>true,()=>false);
  let pipeGone=false;
  for(let attempt=0;attempt<50;attempt+=1){
    try{await rpc(isolated,'ping',{},500);}catch{pipeGone=true;break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  await client.close().catch(()=>{});
  // Deleting the state directory destroys the control token, so only do it once
  // the controller living in it is confirmed gone; otherwise the process could
  // never be reached or stopped again.
  try{if(pipeGone)fs.rmSync(scratch,{recursive:true,force:true});}
  catch(error){evidence.scratchRemovalError=error.message;}
  evidence.controller={stopped,pipeGone};
  const report=JSON.stringify(evidence,null,2);
  if(evidence.ok)console.log(report);else console.error(report);
  exitSoon();
}
```

顺序固定为 **停自己的 controller → 等管道消失 → 关 client → 删目录 → 兜底退出**；只有在确认管道已消失时才删目录，否则保留 state 目录让那个进程仍可被管理。`loadConfig` 不再被使用（它还会读取并校验用户的 `~/.dsh-commander/config.json`，若那份配置有非法字段，会在 `finally` 里抛错，把一次 4 项断言全过的运行变成非 0 退出），相关 import 与未使用的 `ensureDaemon` import 一并删除。

## 缺陷 B：报告产物被当成任务快照，控制器重启后再也起不来（本轮最严重）

**这条是在给缺陷 C 写回归测试时被测试自己撞出来的。**

任务目录里混放了三类文件：

- 快照：`<taskId>.json`
- 事件：`<taskId>.events.jsonl`
- 单轮产物：`<taskId>.<turnId>.result.txt` / `.final.txt` / **`.report.json`**（`src/manager.mjs:45`）

原加载器只判断后缀：

```js
for(const name of fs.readdirSync(path.join(config.stateDir,'tasks'))) {
  if(!name.endsWith('.json'))continue;
  const task=JSON.parse(fs.readFileSync(...,'utf8'));
  if(!/^[a-f0-9-]{36}$/.test(task.id))throw new Error('Invalid persisted task id');
```

`.report.json` 也以 `.json` 结尾 → 被当作快照解析；它是报告对象、没有 `id` 字段 → `/^[a-f0-9-]{36}$/.test(undefined)` 为假 → **抛错**。异常冒到 `src/daemon.mjs:38` 的 `catch` → `console.error(e.stack); process.exit(1)`。

也就是说：**只要有一轮产出了合法的结构化报告，下一次控制器启动就会直接退出**，`ensureDaemon` 会在 15 秒后抛 `Controller failed to start`，整个插件不可用，直到有人手工删掉那个文件。触发条件恰好是新协议的核心功能（每轮都要求输出 `<<<DSH_REPORT>>>` 块），属于上线必炸。

独立探针（构造一个含真实快照 + 一个 `*.report.json` 的 tasks 目录，分别跑原逻辑与修复后逻辑）：

```
files: [ '0567a623-...-a981868671cb.json',
         'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.11111111-2222-3333-4444-555555555555.report.json' ]
ORIGINAL loader -> THROWS: Invalid persisted task id
CURRENT  loader -> OK tasks=1 skipped=0
```

（中间版本曾把该产物记为"损坏快照"，`skipped=1`；这属于误报，最终改成按文件名识别，产物被正常忽略而非计为损坏。）

### 修复

```js
for(const name of fs.readdirSync(path.join(config.stateDir,'tasks'))) {
  // Only <taskId>.json is a snapshot. Turn artifacts share this directory and
  // must be ignored by name: <taskId>.<turnId>.report.json would otherwise be
  // read as a task and stop the whole controller.
  if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;
  const file=path.join(config.stateDir,'tasks',name);
  let task;
  try {
    task=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!task||typeof task!=='object')throw new Error('snapshot is not an object');
    if(!/^[a-f0-9-]{36}$/.test(task.id))throw new Error('invalid persisted task id');
    if(!Array.isArray(task.turns))throw new Error('snapshot has no turn list');
  } catch(error) {
    this.skippedTaskFiles.push({file,reason:error.message});
    console.error(`Skipping unreadable task snapshot ${file}: ${error.message}`);
    continue;
  }
  ...
```

两层保护：**按文件名**（`<taskId>.json`）区分快照与产物，**内容校验失败时跳过而不是抛错**。被跳过的文件记录在 `this.skippedTaskFiles`，并通过 `dsh_doctor` 的 `skippedTaskFiles` 字段暴露，损坏文件不再需要用猜的方式排查。

> 现状说明：本机 `~/.dsh-commander/tasks` 里目前没有 `*.report.json`（13 个快照，0 个报告产物），也就是说至今没有任何一轮的产出被成功解析成结构化报告，这个缺陷因此还没有在真实环境里引爆过。

## 缺陷 C：重复轮询时报告 artifact 路径消失

`resultState()` 在 `omitted` 分支返回 `report:null`，而 `artifacts.report` 由 `state.report` 推导，于是带 `afterResultVersion` 的第二次轮询拿到 `artifacts.report:null`，尽管文件就在磁盘上。与 README"compact 只包含状态、结构化报告和 artifact 路径"的表述冲突：正文不该重复回传，路径不该消失。

修复：artifact 路径改由该轮是否真有报告决定（`turn?.report`），`view=events` 分支同时改为指向 `resultTurn`，避免 `latest` 与 `resultTurn` 不同轮时路径错配。

## 缺陷 D：错误回包取值无保护

原第 61 行 `rejected=reply.isError?reply.content[0].text:''`：若 `isError` 为真但 `content` 为空/缺失，这里抛 `TypeError`，被同一个 `catch` 吃掉后 `rejected` 变成 `"Cannot read properties of undefined (reading '0')"`，断言以误导性信息失败——正是本文档第一轮"备注"里那类缺陷。改为：

```js
rejected=(reply.isError&&reply.content?.[0]?.text)||'';
```

## 其他改动

| 位置 | 改动 | 原因 |
| --- | --- | --- |
| `src/manager.mjs:8` | 删除 `fallbackExcerpt` 死导入 | 该符号从未被调用（`report.mjs:137` 也只有定义） |
| `src/manager.mjs:16` | 删除 `STATIC_RESULT_LIMIT` | 定义后未使用，会让人误以为还有一条"静态结果上限"路径 |
| `src/manager.mjs:311` | `dsh_list_tasks` 的目录比较新增 `sameDirectory`：win32 忽略大小写，POSIX 精确比较 | 原实现两侧都 `toLowerCase()`，在大小写敏感的文件系统上会把两个不同目录当成同一个 |
| `scripts/e2e.mjs:84`、`scripts/installed-smoke.mjs:40` | `await client?.close().catch(()=>{})` | 失败路径上 `close()` 自身抛错会把一次干净的失败变成未处理拒绝 |
| `package.json` | 新增 `"verify": "node scripts/verify-dist.mjs"` | 该脚本此前没有入口，也没被文档登记 |
| `README.md` | 开发者验证章节加入 `npm run verify` 并说明其隔离性与"不调用模型"；补充 `installed-smoke.mjs` 的用途 | 与实现一致 |
| `.codex-plugin/plugin.json` | 版本戳 `0.1.0+codex.20260914105925` → `0.1.0+codex.20260914211159` | 原戳是 18:59 生成的旧包时间，之后源码已多次变更 |
| `dsh-commander.zip` | 重新构建 + `python scripts/package.py` 重新打包（32 → 43 项，477 KB → 523 KB） | 见下节 |

### 关于发布包

复核发现旧 ZIP（18:59）早于 `src`/`dist` 的最后修改（19:34–19:40），解包核对：

| 内容 | 旧 ZIP | 当前 |
| --- | --- | --- |
| `dist/server.mjs` | 1 013 768 B | 1 015 705 B |
| `dist/daemon.mjs` | 1 246 649 B | 1 264 701 B |
| `afterResultVersion` 出现次数 | 0 | 有 |
| `<<<DSH_REPORT>>>` 出现次数 | 0 | 有 |
| `src/report.mjs`、`src/contract.mjs`、`scripts/verify-dist.mjs`、`scripts/overhead-eval.mjs`、`references/command-playbook.md` | 缺失 | 存在 |

README 明确告诉使用者"ZIP 已包含 `dist/`，普通使用者直接使用发行 ZIP 即可"，因此旧包会让使用者拿到**新协议之前**的版本。现已 `npm run build`（产物与当前 `src` 一致）并重新打包，新 ZIP 内 `dist/daemon.mjs` 含 `afterResultVersion`（20 次）、`<<<DSH_REPORT>>>`（2 次），`src/report.mjs`/`src/contract.mjs`/`scripts/verify-dist.mjs` 均已包含。

> 注意：新 ZIP 首次包含 `docs/`（该目录在旧包生成时还不存在）。如不希望随包发布内部文档，把 `docs` 加进 `scripts/package.py` 的 `excluded` 集合即可。

## 文档订正

第一轮结论中有三处与事实相反，已随本轮修复作废：

1. 原"临时 controller 拥有独立 state dir 与 IPC 管道，**即使脚本删目录也不会漂移到 live controller**" —— 管道确实独立，但**清理动作**漂移到了 live 配置，恰好相反。
2. 原"修复后该命令是**只读且幂等**的……可安全重复执行" —— 当时会误杀 live 控制器、且每次运行泄漏一个常驻进程，既不只读也不幂等。
3. 原"遗留风险"一节称 `e2e.mjs` / `installed-smoke.mjs`"存在与本次相同的挂死风险" —— **未能复现，机制上也不成立**。决定性句柄是 MCP client 的 stdio 管道，两个脚本的 `finally` 都调用了 `client.close()`：
   - `installed-smoke.mjs`：用坏掉的 `.mcp.json` 强制早期失败，`exit=1 elapsed_ms=1377`，正常退出；
   - `e2e.mjs`：同样在 `finally` 内关闭 client；"去掉进程级兜底、保留存活 daemon"的实验也在 2.35s 内自然退出。
   这两处真正值得记录的差异是：它们不会关停自己的 daemon（对 live 安装是有意为之），以及 `e2e.mjs:71` 会主动关掉 live 控制器、若在 `ensureDaemon` 前失败则 live 控制器暂时停机（下一次工具调用会自动重建）。

另：原文记录耗时 0.8s，本机复测为 1.6–2.6s（含 Node 启动与清理）。不影响结论，但不要把这个数字当作状态判据。

---

# 验证

## 全量测试

```
$ npm test
# tests 40
# pass 40
# fail 0
```

新增回归测试：

- `test/manager.test.mjs`：一个不可读快照被跳过而不是拖垮控制器；`*.report.json` 产物按文件名忽略，不计为损坏；其余快照仍正常恢复。
- `test/protocol.test.mjs`：报告正文被 `afterResultVersion` 去重后，`artifacts.report` 路径仍然可见。

## 缺陷 B 的恢复语义（独立探针）

```
ORIGINAL loader -> THROWS: Invalid persisted task id
CURRENT  loader -> OK tasks=1 skipped=0
```

## 端到端复核（打包后的 dist）

探针：① 在含产物 + 损坏快照的 state 目录上启动打包后的控制器；② 另起一个真实控制器，再用原命令跑 `verify-dist.mjs`。

```
1) controller with artifacts+corrupt snapshot: STARTED and STABLE {"pid":44756,"stable":true,"daemonJson":true}
2) foreign controller up, pid 44156
   verify-dist exit=0 elapsed=1.6s checks=4 controller={"stopped":true,"pipeGone":true}
3) foreign controller AFTER run: ALIVE pid=44156 (unchanged)
4) temporary controller: stopped -> ENOENT
5) scratch dir removed: true
```

对照第一轮修复后的实测（同一条命令）：live 控制器 `GONE -> ENOENT`、临时控制器 `STILL RUNNING`。修复前后行为完全反转，且本次复核结束后 `dist/daemon.mjs` 进程数与命名管道数**没有增加**（仍为复核前的 5 个历史遗留）。

## 幂等性

多次运行 `verify-dist.mjs` 后 `\\.\pipe\dsh-commander-*` 数量保持基线不变；scratch 目录每次都被删除，除临时目录外不写任何位置。

---

# 未处理与已知限制

1. **状态目录没有回收策略**（未改）。任务可保留 200 轮 × 每轮 `*.result.txt` / `*.final.txt` / `*.report.json`，`*.events.jsonl` 无上限，也没有过期清理入口。本机目前 53 个文件 / 879 KB。自动删除用户产物属于破坏性操作，需要先定下保留期与触发时机（例如 `dsh_close_task` 的可选保留期或文档化的手动清理），因此本轮只记录不改动。手动清理建议：确认任务已 `closed` 后删除对应 `<taskId>.*` 与 `<taskId>.json`。
2. **`.mcp.json` 依赖 PATH 中的 `node`**（未改）。相对 cwd `"."` 与裸命令 `node` 的解析由客户端决定；`package.json` 的 `engines.node>=22.19.0` 只对 npm 生效，对 MCP 启动无效。`installed-smoke.mjs` 用 `path.resolve(root,mcp.cwd)` 兜了一层，真实客户端是否如此无法由本仓保证。
3. **Windows 命名管道的 ACL 未收紧**（未改）。`src/daemon.mjs:37` 的 `chmodSync(pipePath,0o600)` 在 Windows 上被跳过，访问控制实际依赖 `control.token`（同样受 Windows ACL 而非 mode 控制）。防护假设是"同机其他用户不构成威胁"，如需加强需显式设置管道安全描述符。
4. 复核期间未运行 `e2e.mjs` / `installed-smoke.mjs` 的成功路径（会真实调用模型、消耗额度），因此它们的端到端行为只做了失败路径与句柄层面的验证。
