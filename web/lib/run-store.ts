import { randomUUID } from "node:crypto";

import type { EditableConfig } from "@/lib/config-types";
import { agentDatabase } from "@/lib/database";

export type RunStatus = "running" | "awaiting_approval" | "completed" | "blocked" | "failed" | "cancelled";
export type PersistedRuntimeConfig = Omit<EditableConfig, "apiKey">;

export type PersistedAgentRun = {
  id: string;
  sessionId: string;
  requestId: string;
  status: RunStatus;
  input: string;
  config: PersistedRuntimeConfig;
  traceId?: string;
  approvalId?: string;
  state?: string;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

type RunRow = {
  id: string; session_id: string; request_id: string; status: RunStatus; input_text: string; config_json: string;
  trace_id: string | null; approval_id: string | null; state_json: string | null; result_json: string | null;
  error_text: string | null; created_at: number; updated_at: number; completed_at: number | null;
};

function fromRow(row: RunRow | undefined): PersistedAgentRun | undefined {
  if (!row) return undefined;
  return {
    id: row.id, sessionId: row.session_id, requestId: row.request_id, status: row.status,
    input: row.input_text, config: JSON.parse(row.config_json) as PersistedRuntimeConfig,
    ...(row.trace_id ? { traceId: row.trace_id } : {}),
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    ...(row.state_json ? { state: row.state_json } : {}),
    ...(row.result_json ? { result: JSON.parse(row.result_json) as Record<string, unknown> } : {}),
    ...(row.error_text ? { error: row.error_text } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

export function createAgentRun(input: { sessionId: string; requestId: string; message: string; config: EditableConfig }): PersistedAgentRun {
  const existing = getAgentRunByRequestId(input.requestId);
  if (existing) return existing;
  const id = randomUUID();
  const now = Date.now();
  const { apiKey: _secret, ...safeConfig } = input.config;
  agentDatabase().prepare(`INSERT INTO agent_runs
    (id, session_id, request_id, status, input_text, config_json, created_at, updated_at)
    VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`)
    .run(id, input.sessionId, input.requestId, input.message, JSON.stringify(safeConfig), now, now);
  return getAgentRun(id)!;
}

export function updateAgentRun(id: string, patch: {
  status?: RunStatus; traceId?: string; approvalId?: string | null; state?: string | null;
  result?: Record<string, unknown> | null; error?: string | null; completed?: boolean;
}): PersistedAgentRun | undefined {
  const current = getAgentRun(id);
  if (!current) return undefined;
  const status = patch.status ?? current.status;
  const completedAt = patch.completed ? Date.now() : current.completedAt ?? null;
  agentDatabase().prepare(`UPDATE agent_runs SET status = ?, trace_id = ?, approval_id = ?, state_json = ?,
    result_json = ?, error_text = ?, updated_at = ?, completed_at = ? WHERE id = ?`).run(
      status,
      patch.traceId === undefined ? current.traceId ?? null : patch.traceId,
      patch.approvalId === undefined ? current.approvalId ?? null : patch.approvalId,
      patch.state === undefined ? current.state ?? null : patch.state,
      patch.result === undefined ? (current.result ? JSON.stringify(current.result) : null) : (patch.result ? JSON.stringify(patch.result) : null),
      patch.error === undefined ? current.error ?? null : patch.error,
      Date.now(), completedAt, id,
    );
  return getAgentRun(id);
}

export function getAgentRun(id: string): PersistedAgentRun | undefined {
  return fromRow(agentDatabase().prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as RunRow | undefined);
}

export function getAgentRunByRequestId(requestId: string): PersistedAgentRun | undefined {
  return fromRow(agentDatabase().prepare("SELECT * FROM agent_runs WHERE request_id = ?").get(requestId) as RunRow | undefined);
}

export function getAgentRunByApprovalId(approvalId: string): PersistedAgentRun | undefined {
  return fromRow(agentDatabase().prepare("SELECT * FROM agent_runs WHERE approval_id = ?").get(approvalId) as RunRow | undefined);
}

export function latestAgentRun(sessionId: string): PersistedAgentRun | undefined {
  return fromRow(agentDatabase().prepare("SELECT * FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1").get(sessionId) as RunRow | undefined);
}

export function latestAwaitingAgentRun(sessionId: string): PersistedAgentRun | undefined {
  return fromRow(agentDatabase().prepare("SELECT * FROM agent_runs WHERE session_id = ? AND status = 'awaiting_approval' ORDER BY created_at DESC LIMIT 1").get(sessionId) as RunRow | undefined);
}

export function listAgentRuns(options: { sessionId?: string; status?: RunStatus; limit?: number } = {}): PersistedAgentRun[] {
  const conditions: string[] = [];
  const values: Array<string | number> = [];
  if (options.sessionId) { conditions.push("session_id = ?"); values.push(options.sessionId); }
  if (options.status) { conditions.push("status = ?"); values.push(options.status); }
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  values.push(limit);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return (agentDatabase().prepare(`SELECT * FROM agent_runs ${where} ORDER BY created_at DESC LIMIT ?`).all(...values) as RunRow[])
    .map((row) => fromRow(row)!);
}

export function deleteSessionRuns(sessionId: string): void {
  agentDatabase().prepare("DELETE FROM agent_runs WHERE session_id = ?").run(sessionId);
}
