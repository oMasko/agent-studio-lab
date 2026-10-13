import { randomUUID } from "node:crypto";

import { agentDatabase } from "@/lib/database";
import { agentPermissionsSchema, emptyPermissions, legacyToolSelection, type AgentPermissions } from "@/lib/agent-permissions";

export type AgentCollaboration = "handoff" | "tool" | "both";
export type WorkspaceAccess = "none" | "read" | "write";

export type AgentDefinition = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  model: string;
  collaboration: AgentCollaboration;
  coreTools: boolean;
  webTools: boolean;
  workspaceAccess: WorkspaceAccess;
  skillsEnabled: boolean;
  mcpEnabled: boolean;
  maxTurns: number | null;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  permissions: AgentPermissions;
  permissionsMigrated: boolean;
};

export type AgentDefinitionInput = Omit<AgentDefinition, "id" | "createdAt" | "updatedAt" | "permissionsMigrated" | "permissions"> & { permissions?: AgentPermissions };

type Row = {
  id: string; name: string; description: string; instructions: string; model: string;
  collaboration: AgentCollaboration; core_tools: number; web_tools: number;
  workspace_access: WorkspaceAccess; skills_enabled: number; mcp_enabled: number;
  max_turns: number | null; enabled: number; sort_order: number; created_at: number; updated_at: number;
  permissions_json: string | null;
};

const defaultDefinition: AgentDefinitionInput = {
  name: "通用任务执行器",
  description: "处理复杂、可独立完成的通用任务；既可被 Main Agent 委派，也可直接接管对话。",
  instructions: "你是一个通用任务执行 Agent。准确完成交给你的目标，主动使用允许的工具核验事实；作为工具调用时返回可供 Main Agent 汇总的结果，作为 Handoff 接管时直接对最终用户负责。",
  model: "",
  collaboration: "both",
  coreTools: true,
  webTools: true,
  workspaceAccess: "read",
  skillsEnabled: true,
  mcpEnabled: true,
  maxTurns: null,
  enabled: true,
  sortOrder: 0,
};

const templates: Record<string, AgentDefinitionInput[]> = {
  planner_executor_reviewer: [
    {
      name: "任务规划师", description: "拆解复杂目标、识别依赖与风险，输出可执行计划。",
      instructions: "你是 Planner。只负责分析目标、拆解步骤、识别依赖和验收条件，不执行有副作用的操作。输出清晰、可执行的计划。",
      model: "", collaboration: "tool", coreTools: true, webTools: false, workspaceAccess: "read",
      skillsEnabled: true, mcpEnabled: false, maxTurns: 12, enabled: true, sortOrder: 10,
    },
    {
      name: "任务执行器", description: "根据明确目标执行工具、Skill 与 MCP 操作。",
      instructions: "你是 Executor。根据交付目标完成实际执行，使用允许的工具验证结果；敏感操作必须遵循审批，不得绕过权限策略。",
      model: "", collaboration: "both", coreTools: true, webTools: true, workspaceAccess: "write",
      skillsEnabled: true, mcpEnabled: true, maxTurns: 30, enabled: true, sortOrder: 20,
    },
    {
      name: "结果审查员", description: "独立检查事实、完整性、安全性与验收条件。",
      instructions: "你是 Reviewer。独立审查候选结果，检查事实依据、遗漏、风险和验收条件。不要盲目赞同；明确列出通过项、问题与修正建议。",
      model: "", collaboration: "tool", coreTools: true, webTools: true, workspaceAccess: "read",
      skillsEnabled: true, mcpEnabled: false, maxTurns: 15, enabled: true, sortOrder: 30,
    },
  ],
};

function fromRow(row: Row): AgentDefinition {
  return {
    id: row.id, name: row.name, description: row.description, instructions: row.instructions,
    model: row.model, collaboration: row.collaboration, coreTools: Boolean(row.core_tools),
    webTools: Boolean(row.web_tools), workspaceAccess: row.workspace_access,
    skillsEnabled: Boolean(row.skills_enabled), mcpEnabled: Boolean(row.mcp_enabled),
    maxTurns: row.max_turns, enabled: Boolean(row.enabled), sortOrder: row.sort_order,
    createdAt: row.created_at, updatedAt: row.updated_at,
    permissions: row.permissions_json ? agentPermissionsSchema.parse(JSON.parse(row.permissions_json)) : emptyPermissions(),
    permissionsMigrated: row.permissions_json !== null,
  };
}

function validate(input: AgentDefinitionInput): AgentDefinitionInput {
  const name = input.name.trim();
  const description = input.description.trim();
  const instructions = input.instructions.trim();
  if (!name || name.length > 80) throw new Error("Agent 名称必须为 1 到 80 个字符。");
  if (!description || description.length > 500) throw new Error("Agent 描述必须为 1 到 500 个字符。");
  if (!instructions || instructions.length > 20_000) throw new Error("Agent 系统提示词必须为 1 到 20000 个字符。");
  if (input.maxTurns !== null && (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 500)) throw new Error("最大循环必须为 1 到 500，或不限制。");
  const permissions = agentPermissionsSchema.parse(input.permissions ?? emptyPermissions());
  return { ...input, permissions, name, description, instructions, model: input.model.trim(), sortOrder: Math.trunc(input.sortOrder),
    coreTools: permissions.tools.some((name) => ["get_current_time", "calculate"].includes(name)),
    webTools: permissions.tools.some((name) => ["web_fetch", "web_search"].includes(name)),
    workspaceAccess: permissions.tools.some((name) => ["workspace_apply_patch", "workspace_run_command"].includes(name)) ? "write" : permissions.tools.some((name) => name.startsWith("workspace_")) ? "read" : "none",
    skillsEnabled: permissions.skills.length > 0, mcpEnabled: permissions.mcp.some((grant) => grant.tools.length > 0),
  };
}

export function ensureDefaultAgentDefinition(): void {
  const row = agentDatabase().prepare("SELECT COUNT(*) AS count FROM agent_definitions").get() as { count: number };
  if (Number(row.count) === 0) createAgentDefinition({ ...defaultDefinition, permissions: { ...emptyPermissions(), tools: legacyToolSelection(defaultDefinition) } });
}

export function listAgentDefinitions(enabledOnly = false): AgentDefinition[] {
  ensureDefaultAgentDefinition();
  const rows = agentDatabase().prepare(`SELECT * FROM agent_definitions ${enabledOnly ? "WHERE enabled = 1" : ""} ORDER BY sort_order ASC, created_at ASC`).all() as Row[];
  return rows.map(fromRow);
}

export function getAgentDefinition(id: string): AgentDefinition | undefined {
  const row = agentDatabase().prepare("SELECT * FROM agent_definitions WHERE id = ?").get(id) as Row | undefined;
  return row ? fromRow(row) : undefined;
}

export function createAgentDefinition(raw: AgentDefinitionInput): AgentDefinition {
  const input = validate(raw);
  const count = agentDatabase().prepare("SELECT COUNT(*) AS count FROM agent_definitions").get() as { count: number };
  if (Number(count.count) >= 20) throw new Error("最多配置 20 个专家 Agent。");
  const duplicate = agentDatabase().prepare("SELECT id FROM agent_definitions WHERE lower(name) = lower(?)").get(input.name);
  if (duplicate) throw new Error("Agent 名称不能重复。");
  const id = randomUUID(); const now = Date.now();
  agentDatabase().prepare(`INSERT INTO agent_definitions
    (id, name, description, instructions, model, collaboration, core_tools, web_tools, workspace_access,
     skills_enabled, mcp_enabled, max_turns, enabled, sort_order, created_at, updated_at, permissions_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.name, input.description, input.instructions, input.model, input.collaboration,
      input.coreTools ? 1 : 0, input.webTools ? 1 : 0, input.workspaceAccess,
      input.skillsEnabled ? 1 : 0, input.mcpEnabled ? 1 : 0, input.maxTurns,
      input.enabled ? 1 : 0, input.sortOrder, now, now, JSON.stringify(input.permissions));
  return getAgentDefinition(id)!;
}

export function updateAgentDefinition(id: string, raw: AgentDefinitionInput): AgentDefinition | undefined {
  if (!getAgentDefinition(id)) return undefined;
  const input = validate(raw);
  const duplicate = agentDatabase().prepare("SELECT id FROM agent_definitions WHERE lower(name) = lower(?) AND id <> ?").get(input.name, id);
  if (duplicate) throw new Error("Agent 名称不能重复。");
  agentDatabase().prepare(`UPDATE agent_definitions SET name=?, description=?, instructions=?, model=?, collaboration=?,
    core_tools=?, web_tools=?, workspace_access=?, skills_enabled=?, mcp_enabled=?, max_turns=?, enabled=?, sort_order=?, updated_at=?, permissions_json=? WHERE id=?`)
    .run(input.name, input.description, input.instructions, input.model, input.collaboration,
      input.coreTools ? 1 : 0, input.webTools ? 1 : 0, input.workspaceAccess,
      input.skillsEnabled ? 1 : 0, input.mcpEnabled ? 1 : 0, input.maxTurns,
      input.enabled ? 1 : 0, input.sortOrder, Date.now(), JSON.stringify(input.permissions), id);
  return getAgentDefinition(id);
}

export function deleteAgentDefinition(id: string): boolean {
  return Number(agentDatabase().prepare("DELETE FROM agent_definitions WHERE id = ?").run(id).changes) > 0;
}

export function installAgentTemplate(template: keyof typeof templates): AgentDefinition[] {
  const definitions = templates[template];
  if (!definitions) throw new Error("未知的 Agent 编排模板。");
  const existingNames = new Set(listAgentDefinitions().map((item) => item.name));
  return definitions.filter((item) => !existingNames.has(item.name)).map((item) => createAgentDefinition({ ...item, permissions: { ...emptyPermissions(), tools: legacyToolSelection(item) } }));
}

// Capture only explicitly enumerated assets; newly installed assets never inherit old grants.
export function migrateAgentPermissions(skills: string[], servers: { id: string; tools: string[] }[], onlyId?: string): void {
  const database = agentDatabase();
  const rows = database.prepare("SELECT * FROM agent_definitions WHERE permissions_json IS NULL").all() as Row[];
  for (const row of rows) {
    if (onlyId && row.id !== onlyId) continue;
    const definition = fromRow(row);
    const permissions: AgentPermissions = {
      tools: legacyToolSelection(definition), skills: definition.skillsEnabled ? skills : [],
      mcp: definition.mcpEnabled ? servers.map((server) => ({ serverId: server.id, tools: server.tools })) : [],
    };
    const input = validate({ ...definition, permissions });
    database.prepare("UPDATE agent_definitions SET permissions_json = ?, core_tools = ?, web_tools = ?, workspace_access = ?, skills_enabled = ?, mcp_enabled = ? WHERE id = ? AND permissions_json IS NULL")
      .run(JSON.stringify(permissions), input.coreTools ? 1 : 0, input.webTools ? 1 : 0, input.workspaceAccess,
        input.skillsEnabled ? 1 : 0, input.mcpEnabled ? 1 : 0, row.id);
  }
}
