// The curated Agent bank groups broad topics for browsing. These smaller groups
// identify distinct interview skills that already have questions in that bank.
export const agentOutlineDirections = new Map([
  ['Agent 与工作流的选型边界', ['agent-workflow-boundary', 'agent-no-agent-scenarios']],
  ['任务规划与执行策略', ['agent-plan-execute-choice', 'agent-react-code-mapping']],
  ['多 Agent 协作', ['agent-multi-agent-necessity']],
  ['执行循环与预算控制', ['agent-loop-detection', 'agent-step-budget-incident']],
  ['MCP 协议与生命周期', ['mcp-project-value', 'mcp-tool-api-boundary', 'mcp-lifecycle']],
  ['工具路由与选择评测', ['mcp-100-tools-routing', 'mcp-tool-selection-eval']],
  ['工具异常恢复与幂等', ['mcp-param-error-handling', 'mcp-idempotent-retry']],
  ['工具调用权限边界', ['mcp-permission-layer', 'safety-prompt-injection']],
  ['上下文压缩与回滚', ['memory-truncation-strategy', 'memory-compression-failure']],
  ['工具结果分页与回灌', ['memory-large-tool-result']],
  ['混合召回与结果融合', ['rag-hybrid-fusion']],
  ['检索链路故障定位', ['rag-layer-attribution', 'rag-recall-up-accuracy-down']],
  ['文档切分与索引输入', ['rag-format-slicing']],
  ['离线评测集与回归', ['reliability-offline-eval', 'agent-project-evaluation', 'rag-eval-set']],
  ['运行成本、延迟与并发', ['reliability-cost-latency', 'rag-why-not-full-scan']],
])
