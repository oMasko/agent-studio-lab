import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const state = globalThis as typeof globalThis & { __agentStudioDatabase?: DatabaseSync; __agentPermissionsSchemaReady?: boolean };

export function agentDatabase(): DatabaseSync {
  if (state.__agentStudioDatabase) {
    if (!state.__agentPermissionsSchemaReady) ensurePermissionsColumn(state.__agentStudioDatabase);
    return state.__agentStudioDatabase;
  }
  const directory = resolve(process.cwd(), "..", ".agent-studio");
  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(resolve(directory, "agent-studio.sqlite"));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS session_items (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      item_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_session_items_latest
      ON session_items(session_id, sequence DESC);
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      request_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      input_text TEXT NOT NULL,
      config_json TEXT NOT NULL,
      trace_id TEXT,
      approval_id TEXT,
      state_json TEXT,
      result_json TEXT,
      error_text TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_session_latest
      ON agent_runs(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_approval
      ON agent_runs(approval_id);
    CREATE TABLE IF NOT EXISTS session_contexts (
      session_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL DEFAULT '',
      auto_compact INTEGER NOT NULL DEFAULT 1,
      recent_item_limit INTEGER NOT NULL DEFAULT 40,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_memories (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'session')),
      session_id TEXT,
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_memories_scope
      ON agent_memories(scope, session_id, enabled, updated_at DESC);
    CREATE TABLE IF NOT EXISTS agent_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      instructions TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      collaboration TEXT NOT NULL CHECK (collaboration IN ('handoff', 'tool', 'both')),
      core_tools INTEGER NOT NULL DEFAULT 1,
      web_tools INTEGER NOT NULL DEFAULT 1,
      workspace_access TEXT NOT NULL CHECK (workspace_access IN ('none', 'read', 'write')),
      skills_enabled INTEGER NOT NULL DEFAULT 1,
      mcp_enabled INTEGER NOT NULL DEFAULT 1,
      max_turns INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_definitions_enabled
      ON agent_definitions(enabled, sort_order, created_at);
  `);
  ensurePermissionsColumn(database);
  state.__agentStudioDatabase = database;
  return database;
}

function ensurePermissionsColumn(database: DatabaseSync) {
  const columns = database.prepare("PRAGMA table_info(agent_definitions)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "permissions_json")) {
    database.exec("ALTER TABLE agent_definitions ADD COLUMN permissions_json TEXT");
  }
  state.__agentPermissionsSchemaReady = true;
}
