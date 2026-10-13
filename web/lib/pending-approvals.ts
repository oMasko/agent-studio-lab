import { randomUUID } from "node:crypto";

import type { RunState, RunToolApprovalItem } from "@openai/agents";

import type { AgentRuntime } from "@/lib/agent";
import { parseApprovalArguments, sessionApprovalScope, type SessionApprovalScope } from "@/lib/session-approvals";
import type { TraceRecorder } from "@/lib/trace-store";
import type { ToolEffect, ToolRiskLevel, ToolSecurityProfile } from "@/lib/tool-capabilities";
import { latestAwaitingAgentRun } from "@/lib/run-store";

export type PublicApprovalItem = {
  id: string;
  toolName: string;
  agentName: string;
  arguments: unknown;
  argumentsText: string;
  capabilities: string[];
  source?: ToolSecurityProfile["source"];
  riskLevel?: ToolRiskLevel;
  effect?: ToolEffect;
  sessionScope: Pick<SessionApprovalScope, "kind" | "description">;
};

export type PendingApprovalRun = {
  id: string;
  sessionId: string;
  runtime: AgentRuntime;
  state: RunState<any, any>;
  interruptions: RunToolApprovalItem[];
  maxTurns: number | null;
  trace: TraceRecorder;
  createdAt: number;
};

const globalState = globalThis as typeof globalThis & {
  __agentStudioPendingApprovals?: Map<string, PendingApprovalRun>;
};

// A pending approval owns the SDK RunState and its live Runtime. Do not expire it
// on a timer: a person may come back to the approval much later. The state is
// released explicitly by approve/reject, session deletion, replacement, or when
// the server process exits. The cap only protects a long-running local server
// from accumulating an unbounded number of abandoned runtimes.
const maxPendingRuns = 50;

function pendingRuns(): Map<string, PendingApprovalRun> {
  globalState.__agentStudioPendingApprovals ??= new Map();
  return globalState.__agentStudioPendingApprovals;
}

function parseArguments(value: string | undefined): { parsed: unknown; text: string } {
  const text = value?.trim() || "{}";
  try {
    return { parsed: JSON.parse(text), text };
  } catch {
    return { parsed: text, text };
  }
}

export function publicApprovalItems(run: PendingApprovalRun): PublicApprovalItem[] {
  return run.interruptions.map((item, index) => {
    const args = parseArguments(item.arguments);
    const toolName = item.name ?? item.toolName ?? "unknown_tool";
    const profile = run.runtime.toolProfiles[toolName];
    const scope = sessionApprovalScope(toolName, parseApprovalArguments(item.arguments), profile);
    return {
      id: `${run.id}:${index}`,
      toolName,
      agentName: item.agent?.name ?? "Agent",
      arguments: args.parsed,
      argumentsText: args.text,
      capabilities: profile?.capabilities ?? [],
      source: profile?.source,
      riskLevel: profile?.riskLevel,
      effect: profile?.effect,
      sessionScope: { kind: scope.kind, description: scope.description },
    };
  });
}

async function disposePendingRun(item: PendingApprovalRun, reason: string): Promise<void> {
  item.trace.finish("cancelled", reason);
  await item.trace.flush();
  await item.runtime.close();
}

export async function hasPendingApproval(sessionId: string): Promise<boolean> {
  return [...pendingRuns().values()].some((item) => item.sessionId === sessionId) || Boolean(latestAwaitingAgentRun(sessionId));
}

export function getPendingApprovalForSession(sessionId: string): PendingApprovalRun | undefined {
  return [...pendingRuns().values()].find((item) => item.sessionId === sessionId);
}

export async function registerPendingApproval(input: Omit<PendingApprovalRun, "id" | "createdAt">): Promise<PendingApprovalRun> {
  const existing = [...pendingRuns().values()].filter((item) => item.sessionId === input.sessionId);
  for (const item of existing) pendingRuns().delete(item.id);
  await Promise.allSettled(existing.map((item) => disposePendingRun(item, "新的审批请求替换了此前的待审批任务")));
  const pending: PendingApprovalRun = { ...input, id: randomUUID(), createdAt: Date.now() };
  pendingRuns().set(pending.id, pending);

  const overflow = [...pendingRuns().values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(0, Math.max(0, pendingRuns().size - maxPendingRuns));
  for (const item of overflow) pendingRuns().delete(item.id);
  await Promise.allSettled(overflow.map((item) => disposePendingRun(item, "待审批任务数量超过服务上限，最早的任务已释放")));
  return pending;
}

export async function takePendingApproval(id: string): Promise<PendingApprovalRun | undefined> {
  const pending = pendingRuns().get(id);
  if (pending) pendingRuns().delete(id);
  return pending;
}

export async function cancelPendingApproval(id: string, reason = "用户取消了等待审批的 Agent Run"): Promise<boolean> {
  const pending = pendingRuns().get(id);
  if (!pending) return false;
  pendingRuns().delete(id);
  await disposePendingRun(pending, reason);
  return true;
}

export function restorePendingApproval(run: PendingApprovalRun): void {
  pendingRuns().set(run.id, { ...run, createdAt: Date.now() });
}

export async function cancelPendingApprovalsForSession(sessionId: string): Promise<void> {
  const matching = [...pendingRuns().values()].filter((item) => item.sessionId === sessionId);
  for (const item of matching) pendingRuns().delete(item.id);
  await Promise.allSettled(matching.map(async (item) => {
    item.trace.finish("cancelled", "会话已删除，待审批的 Agent Run 已取消");
    await item.trace.flush();
    await item.runtime.close();
  }));
}

export function approvalResponse(run: PendingApprovalRun) {
  return {
    status: "approval_required" as const,
    approval: {
      id: run.id,
      sessionId: run.sessionId,
      expiresAt: null,
      items: publicApprovalItems(run),
    },
  };
}
