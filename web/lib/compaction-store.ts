import { agentDatabase } from "@/lib/database";
import { contextIdentityKey } from "@/lib/context-usage-store";
import type { ContextIdentity } from "@/lib/context-usage-types";
import { defaultCompactionSettings, type CompactionSettings, type CompactionRecord } from "@/lib/compaction-types";

function database() {
  const db = agentDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS compaction_settings(session_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS context_compactions(session_id TEXT NOT NULL, agent_id TEXT NOT NULL, identity_key TEXT NOT NULL,
    operation_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(session_id, agent_id, identity_key));`);
  return db;
}
export function getCompactionSettings(sessionId: string): CompactionSettings {
  const row = database().prepare("SELECT settings_json FROM compaction_settings WHERE session_id=?").get(sessionId) as { settings_json: string } | undefined;
  return { ...defaultCompactionSettings, ...(row ? JSON.parse(row.settings_json) : {}) };
}
export function saveCompactionSettings(sessionId: string, patch: Partial<CompactionSettings>) {
  const settings = { ...getCompactionSettings(sessionId), ...patch };
  if (!(settings.targetPercent >= 20 && settings.triggerPercent <= 90 && settings.targetPercent + 10 <= settings.triggerPercent)
    || !Number.isInteger(settings.summaryTokens) || settings.summaryTokens < 256 || settings.summaryTokens > 8192
    || !Number.isInteger(settings.fallbackTokenBudget) || settings.fallbackTokenBudget < 4096 || settings.fallbackTokenBudget > 1000000) throw new Error("压缩目标须至少低于触发比例 10%，摘要预算须为 256–8192 Token。");
  database().prepare("INSERT INTO compaction_settings VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET settings_json=excluded.settings_json").run(sessionId, JSON.stringify(settings));
  return settings;
}
export function getCompaction(sessionId: string, agentId: string, identity: ContextIdentity): CompactionRecord | null {
  const row = database().prepare("SELECT record_json FROM context_compactions WHERE session_id=? AND agent_id=? AND identity_key=?")
    .get(sessionId, agentId, contextIdentityKey(identity)) as { record_json: string } | undefined;
  return row ? JSON.parse(row.record_json) : null;
}
export function startCompaction(sessionId: string, agentId: string, identity: ContextIdentity, record: CompactionRecord) {
  database().prepare(`INSERT INTO context_compactions VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, agent_id, identity_key)
    DO UPDATE SET operation_id=excluded.operation_id, record_json=excluded.record_json`)
    .run(sessionId, agentId, contextIdentityKey(identity), record.operationId, JSON.stringify(record));
}
export function finishCompaction(sessionId: string, agentId: string, identity: ContextIdentity, record: CompactionRecord) {
  return Number(database().prepare("UPDATE context_compactions SET record_json=? WHERE session_id=? AND agent_id=? AND identity_key=? AND operation_id=?")
    .run(JSON.stringify(record), sessionId, agentId, contextIdentityKey(identity), record.operationId).changes) > 0;
}
export function clearCompactions(sessionId: string) {
  database().prepare("DELETE FROM context_compactions WHERE session_id=?").run(sessionId);
}
export function clearCompactionSettings(sessionId: string) {
  database().prepare("DELETE FROM compaction_settings WHERE session_id=?").run(sessionId);
}
