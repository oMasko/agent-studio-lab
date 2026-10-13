import { randomUUID } from "node:crypto";

import type { RunItem, RunStreamEvent } from "@openai/agents";
import { NextResponse } from "next/server";
import { z } from "zod";

import { AgentConfigError, createRuntime, getSession, guardrailsRun, usedHostedToolNames, usedSubagent, usedToolNames, validateSessionId, withSdkTraceContext } from "@/lib/agent";
import { chatPayload } from "@/lib/chat-schema";
import { guardrailErrorInfo } from "@/lib/guardrail-errors";
import { attachStandardMonitoring } from "@/lib/monitoring-hooks";
import { approvalResponse, hasPendingApproval, registerPendingApproval } from "@/lib/pending-approvals";
import { createAgentRun, getAgentRunByRequestId, updateAgentRun } from "@/lib/run-store";
import { startTrace } from "@/lib/trace-store";
import { registerActiveRun, releaseActiveRun } from "@/lib/active-runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StreamMessage = { type: string; [key: string]: unknown };

function itemActivity(event: Extract<RunStreamEvent, { type: "run_item_stream_event" }>): StreamMessage {
  const item = event.item as RunItem & { sourceAgent?: { name?: string }; targetAgent?: { name?: string } };
  const raw = item.rawItem as { type?: string; name?: string } | undefined;
  const toolName = raw?.type === "function_call" || raw?.type === "hosted_tool_call" ? raw.name : undefined;
  if (event.name === "handoff_occurred") {
    return { type: "handoff", fromAgent: item.sourceAgent?.name, toAgent: item.targetAgent?.name, label: `已交接给 ${item.targetAgent?.name ?? "Subagent"}` };
  }
  if (event.name === "handoff_requested") return { type: "activity", name: event.name, label: "正在请求 Agent 交接" };
  if (event.name === "tool_called") return { type: "activity", name: event.name, toolName, label: toolName ? `正在调用 ${toolName}` : "正在调用工具" };
  if (event.name === "tool_output") return { type: "activity", name: event.name, toolName, label: toolName ? `${toolName} 调用完成` : "工具调用完成" };
  if (event.name === "tool_approval_requested") return { type: "activity", name: event.name, toolName, label: "工具调用等待审批" };
  return { type: "activity", name: event.name, label: event.name };
}

function replayExistingRun(run: NonNullable<ReturnType<typeof getAgentRunByRequestId>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const send = (message: StreamMessage) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
      send({ type: "run_started", runId: run.id, traceId: run.traceId, recovered: true });
      const poll = () => {
        const current = getAgentRunByRequestId(run.requestId);
        if (!current) { send({ type: "error", error: "Run 不存在。" }); controller.close(); return; }
        if (current.status === "running") { setTimeout(poll, 1_000); return; }
        if (current.status === "awaiting_approval") send({ type: "approval_required", data: current.result });
        else if (current.status === "completed") send({ type: "completed", data: current.result });
        else send({ type: "error", error: current.error ?? `Run 状态：${current.status}`, runId: current.id });
        controller.close();
      };
      poll();
    },
  });
}

export async function POST(request: Request) {
  try {
    const payload = chatPayload.parse(await request.json());
    const sessionId = validateSessionId(payload.sessionId);
    if (await hasPendingApproval(sessionId)) {
      return NextResponse.json({ error: "当前会话有待审批的工具调用，请先批准或拒绝后再继续。" }, { status: 409 });
    }
    const requestId = payload.requestId ?? randomUUID();
    const existing = getAgentRunByRequestId(requestId);
    if (existing) {
      return new Response(replayExistingRun(existing), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" } });
    }
    const run = createAgentRun({ sessionId, requestId, message: payload.message, config: { ...payload.config, apiKey: payload.config.apiKey ?? "" } });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let connected = true;
        const send = (message: StreamMessage) => {
          if (!connected) return;
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`)); }
          catch { connected = false; }
        };
        const close = () => { if (connected) { try { controller.close(); } catch { /* Client disconnected. */ } } connected = false; };

        void withSdkTraceContext(payload.config.provider, async () => {
          const trace = startTrace({ sessionId, provider: payload.config.provider, model: payload.config.model, subagentModel: payload.config.subagentModel, input: payload.message });
          updateAgentRun(run.id, { traceId: trace.id });
          send({ type: "run_started", runId: run.id, traceId: trace.id });
          let runtimeState: Awaited<ReturnType<typeof createRuntime>> | undefined;
          let keepRuntimeOpen = false;
          const runController = registerActiveRun(run.id);
          try {
            runtimeState = await createRuntime({ ...payload.config, apiKey: payload.config.apiKey ?? "" }, {
              sessionId,
              onSessionApprovalUsed: (grant) => trace.approvalGrantUsed(grant),
              onCompaction: (event) => trace.recordCompaction(event),
            });
            attachStandardMonitoring(runtimeState, trace);
            const session = getSession(sessionId);
            if ((await session.getItems(1)).length === 0 && payload.history.length > 0) {
              await session.addItems(payload.history.map((item) => item.role === "user"
                ? { role: "user" as const, content: item.content }
                : { role: "assistant" as const, status: "completed" as const, content: [{ type: "output_text" as const, text: item.content }] }));
            }
            let maxTurnsReached = false;
            const stream = await runtimeState.runner.run(runtimeState.mainAgent, payload.message, {
              session,
              stream: true,
              signal: runController.signal,
              maxTurns: payload.config.mainMaxTurns,
              errorHandlers: {
                maxTurns: () => {
                  maxTurnsReached = true;
                  return {
                    finalOutput: payload.config.mainMaxTurns === null ? "Agent Run 已停止，但没有生成最终回答。" : `本次任务已达到单次 Run 的 ${payload.config.mainMaxTurns} 次内部循环上限，已安全停止。`,
                    includeInHistory: true,
                  };
                },
              },
            });
            for await (const event of stream) {
              if (event.type === "raw_model_stream_event" && event.data.type === "output_text_delta") {
                send({ type: "text_delta", delta: event.data.delta });
              } else if (event.type === "agent_updated_stream_event") {
                send({ type: "agent_updated", agentName: event.agent.name, label: `${event.agent.name} 正在处理` });
              } else if (event.type === "run_item_stream_event") {
                send(itemActivity(event));
              }
            }
            await stream.completed;
            if (runController.signal.aborted) {
              const message = typeof runController.signal.reason === "string" ? runController.signal.reason : "用户取消了 Agent Run";
              trace.finish("cancelled", message);
              const result = { status: "cancelled", message: "任务已取消。", detail: message, traceId: trace.id, runId: run.id };
              updateAgentRun(run.id, { status: "cancelled", error: message, result, state: stream.state.toString(), completed: true });
              await trace.flush();
              send({ type: "cancelled", ...result });
              return;
            }
            if (stream.error) throw stream.error;
            if (stream.interruptions.length > 0) {
              trace.setUsage(stream.runContext.usage);
              const pending = await registerPendingApproval({ sessionId, runtime: runtimeState, state: stream.state, interruptions: stream.interruptions, maxTurns: payload.config.mainMaxTurns, trace });
              const response = { ...approvalResponse(pending), traceId: trace.id, metrics: trace.getMetrics(), runId: run.id };
              trace.awaitingApproval(stream.interruptions.map((item) => ({ toolName: item.name ?? item.toolName ?? "unknown_tool", agentName: item.agent?.name ?? "Agent" })));
              await trace.flush();
              updateAgentRun(run.id, { status: "awaiting_approval", approvalId: pending.id, state: stream.state.toString(), result: response });
              keepRuntimeOpen = true;
              send({ type: "approval_required", data: response });
              return;
            }
            const tools = usedToolNames(stream);
            for (const toolName of usedHostedToolNames(stream)) trace.add("hosted_tool", "runner", `托管工具 ${toolName} 调用完成`, undefined, { toolName });
            const delegated = usedSubagent(stream);
            const guardrails = guardrailsRun(stream);
            trace.setUsage(stream.runContext.usage);
            trace.finish("completed", maxTurnsReached ? "Agent Run 达到循环上限后停止" : "Agent Run 正常完成", { delegated, tools, guardrails, maxTurnsReached, maxTurns: payload.config.mainMaxTurns });
            await trace.flush();
            const result = {
              status: "completed", message: typeof stream.finalOutput === "string" ? stream.finalOutput : String(stream.finalOutput ?? ""),
              delegated, tools, guardrails, maxTurnsReached, sessionId, traceId: trace.id, metrics: trace.getMetrics(), runId: run.id,
            };
            updateAgentRun(run.id, { status: "completed", result, state: stream.state.toString(), completed: true });
            send({ type: "completed", data: result });
          } catch (error) {
            if (runController.signal.aborted) {
              const message = typeof runController.signal.reason === "string" ? runController.signal.reason : "用户取消了 Agent Run";
              trace.finish("cancelled", message);
              updateAgentRun(run.id, { status: "cancelled", error: message, result: { status: "cancelled", message: "任务已取消。", detail: message, traceId: trace.id, runId: run.id }, completed: true });
              await trace.flush();
              send({ type: "cancelled", message: "任务已取消。", detail: message, traceId: trace.id, runId: run.id });
              return;
            }
            const guardrail = guardrailErrorInfo(error);
            const message = guardrail?.message ?? (error instanceof Error ? error.message : "Agent Run 执行失败");
            if (guardrail) {
              trace.add("guardrail_blocked", "safety", guardrail.message, guardrail);
              trace.finish("blocked", "Agent Run 被安全围栏终止", guardrail);
              updateAgentRun(run.id, { status: "blocked", error: message, result: { error: message, guardrail, traceId: trace.id, runId: run.id }, completed: true });
            } else {
              trace.finish("failed", "Agent Run 执行失败", { message });
              updateAgentRun(run.id, { status: "failed", error: message, completed: true });
            }
            await trace.flush();
            send({ type: "error", error: message, guardrail, traceId: trace.id, runId: run.id });
          } finally {
            releaseActiveRun(run.id, runController);
            if (runtimeState && !keepRuntimeOpen) await runtimeState.close().catch(() => undefined);
            close();
          }
        });
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof AgentConfigError || (error instanceof Error && error.message.includes("会话 ID"))) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "请求参数无效。" }, { status: 422 });
    }
    return NextResponse.json({ error: "无法启动 Agent Run。" }, { status: 500 });
  }
}
