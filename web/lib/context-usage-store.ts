import { createHash } from "node:crypto";
import { agentDatabase } from "@/lib/database";
import { knownContextLimits } from "@/lib/model-context-catalog";
import type { ContextIdentity, ContextLimits, ContextSnapshot } from "@/lib/context-usage-types";

function database() {
  const db = agentDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS context_usage (
    session_id TEXT NOT NULL, agent_id TEXT NOT NULL, identity_key TEXT NOT NULL,
    snapshot_json TEXT NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY(session_id, agent_id, identity_key)
  );
  CREATE TABLE IF NOT EXISTS model_context_limits (
    identity_key TEXT PRIMARY KEY, context_window INTEGER, output_reserve INTEGER NOT NULL
  );`);
  return db;
}

export function contextIdentityKey(identity: ContextIdentity): string {
  return createHash("sha256").update(JSON.stringify([identity.provider, identity.model.trim(), identity.baseURL.trim().replace(/\/+$/, ""), identity.apiMode])).digest("hex");
}
export function startContextSnapshot(sessionId: string, identity: ContextIdentity, snapshot: ContextSnapshot) {
  database().prepare(`INSERT INTO context_usage VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, agent_id, identity_key) DO UPDATE SET snapshot_json=excluded.snapshot_json, request_id=excluded.request_id`)
    .run(sessionId, snapshot.agentId, contextIdentityKey(identity), JSON.stringify(snapshot), snapshot.requestId);
}
export function finishContextSnapshot(sessionId: string, identity: ContextIdentity, snapshot: ContextSnapshot) {
  // A slower request must not overwrite a newer invocation of the same expert.
  database().prepare("UPDATE context_usage SET snapshot_json=? WHERE session_id=? AND agent_id=? AND identity_key=? AND request_id=?")
    .run(JSON.stringify(snapshot), sessionId, snapshot.agentId, contextIdentityKey(identity), snapshot.requestId);
}
export function getContextSnapshot(sessionId: string, agentId: string, identity: ContextIdentity): ContextSnapshot | null {
  const row = database().prepare("SELECT snapshot_json FROM context_usage WHERE session_id=? AND agent_id=? AND identity_key=?")
    .get(sessionId, agentId, contextIdentityKey(identity)) as { snapshot_json: string } | undefined;
  return row ? JSON.parse(row.snapshot_json) as ContextSnapshot : null;
}
export function getContextLimits(identity: ContextIdentity): ContextLimits {
  const row = database().prepare("SELECT context_window, output_reserve FROM model_context_limits WHERE identity_key=?")
    .get(contextIdentityKey(identity)) as { context_window: number | null; output_reserve: number } | undefined;
  return row ? { contextWindow: row.context_window, outputReserve: row.output_reserve, source: "manual" } : knownContextLimits(identity);
}
export function saveContextLimits(identity: ContextIdentity, limits: ContextLimits) {
  if ((limits.contextWindow !== null && (!Number.isSafeInteger(limits.contextWindow) || limits.contextWindow < 1))
    || !Number.isSafeInteger(limits.outputReserve) || limits.outputReserve < 0
    || (limits.contextWindow !== null && limits.outputReserve >= limits.contextWindow)) throw new Error("窗口上限必须为正整数或留空，输出预留必须小于窗口上限。");
  database().prepare(`INSERT INTO model_context_limits VALUES (?, ?, ?)
    ON CONFLICT(identity_key) DO UPDATE SET context_window=excluded.context_window, output_reserve=excluded.output_reserve`)
    .run(contextIdentityKey(identity), limits.contextWindow, limits.outputReserve);
}
export function deleteContextUsage(sessionId: string) { database().prepare("DELETE FROM context_usage WHERE session_id=?").run(sessionId); }
