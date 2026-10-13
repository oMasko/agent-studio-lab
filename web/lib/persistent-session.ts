import type { AgentInputItem, Session } from "@openai/agents";

import { agentDatabase } from "@/lib/database";
import { getSessionContext } from "@/lib/memory-store";
import { deleteContextUsage } from "@/lib/context-usage-store";
import { clearCompactions } from "@/lib/compaction-store";

type ItemRow = { sequence: number; item_json: string };

export function assembleSessionContext(items: AgentInputItem[], _context: ReturnType<typeof getSessionContext>) {
  // The model boundary owns compaction, so Session/RunState retain the full ledger.
  return { items, summary: "", compacted: false };
}

export function previewSessionContext(sessionId: string) {
  const rows = agentDatabase().prepare("SELECT item_json FROM session_items WHERE session_id=? ORDER BY sequence ASC").all(sessionId) as ItemRow[];
  const context = getSessionContext(sessionId);
  return { ...assembleSessionContext(rows.map((row) => JSON.parse(row.item_json) as AgentInputItem), context), storedItems: rows.length, context };
}

export class SqliteAgentSession implements Session {
  constructor(private readonly sessionId: string) {}

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const database = agentDatabase();
    const rows = typeof limit === "number"
      ? database.prepare("SELECT sequence, item_json FROM session_items WHERE session_id = ? ORDER BY sequence DESC LIMIT ?").all(this.sessionId, Math.max(0, limit)) as ItemRow[]
      : database.prepare("SELECT sequence, item_json FROM session_items WHERE session_id = ? ORDER BY sequence ASC").all(this.sessionId) as ItemRow[];
    const ordered = typeof limit === "number" ? rows.reverse() : rows;
    const items = ordered.map((row) => JSON.parse(row.item_json) as AgentInputItem);
    if (typeof limit === "number") return items;
    return items;
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (items.length === 0) return;
    const database = agentDatabase();
    const latest = database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM session_items WHERE session_id = ?").get(this.sessionId) as { sequence: number };
    const insert = database.prepare("INSERT INTO session_items(session_id, sequence, item_json, created_at) VALUES (?, ?, ?, ?)");
    database.exec("BEGIN IMMEDIATE");
    try {
      let sequence = Number(latest.sequence);
      const now = Date.now();
      for (const item of items) insert.run(this.sessionId, ++sequence, JSON.stringify(item), now);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const database = agentDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = database.prepare("SELECT sequence, item_json FROM session_items WHERE session_id = ? ORDER BY sequence DESC LIMIT 1").get(this.sessionId) as ItemRow | undefined;
      if (!row) { database.exec("COMMIT"); return undefined; }
      database.prepare("DELETE FROM session_items WHERE session_id = ? AND sequence = ?").run(this.sessionId, row.sequence);
      database.exec("COMMIT");
      return JSON.parse(row.item_json) as AgentInputItem;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async clearSession(): Promise<void> {
    agentDatabase().prepare("DELETE FROM session_items WHERE session_id = ?").run(this.sessionId);
    deleteContextUsage(this.sessionId);
    clearCompactions(this.sessionId);
  }
}
