import { randomUUID } from "node:crypto";

import type { AgentInputItem } from "@openai/agents";

import { agentDatabase } from "@/lib/database";
import { clearCompactionSettings } from "@/lib/compaction-store";

export type MemoryScope = "global" | "session";

export type AgentMemory = {
  id: string;
  scope: MemoryScope;
  sessionId?: string;
  content: string;
  tags: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type SessionContext = {
  sessionId: string;
  summary: string;
  autoCompact: boolean;
  recentItemLimit: number;
  updatedAt: number;
};

type MemoryRow = {
  id: string; scope: MemoryScope; session_id: string | null; content: string; tags_json: string;
  enabled: number; created_at: number; updated_at: number;
};

type ContextRow = {
  session_id: string; summary: string; auto_compact: number; recent_item_limit: number; updated_at: number;
};

function memoryFromRow(row: MemoryRow): AgentMemory {
  return {
    id: row.id,
    scope: row.scope,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    content: row.content,
    tags: JSON.parse(row.tags_json) as string[],
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listMemories(sessionId?: string, enabledOnly = false): AgentMemory[] {
  const rows = sessionId
    ? agentDatabase().prepare(`SELECT * FROM agent_memories
        WHERE (scope = 'global' OR (scope = 'session' AND session_id = ?)) ${enabledOnly ? "AND enabled = 1" : ""}
        ORDER BY scope ASC, updated_at DESC`).all(sessionId) as MemoryRow[]
    : agentDatabase().prepare(`SELECT * FROM agent_memories ${enabledOnly ? "WHERE enabled = 1" : ""} ORDER BY updated_at DESC`).all() as MemoryRow[];
  return rows.map(memoryFromRow);
}

export function createMemory(input: { scope: MemoryScope; sessionId?: string; content: string; tags?: string[]; enabled?: boolean }): AgentMemory {
  const id = randomUUID();
  const now = Date.now();
  agentDatabase().prepare(`INSERT INTO agent_memories
    (id, scope, session_id, content, tags_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.scope, input.scope === "session" ? input.sessionId ?? null : null, input.content, JSON.stringify(input.tags ?? []), input.enabled === false ? 0 : 1, now, now);
  return listMemories().find((item) => item.id === id)!;
}

export function updateMemory(id: string, patch: Partial<Pick<AgentMemory, "content" | "tags" | "enabled">>): AgentMemory | undefined {
  const current = listMemories().find((item) => item.id === id);
  if (!current) return undefined;
  agentDatabase().prepare("UPDATE agent_memories SET content = ?, tags_json = ?, enabled = ?, updated_at = ? WHERE id = ?")
    .run(patch.content ?? current.content, JSON.stringify(patch.tags ?? current.tags), (patch.enabled ?? current.enabled) ? 1 : 0, Date.now(), id);
  return listMemories().find((item) => item.id === id);
}

export function deleteMemory(id: string): boolean {
  return Number(agentDatabase().prepare("DELETE FROM agent_memories WHERE id = ?").run(id).changes) > 0;
}

export function getSessionContext(sessionId: string): SessionContext {
  const row = agentDatabase().prepare("SELECT * FROM session_contexts WHERE session_id = ?").get(sessionId) as ContextRow | undefined;
  if (row) return { sessionId, summary: row.summary, autoCompact: Boolean(row.auto_compact), recentItemLimit: row.recent_item_limit, updatedAt: row.updated_at };
  return { sessionId, summary: "", autoCompact: true, recentItemLimit: 40, updatedAt: 0 };
}

export function saveSessionContext(sessionId: string, patch: Partial<Pick<SessionContext, "summary" | "autoCompact" | "recentItemLimit">>): SessionContext {
  const current = getSessionContext(sessionId);
  const next = {
    summary: patch.summary ?? current.summary,
    autoCompact: patch.autoCompact ?? current.autoCompact,
    recentItemLimit: Math.min(Math.max(patch.recentItemLimit ?? current.recentItemLimit, 10), 200),
    updatedAt: Date.now(),
  };
  agentDatabase().prepare(`INSERT INTO session_contexts(session_id, summary, auto_compact, recent_item_limit, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
    summary = excluded.summary, auto_compact = excluded.auto_compact,
    recent_item_limit = excluded.recent_item_limit, updated_at = excluded.updated_at`)
    .run(sessionId, next.summary, next.autoCompact ? 1 : 0, next.recentItemLimit, next.updatedAt);
  return { sessionId, ...next };
}

function itemText(item: AgentInputItem): string {
  const value = item as unknown as { role?: string; content?: unknown };
  if (typeof value.content === "string") return `${value.role ?? "item"}: ${value.content}`;
  if (!Array.isArray(value.content)) return "";
  const text = value.content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const record = part as Record<string, unknown>;
    return typeof record.text === "string" ? record.text : "";
  }).filter(Boolean).join(" ");
  return text ? `${value.role ?? "item"}: ${text}` : "";
}

export function buildExtractiveSummary(items: AgentInputItem[], maxChars = 5_000): string {
  const lines = items.map(itemText).filter(Boolean).map((line) => line.replace(/\s+/g, " ").slice(0, 500));
  const selected: string[] = [];
  let size = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (size + lines[index].length + 2 > maxChars) break;
    selected.unshift(lines[index]);
    size += lines[index].length + 2;
  }
  return selected.join("\n");
}

export function memoryInstructions(sessionId: string): string {
  const memories = listMemories(sessionId, true);
  const summary = getSessionContext(sessionId).summary.trim();
  const sections: string[] = [];
  if (memories.length) sections.push(`# 可用长期记忆\n${memories.map((item) => `- ${item.content}`).join("\n")}`);
  if (summary) sections.push(`# 人工补充上下文 / 旧版会话摘要\n${summary}`);
  if (!sections.length) return "";
  return `\n\n${sections.join("\n\n")}\n\n记忆仅作为上下文参考；若与用户当前明确要求冲突，以当前要求为准。`;
}

export function deleteSessionContext(sessionId: string): void {
  clearCompactionSettings(sessionId);
  agentDatabase().prepare("DELETE FROM session_contexts WHERE session_id = ?").run(sessionId);
  agentDatabase().prepare("DELETE FROM agent_memories WHERE scope = 'session' AND session_id = ?").run(sessionId);
}
