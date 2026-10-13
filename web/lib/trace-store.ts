import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ProviderName } from "@/lib/config-types";
import type { CompactionEvent } from "@/lib/context-compaction";
import { createRunMetrics, type RunMetrics, type UsageSnapshot } from "@/lib/run-metrics";
import type { SessionApprovalGrant } from "@/lib/session-approvals";

export type TraceStatus = "running" | "awaiting_approval" | "completed" | "blocked" | "failed" | "cancelled";

export type TraceEventType =
  | "run_start"
  | "agent_start"
  | "agent_end"
  | "agent_handoff"
  | "tool_start"
  | "tool_end"
  | "hosted_tool"
  | "approval_required"
  | "approval_decision"
  | "approval_grant_created"
  | "approval_grant_used"
  | "guardrail_blocked"
  | "run_end"
  | "run_error"
  | "compaction_start"
  | "compaction_end"
  | "compaction_failed";

export type TraceEvent = {
  id: string;
  sequence: number;
  type: TraceEventType;
  timestamp: string;
  elapsedMs: number;
  scope: "run" | "runner" | "subagent" | "safety" | "approval";
  title: string;
  agentName?: string;
  toolName?: string;
  data?: unknown;
};

export type AgentTrace = {
  version: 1;
  id: string;
  sessionId: string;
  provider: ProviderName;
  model: string;
  subagentModel: string;
  inputPreview: string;
  status: TraceStatus;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  durationMs?: number;
  metrics?: RunMetrics;
  events: TraceEvent[];
};

export type TraceSummary = Omit<AgentTrace, "events"> & { eventCount: number };

type StartTraceInput = {
  sessionId: string;
  provider: ProviderName;
  model: string;
  subagentModel: string;
  input: string;
};

const tracesDirectory = resolve(process.cwd(), "..", ".agent-studio", "traces");
const secretKey = /(api[-_]?key|authorization|password|secret|token|cookie)/i;

function limitText(value: string, max = 1_200): string {
  const normalized = value
    .replace(/\0/g, "")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[REDACTED]")
    .replace(/((?:api[-_]?key|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function safeData(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return limitText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (depth >= 5) return "[depth limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeData(item, depth + 1, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50).map(([key, item]) => [
    key,
    secretKey.test(key) ? "[REDACTED]" : safeData(item, depth + 1, seen),
  ]));
}

function tracePath(id: string): string {
  return join(tracesDirectory, `${id}.json`);
}

async function writeTrace(trace: AgentTrace): Promise<void> {
  await mkdir(tracesDirectory, { recursive: true });
  const target = tracePath(trace.id);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(trace, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

export class TraceRecorder {
  readonly id: string;
  private readonly startedAtMs: number;
  private readonly trace: AgentTrace;
  private activeStartedAtMs: number | undefined;
  private activeDurationMs = 0;
  private usage: UsageSnapshot | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(input: StartTraceInput) {
    this.id = randomUUID();
    this.startedAtMs = Date.now();
    this.activeStartedAtMs = this.startedAtMs;
    const now = new Date(this.startedAtMs).toISOString();
    this.trace = {
      version: 1,
      id: this.id,
      sessionId: input.sessionId,
      provider: input.provider,
      model: input.model,
      subagentModel: input.subagentModel || input.model,
      inputPreview: limitText(input.input, 500),
      status: "running",
      startedAt: now,
      updatedAt: now,
      events: [],
    };
    this.add("run_start", "run", "开始 Agent Run", {
      provider: input.provider,
      model: input.model,
      subagentModel: input.subagentModel || input.model,
    });
  }

  add(type: TraceEventType, scope: TraceEvent["scope"], title: string, data?: unknown, fields?: Pick<TraceEvent, "agentName" | "toolName">): void {
    const now = Date.now();
    this.trace.updatedAt = new Date(now).toISOString();
    this.trace.events.push({
      id: randomUUID(),
      sequence: this.trace.events.length + 1,
      type,
      timestamp: this.trace.updatedAt,
      elapsedMs: now - this.startedAtMs,
      scope,
      title,
      ...fields,
      ...(typeof data === "undefined" ? {} : { data: safeData(data) }),
    });
    this.updateMetrics(now);
    this.queueWrite();
  }

  setUsage(usage: UsageSnapshot): void {
    this.usage = usage;
    this.updateMetrics();
    this.queueWrite();
  }

  recordCompaction(event: CompactionEvent): void {
    const { status, count, beforeTokens, afterTokens, summaryInputTokens, summaryOutputTokens, message } = event.record;
    this.add(event.phase === "start" ? "compaction_start" : event.phase === "end" ? "compaction_end" : "compaction_failed",
      "runner", message, { status, count, beforeTokens, afterTokens, summaryInputTokens, summaryOutputTokens }, { agentName: event.agentName });
  }

  getMetrics(): RunMetrics | undefined {
    this.updateMetrics();
    return this.trace.metrics ? { ...this.trace.metrics } : undefined;
  }

  resume(decision: "approve_once" | "approve_session" | "reject", reason?: string): void {
    this.trace.status = "running";
    delete this.trace.endedAt;
    delete this.trace.durationMs;
    this.activeStartedAtMs = Date.now();
    const title = decision === "reject"
      ? "用户拒绝工具调用"
      : decision === "approve_session"
        ? "用户批准工具调用并授权当前会话"
        : "用户仅批准本次工具调用";
    this.add("approval_decision", "approval", title, { decision, reason });
  }

  approvalGrantCreated(grants: SessionApprovalGrant[]): void {
    this.add("approval_grant_created", "approval", "已创建当前会话授权", {
      grants: grants.map((grant) => ({
        grantId: grant.id,
        toolName: grant.toolName,
        source: grant.source,
        capabilities: grant.capabilities,
        scope: grant.scope.description,
      })),
    });
  }

  approvalGrantUsed(grant: SessionApprovalGrant): void {
    this.add("approval_grant_used", "approval", `会话授权自动放行 ${grant.toolName}`, {
      grantId: grant.id,
      toolName: grant.toolName,
      source: grant.source,
      capabilities: grant.capabilities,
      scope: grant.scope.description,
    }, { toolName: grant.toolName });
  }

  awaitingApproval(items: Array<{ toolName: string; agentName: string }>): void {
    this.pauseActiveTime();
    this.trace.status = "awaiting_approval";
    this.add("approval_required", "approval", "等待人工审批", { items });
  }

  finish(status: Exclude<TraceStatus, "running" | "awaiting_approval">, title: string, data?: unknown): void {
    const now = Date.now();
    this.pauseActiveTime(now);
    this.trace.status = status;
    this.trace.endedAt = new Date(now).toISOString();
    this.trace.durationMs = now - this.startedAtMs;
    this.add(status === "failed" ? "run_error" : "run_end", status === "blocked" ? "safety" : "run", title, data);
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private queueWrite(): void {
    const snapshot = structuredClone(this.trace);
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => writeTrace(snapshot));
  }

  private pauseActiveTime(now = Date.now()): void {
    if (typeof this.activeStartedAtMs !== "number") return;
    this.activeDurationMs += Math.max(0, now - this.activeStartedAtMs);
    this.activeStartedAtMs = undefined;
  }

  private updateMetrics(now = Date.now()): void {
    if (!this.usage) return;
    const currentSegment = typeof this.activeStartedAtMs === "number" ? Math.max(0, now - this.activeStartedAtMs) : 0;
    const actionSteps = this.trace.events.filter((event) =>
      event.type === "tool_start" || event.type === "agent_handoff" || event.type === "approval_decision"
      || event.type === "hosted_tool"
    ).length;
    this.trace.metrics = createRunMetrics(this.usage, actionSteps, this.activeDurationMs + currentSegment);
  }
}

export function startTrace(input: StartTraceInput): TraceRecorder {
  return new TraceRecorder(input);
}

async function readTraceFile(file: string): Promise<AgentTrace | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as AgentTrace;
    return value.version === 1 && Array.isArray(value.events) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function getTrace(id: string): Promise<AgentTrace | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  return readTraceFile(tracePath(id));
}

export async function markTraceCancelled(id: string, reason: string): Promise<boolean> {
  const trace = await getTrace(id);
  if (!trace || !["running", "awaiting_approval"].includes(trace.status)) return false;
  const now = Date.now();
  const startedAt = new Date(trace.startedAt).getTime();
  trace.status = "cancelled";
  trace.updatedAt = new Date(now).toISOString();
  trace.endedAt = trace.updatedAt;
  trace.durationMs = Math.max(0, now - startedAt);
  trace.events.push({
    id: randomUUID(), sequence: trace.events.length + 1, type: "run_end",
    timestamp: trace.updatedAt, elapsedMs: trace.durationMs, scope: "run",
    title: reason, data: { recoveredCancellation: true },
  });
  await writeTrace(trace);
  return true;
}

export async function listTraceSummaries(options: { limit?: number; sessionId?: string; status?: TraceStatus } = {}): Promise<TraceSummary[]> {
  let names: string[];
  try {
    names = (await readdir(tracesDirectory)).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name));
  } catch {
    return [];
  }
  const traces = (await Promise.all(names.map((name) => readTraceFile(join(tracesDirectory, name)))))
    .filter((trace): trace is AgentTrace => Boolean(trace))
    .filter((trace) => !options.sessionId || trace.sessionId === options.sessionId)
    .filter((trace) => !options.status || trace.status === options.status)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, Math.min(Math.max(options.limit ?? 100, 1), 500));
  return traces.map(({ events, ...trace }) => ({ ...trace, eventCount: events.length }));
}

export async function clearTraces(): Promise<void> {
  await rm(tracesDirectory, { recursive: true, force: true });
  await mkdir(tracesDirectory, { recursive: true });
}
