import { NextResponse } from "next/server";
import { z } from "zod";

import { AgentConfigError, createRuntime, getSession, guardrailsRun, usedHostedToolNames, usedSubagent, usedToolNames, validateSessionId, withSdkTraceContext } from "@/lib/agent";
import { chatPayload } from "@/lib/chat-schema";
import { guardrailErrorInfo } from "@/lib/guardrail-errors";
import { attachStandardMonitoring } from "@/lib/monitoring-hooks";
import { approvalResponse, hasPendingApproval, registerPendingApproval } from "@/lib/pending-approvals";
import { startTrace, type TraceRecorder } from "@/lib/trace-store";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let trace: TraceRecorder | undefined;
  try {
    const payload = chatPayload.parse(await request.json());
    return await withSdkTraceContext(payload.config.provider, async () => {
      const sessionId = validateSessionId(payload.sessionId);
      if (await hasPendingApproval(sessionId)) {
        return NextResponse.json({ error: "当前会话有待审批的工具调用，请先批准或拒绝后再继续。" }, { status: 409 });
      }
      trace = startTrace({
        sessionId,
        provider: payload.config.provider,
        model: payload.config.model,
        subagentModel: payload.config.subagentModel,
        input: payload.message,
      });
      const runtimeState = await createRuntime(
        { ...payload.config, apiKey: payload.config.apiKey ?? "" },
        {
          sessionId,
          onSessionApprovalUsed: (grant) => trace?.approvalGrantUsed(grant),
          onCompaction: (event) => trace?.recordCompaction(event),
        },
      );
      attachStandardMonitoring(runtimeState, trace);
      const session = getSession(sessionId);
      if ((await session.getItems(1)).length === 0 && payload.history.length > 0) {
        await session.addItems(payload.history.map((item) => item.role === "user"
          ? { role: "user" as const, content: item.content }
          : {
              role: "assistant" as const,
              status: "completed" as const,
              content: [{ type: "output_text" as const, text: item.content }],
            }));
      }
      let keepRuntimeOpen = false;
      let maxTurnsReached = false;
      try {
        const result = await runtimeState.runner.run(runtimeState.mainAgent, payload.message, {
          session,
          maxTurns: payload.config.mainMaxTurns,
          errorHandlers: {
            maxTurns: () => {
              maxTurnsReached = true;
              return {
                finalOutput: payload.config.mainMaxTurns === null
                  ? "Agent Run 已停止，但没有生成最终回答。"
                  : `本次任务已达到单次 Run 的 ${payload.config.mainMaxTurns} 次内部循环上限，已安全停止。你可以在模型设置中提高上限或选择“不限制”。`,
                includeInHistory: true,
              };
            },
          },
        });

        if (result.interruptions.length > 0) {
          trace.setUsage(result.runContext.usage);
          const pending = await registerPendingApproval({
            sessionId,
            runtime: runtimeState,
            state: result.state,
            interruptions: result.interruptions,
            maxTurns: payload.config.mainMaxTurns,
            trace,
          });
          trace.awaitingApproval(result.interruptions.map((item) => ({
            toolName: item.name ?? item.toolName ?? "unknown_tool",
            agentName: item.agent?.name ?? "Agent",
          })));
          await trace.flush();
          keepRuntimeOpen = true;
          return NextResponse.json({ ...approvalResponse(pending), traceId: trace.id, metrics: trace.getMetrics() });
        }

        const tools = usedToolNames(result);
        for (const toolName of usedHostedToolNames(result)) {
          trace.add("hosted_tool", "runner", `托管工具 ${toolName} 调用完成`, undefined, { toolName });
        }
        const delegated = usedSubagent(result);
        const guardrails = guardrailsRun(result);
        trace.setUsage(result.runContext.usage);
        trace.finish("completed", maxTurnsReached ? "Agent Run 达到循环上限后停止" : "Agent Run 正常完成", {
          delegated,
          tools,
          guardrails,
          maxTurnsReached,
          maxTurns: payload.config.mainMaxTurns,
        });
        await trace.flush();
        return NextResponse.json({
          status: "completed",
          message: typeof result.finalOutput === "string" ? result.finalOutput : String(result.finalOutput ?? ""),
          delegated,
          tools,
          guardrails,
          maxTurnsReached,
          sessionId,
          traceId: trace.id,
          metrics: trace.getMetrics(),
        });
      } finally {
        if (!keepRuntimeOpen) await runtimeState.close();
      }
    });
  } catch (error) {
    const guardrail = guardrailErrorInfo(error);
    if (guardrail) {
      trace?.add("guardrail_blocked", "safety", guardrail.message, guardrail);
      trace?.finish("blocked", "Agent Run 被安全围栏终止", guardrail);
      await trace?.flush();
      return NextResponse.json({ error: guardrail.message, guardrail, traceId: trace?.id }, { status: 422 });
    }
    trace?.finish("failed", "Agent Run 执行失败", { message: error instanceof Error ? error.message : String(error) });
    await trace?.flush();
    if (error instanceof z.ZodError || error instanceof AgentConfigError || (error instanceof Error && error.message.includes("会话 ID"))) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "请求参数无效。", traceId: trace?.id }, { status: 422 });
    }
    console.error("Agent request failed", error);
    return NextResponse.json(
      { error: "Agent 请求失败，请检查服务端日志和模型配置。", traceId: trace?.id },
      { status: 502 },
    );
  }
}
