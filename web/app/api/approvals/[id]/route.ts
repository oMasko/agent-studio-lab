import { NextResponse } from "next/server";
import { z } from "zod";

import { guardrailsRun, usedHostedToolNames, usedSubagent, usedToolNames, withSdkTraceContext } from "@/lib/agent";
import { guardrailErrorInfo } from "@/lib/guardrail-errors";
import { approvalResponse, registerPendingApproval, takePendingApproval } from "@/lib/pending-approvals";
import { restorePendingRun } from "@/lib/restore-pending-run";
import { getAgentRunByApprovalId, updateAgentRun } from "@/lib/run-store";
import { grantSessionApproval, parseApprovalArguments, type SessionApprovalGrant } from "@/lib/session-approvals";
import { registerActiveRun, releaseActiveRun } from "@/lib/active-runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decisionPayload = z.object({
  decision: z.enum(["approve_once", "approve_session", "approve", "reject"]),
  reason: z.string().trim().max(500).optional(),
});

const globalState = globalThis as typeof globalThis & {
  __agentStudioApprovalRequests?: Map<string, Promise<NextResponse>>;
};

const maxRememberedApprovalRequests = 200;

function approvalRequests(): Map<string, Promise<NextResponse>> {
  globalState.__agentStudioApprovalRequests ??= new Map();
  return globalState.__agentStudioApprovalRequests;
}

async function processApprovalDecision(request: Request, id: string): Promise<NextResponse> {
  let pending = await takePendingApproval(id);
  if (!pending) {
    await restorePendingRun(id);
    pending = await takePendingApproval(id);
  }
  if (!pending) {
    return NextResponse.json({ error: "审批运行上下文不存在，或持久化 RunState 无法恢复。" }, { status: 410 });
  }
  const storedRun = getAgentRunByApprovalId(id);
  const runController = storedRun ? registerActiveRun(storedRun.id) : undefined;

  try {
    return await withSdkTraceContext(pending.runtime.provider, async () => {
      const payload = decisionPayload.parse(await request.json());
      const decision = payload.decision === "approve" ? "approve_once" : payload.decision;
      const grants: SessionApprovalGrant[] = [];
      pending.trace.resume(decision, payload.reason);
      for (const interruption of pending.interruptions) {
        if (decision === "approve_once" || decision === "approve_session") {
          if (decision === "approve_session") {
            const toolName = interruption.name ?? interruption.toolName ?? "unknown_tool";
            const profile = pending.runtime.toolProfiles[toolName];
            if (!profile) throw new Error(`工具 ${JSON.stringify(toolName)} 缺少安全配置，无法创建会话授权。`);
            grants.push(grantSessionApproval({
              sessionId: pending.sessionId,
              toolName,
              arguments: parseApprovalArguments(interruption.arguments),
              profile,
            }));
          }
          pending.state.approve(interruption);
        } else {
          pending.state.reject(interruption, {
            alwaysReject: true,
            message: payload.reason || "用户拒绝了这次敏感工具调用。",
          });
        }
      }
      if (grants.length > 0) pending.trace.approvalGrantCreated(grants);

      let maxTurnsReached = false;
      const result = await pending.runtime.runner.run(pending.runtime.mainAgent, pending.state, {
        signal: runController?.signal,
        maxTurns: pending.maxTurns,
        errorHandlers: {
          maxTurns: () => {
            maxTurnsReached = true;
            return {
              finalOutput: pending.maxTurns === null
                ? "Agent Run 已停止，但没有生成最终回答。"
                : `本次任务已达到单次 Run 的 ${pending.maxTurns} 次内部循环上限，已安全停止。你可以在模型设置中提高上限或选择“不限制”。`,
              includeInHistory: true,
            };
          },
        },
      });

      if (result.interruptions.length > 0) {
        pending.trace.setUsage(result.runContext.usage);
        const next = await registerPendingApproval({
          sessionId: pending.sessionId,
          runtime: pending.runtime,
          state: result.state,
          interruptions: result.interruptions,
          maxTurns: pending.maxTurns,
          trace: pending.trace,
        });
        pending.trace.awaitingApproval(result.interruptions.map((item) => ({
          toolName: item.name ?? item.toolName ?? "unknown_tool",
          agentName: item.agent?.name ?? "Agent",
        })));
        await pending.trace.flush();
        const response = { ...approvalResponse(next), traceId: pending.trace.id, metrics: pending.trace.getMetrics(), runId: storedRun?.id };
        if (storedRun) updateAgentRun(storedRun.id, { status: "awaiting_approval", approvalId: next.id, state: result.state.toString(), result: response, traceId: pending.trace.id });
        return NextResponse.json(response);
      }

      const tools = usedToolNames(result);
      for (const toolName of usedHostedToolNames(result)) {
        pending.trace.add("hosted_tool", "runner", `托管工具 ${toolName} 调用完成`, undefined, { toolName });
      }
      const delegated = usedSubagent(result);
      const guardrails = guardrailsRun(result);
      pending.trace.setUsage(result.runContext.usage);
      pending.trace.finish("completed", maxTurnsReached ? "Agent Run 在审批后达到循环上限" : "Agent Run 在人工审批后完成", {
        approvalDecision: decision,
        delegated,
        tools,
        guardrails,
        maxTurnsReached,
        maxTurns: pending.maxTurns,
      });
      await pending.trace.flush();
      await pending.runtime.close();
      const response = {
        status: "completed",
        message: typeof result.finalOutput === "string" ? result.finalOutput : String(result.finalOutput ?? ""),
        delegated,
        tools,
        guardrails,
        maxTurnsReached,
        sessionId: pending.sessionId,
        approvalDecision: decision,
        traceId: pending.trace.id,
        metrics: pending.trace.getMetrics(),
        runId: storedRun?.id,
      };
      if (storedRun) updateAgentRun(storedRun.id, { status: "completed", state: result.state.toString(), result: response, traceId: pending.trace.id, completed: true });
      return NextResponse.json(response);
    });
  } catch (error) {
    await pending.runtime.close().catch(() => undefined);
    if (runController?.signal.aborted) {
      const message = typeof runController.signal.reason === "string" ? runController.signal.reason : "用户取消了 Agent Run";
      pending.trace.finish("cancelled", message);
      await pending.trace.flush();
      if (storedRun) updateAgentRun(storedRun.id, { status: "cancelled", error: message, result: { status: "cancelled", message, traceId: pending.trace.id, runId: storedRun.id }, completed: true });
      return NextResponse.json({ status: "cancelled", message, traceId: pending.trace.id, runId: storedRun?.id });
    }
    const guardrail = guardrailErrorInfo(error);
    if (guardrail) {
      pending.trace.add("guardrail_blocked", "safety", guardrail.message, guardrail);
      pending.trace.finish("blocked", "恢复运行后被安全围栏终止", guardrail);
      await pending.trace.flush();
      if (storedRun) updateAgentRun(storedRun.id, { status: "blocked", error: guardrail.message, result: { error: guardrail.message, guardrail, traceId: pending.trace.id, runId: storedRun.id }, completed: true });
      return NextResponse.json({ error: guardrail.message, guardrail, traceId: pending.trace.id }, { status: 422 });
    }
    pending.trace.finish("failed", "审批恢复运行失败", { message: error instanceof Error ? error.message : String(error) });
    await pending.trace.flush();
    if (storedRun) updateAgentRun(storedRun.id, { status: "failed", error: error instanceof Error ? error.message : String(error), completed: true });
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "审批参数无效。", traceId: pending.trace.id }, { status: 422 });
    }
    console.error("Approval resume failed", error);
    return NextResponse.json({ error: "恢复 Agent 运行失败，请查看服务端日志。", traceId: pending.trace.id }, { status: 502 });
  } finally {
    if (storedRun && runController) releaseActiveRun(storedRun.id, runController);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const requests = approvalRequests();
  const existing = requests.get(id);
  if (existing) return (await existing).clone();

  // The first decision wins. Duplicate clicks and browser retries await the
  // same continuation instead of consuming the one-shot RunState twice.
  const processing = processApprovalDecision(request, id);
  requests.set(id, processing);
  while (requests.size > maxRememberedApprovalRequests) {
    const oldest = requests.keys().next().value as string | undefined;
    if (!oldest) break;
    requests.delete(oldest);
  }

  try {
    return (await processing).clone();
  } catch (error) {
    requests.delete(id);
    throw error;
  }
}
