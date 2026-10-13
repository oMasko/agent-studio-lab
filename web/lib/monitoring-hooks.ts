import type { Agent, Runner } from "@openai/agents";

import type { ToolSecurityProfile } from "@/lib/tool-capabilities";
import type { TraceRecorder } from "@/lib/trace-store";

type MonitoredRuntime = {
  runner: Runner;
  subagents: Agent[];
  toolProfiles: Record<string, ToolSecurityProfile>;
};

function toolCallData(toolCall: unknown): unknown {
  if (!toolCall || typeof toolCall !== "object") return undefined;
  const value = toolCall as Record<string, unknown>;
  let args = value.arguments;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { /* Keep non-JSON arguments as text. */ }
  }
  return {
    callId: value.callId ?? value.call_id ?? value.id,
    arguments: args,
  };
}

function outputPreview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > 1_200 ? `${text.slice(0, 1_200)}…` : text;
}

/**
 * Registers the standard lifecycle hooks used by Agent Studio monitoring.
 * Runner hooks cover the main orchestration; Agent hooks cover the nested
 * subagent because Agent.asTool creates an internal Runner.
 */
export function attachStandardMonitoring(runtime: MonitoredRuntime, trace: TraceRecorder): void {
  runtime.runner.on("agent_start", (_context, agent, turnInput) => {
    trace.add("agent_start", "runner", `${agent.name} 开始运行`, { inputItems: turnInput?.length ?? 0 }, { agentName: agent.name });
  });
  runtime.runner.on("agent_end", (_context, agent, output) => {
    trace.add("agent_end", "runner", `${agent.name} 结束运行`, { outputPreview: outputPreview(output) }, { agentName: agent.name });
  });
  runtime.runner.on("agent_handoff", (_context, fromAgent, toAgent) => {
    trace.add("agent_handoff", "runner", `${fromAgent.name} 交接给 ${toAgent.name}`, {
      fromAgent: fromAgent.name,
      toAgent: toAgent.name,
    }, { agentName: toAgent.name });
  });
  runtime.runner.on("agent_tool_start", (_context, agent, tool, details) => {
    trace.add("tool_start", "runner", `开始调用 ${tool.name}`, {
      ...((toolCallData(details.toolCall) as Record<string, unknown> | undefined) ?? {}),
      securityProfile: runtime.toolProfiles[tool.name],
    }, { agentName: agent.name, toolName: tool.name });
  });
  runtime.runner.on("agent_tool_end", (_context, agent, tool, result, details) => {
    trace.add("tool_end", "runner", `${tool.name} 调用完成`, {
      ...((toolCallData(details.toolCall) as Record<string, unknown> | undefined) ?? {}),
      securityProfile: runtime.toolProfiles[tool.name],
      resultPreview: outputPreview(result),
    }, { agentName: agent.name, toolName: tool.name });
  });

  for (const subagent of runtime.subagents) {
    subagent.on("agent_start", (_context, agent, turnInput) => {
      trace.add("agent_start", "subagent", `${agent.name} 开始运行`, { inputItems: turnInput?.length ?? 0 }, { agentName: agent.name });
    });
    subagent.on("agent_end", (_context, output) => {
      trace.add("agent_end", "subagent", `${subagent.name} 结束运行`, { outputPreview: outputPreview(output) }, { agentName: subagent.name });
    });
    subagent.on("agent_handoff", (_context, nextAgent) => {
      trace.add("agent_handoff", "subagent", `${subagent.name} 交接给 ${nextAgent.name}`, { toAgent: nextAgent.name }, { agentName: nextAgent.name });
    });
    subagent.on("agent_tool_start", (_context, tool, details) => {
      trace.add("tool_start", "subagent", `${subagent.name} 开始调用 ${tool.name}`, {
        ...((toolCallData(details.toolCall) as Record<string, unknown> | undefined) ?? {}),
        securityProfile: runtime.toolProfiles[tool.name],
      }, { agentName: subagent.name, toolName: tool.name });
    });
    subagent.on("agent_tool_end", (_context, tool, result, details) => {
      trace.add("tool_end", "subagent", `${subagent.name} 完成调用 ${tool.name}`, {
        ...((toolCallData(details.toolCall) as Record<string, unknown> | undefined) ?? {}),
        securityProfile: runtime.toolProfiles[tool.name],
        resultPreview: outputPreview(result),
      }, { agentName: subagent.name, toolName: tool.name });
    });
  }
}
