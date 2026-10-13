import { RunState } from "@openai/agents";

import { createRuntime } from "@/lib/agent";
import { attachStandardMonitoring } from "@/lib/monitoring-hooks";
import { restorePendingApproval, type PendingApprovalRun } from "@/lib/pending-approvals";
import { getAgentRunByApprovalId, updateAgentRun } from "@/lib/run-store";
import { startTrace } from "@/lib/trace-store";

export async function restorePendingRun(approvalId: string): Promise<PendingApprovalRun | undefined> {
  const stored = getAgentRunByApprovalId(approvalId);
  if (!stored || stored.status !== "awaiting_approval" || !stored.state) return undefined;
  const trace = startTrace({
    sessionId: stored.sessionId,
    provider: stored.config.provider,
    model: stored.config.model,
    subagentModel: stored.config.subagentModel,
    input: `恢复等待审批的 Run：${stored.input}`,
  });
  const runtime = await createRuntime({ ...stored.config, apiKey: "" }, {
    sessionId: stored.sessionId,
    onSessionApprovalUsed: (grant) => trace.approvalGrantUsed(grant),
    onCompaction: (event) => trace.recordCompaction(event),
  });
  try {
    const state = await RunState.fromString(runtime.mainAgent, stored.state);
    state.clearTrace();
    const interruptions = state.getInterruptions();
    if (interruptions.length === 0) throw new Error("持久化 RunState 中没有待审批工具调用。");
    attachStandardMonitoring(runtime, trace);
    const pending: PendingApprovalRun = {
      id: approvalId,
      sessionId: stored.sessionId,
      runtime,
      state,
      interruptions,
      maxTurns: stored.config.mainMaxTurns,
      trace,
      createdAt: Date.now(),
    };
    restorePendingApproval(pending);
    updateAgentRun(stored.id, { traceId: trace.id });
    return pending;
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
}
