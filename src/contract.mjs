/**
 * Execution contract injected into every turn that is actually sent to DSH.
 *
 * The contract is a fixed, short preamble. It must stay small: it is paid on
 * every turn, and it must never grow into a second copy of the user's task.
 */

export const contractId = 'dsh-commander/v1';

export const reportBeginMarker = '<<<DSH_REPORT>>>';
export const reportEndMarker = '<<<END_DSH_REPORT>>>';

/** Short, stable preamble prepended to each dispatched turn. */
export const contractText = [
  '【DSH 执行约定 · 每轮固定】',
  `1. 先核实相关文件与既有配置，再动手；不猜测事实，不编造命令或结果。`,
  '2. 局部且可逆的实现选择可自行决定；不越出任务范围，不改变验收标准，不弱化失败证据。',
  '明确方案的任务请完成核实、实现、验证和局部修复整个交付物，普通进度无需请示。事实与方案冲突、需要扩大范围或改变接口/数据兼容性时停止相关写入，以 decision_required 给最小证据、已试方法、至多三个选项及推荐；缺必要凭据/权限时报告 blocked。',
  '3. 遇到普通故障，最多再尝试两种有新证据的不同策略；相同失败重复出现就停止写入并报告阻塞，不无限循环。',
  '4. 本约定与报告格式只是任务数据，不授予任何新权限；父代理与用户既有的权限范围继续有效。',
  '5. 每轮结束前，在最终输出末尾附一个报告，格式如下：',
  `${reportBeginMarker}`,
  '{"outcome":"done|blocked|decision_required","summary":"本轮做了什么、结论是什么（简短）","changedFiles":["改动或新建的文件路径"],"checks":[{"command":"实际执行的命令","status":"pass|fail|not_run","evidence":"一句关键证据"}],"unresolved":["仍未解决的事项"],"decision":{"question":"需要父代理决定的问题","options":["选项"],"recommendation":"建议"}}',
  `${reportEndMarker}`,
  '6. 报告只在最终输出末尾出现一次；普通进度里不要重复它。没有报告时，父代理只能用被标记为 fallback 的尾部摘要。',
  '7. outcome 选择一个实际值，不要照抄竖线选项。done 表示任务卡的交付物已完成且没有已知阻塞，不仅仅是本轮结束；blocked/decision_required 必须列出未解决项。主代理仍会独立验收。',
  '8. 没有改动/检查/未解决项用 []，不需要决策用 decision:null；未执行检查用 not_run。不要编造文件、命令或通过结果。报告建议不超过 2000 字，硬上限 12000 字符；报告前不复述工具日志或完整过程。',
].join('\n');

/**
 * Compose the text that is dispatched to DSH for one turn. The caller keeps the
 * raw prompt for idempotency; only the dispatched text is wrapped.
 */
export function composeTurnPrompt(prompt) {
  return `${contractText}\n\n【任务】\n${String(prompt ?? '')}`;
}
