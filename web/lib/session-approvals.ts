import { createHash, randomUUID } from "node:crypto";

import type { ToolSecurityProfile } from "@/lib/tool-capabilities";

export type SessionApprovalScope = {
  kind: "mcp_server" | "workspace_path" | "command" | "exact_arguments";
  description: string;
  fingerprint: string;
};

export type SessionApprovalGrant = {
  id: string;
  sessionId: string;
  toolName: string;
  source: ToolSecurityProfile["source"];
  capabilities: string[];
  scope: SessionApprovalScope;
  createdAt: string;
};

const globalState = globalThis as typeof globalThis & {
  __agentStudioSessionApprovals?: Map<string, Map<string, SessionApprovalGrant>>;
};

const maxGrantsPerSession = 100;

function approvals(): Map<string, Map<string, SessionApprovalGrant>> {
  globalState.__agentStudioSessionApprovals ??= new Map();
  return globalState.__agentStudioSessionApprovals;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function canonicalize(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[depth-limit]";
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item, depth + 1)]));
  }
  return String(value);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function normalizedPath(value: unknown): string {
  if (typeof value !== "string") return "<未指定路径>";
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "") || ".";
}

function compactCommand(command: string, args: string[]): string {
  const text = [command, ...args].join(" ");
  return text.length > 150 ? `${text.slice(0, 147)}…` : text;
}

export function parseApprovalArguments(value: string | undefined): unknown {
  const text = value?.trim() || "{}";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function sessionApprovalScope(toolName: string, input: unknown, profile?: ToolSecurityProfile): SessionApprovalScope {
  if (profile?.source === "mcp" && profile.mcpServer) {
    const serverName = profile.mcpServer.displayName || profile.mcpServer.title;
    return {
      kind: "mcp_server",
      description: `本会话信任 MCP 服务「${serverName}」下的全部工具和参数`,
      fingerprint: fingerprint({ mcpServerId: profile.mcpServer.id }),
    };
  }

  const args = record(input);
  if (toolName === "workspace_apply_patch" && args) {
    const path = normalizedPath(args.path);
    const operation = typeof args.operation === "string" ? args.operation : "write";
    const operationClass = operation === "delete" ? "delete" : "write";
    return {
      kind: "workspace_path",
      description: operationClass === "delete"
        ? `本会话仅允许删除 ${path}`
        : `本会话仅允许创建或修改 ${path}`,
      fingerprint: fingerprint({ operationClass, path }),
    };
  }

  if (toolName === "workspace_run_command" && args) {
    const command = typeof args.command === "string" ? args.command : "<未知命令>";
    const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const cwd = normalizedPath(typeof args.cwd === "undefined" ? "." : args.cwd);
    return {
      kind: "command",
      description: `本会话仅允许在 ${cwd} 重复执行：${compactCommand(command, commandArgs)}`,
      fingerprint: fingerprint({ command, args: commandArgs, cwd }),
    };
  }

  return {
    kind: "exact_arguments",
    description: `本会话仅允许 ${toolName} 使用完全相同的参数再次调用`,
    fingerprint: fingerprint(input),
  };
}

function grantKey(toolName: string, profile: ToolSecurityProfile, scope: SessionApprovalScope): string {
  return fingerprint({
    target: scope.kind === "mcp_server" && profile.mcpServer
      ? { mcpServerId: profile.mcpServer.id }
      : { toolName },
    source: profile.source,
    capabilities: [...profile.capabilities].sort(),
    scope: scope.fingerprint,
  });
}

export function grantSessionApproval(input: {
  sessionId: string;
  toolName: string;
  arguments: unknown;
  profile: ToolSecurityProfile;
}): SessionApprovalGrant {
  const scope = sessionApprovalScope(input.toolName, input.arguments, input.profile);
  const key = grantKey(input.toolName, input.profile, scope);
  let sessionGrants = approvals().get(input.sessionId);
  if (!sessionGrants) {
    sessionGrants = new Map();
    approvals().set(input.sessionId, sessionGrants);
  }
  const existing = sessionGrants.get(key);
  if (existing) return existing;

  const grant: SessionApprovalGrant = {
    id: randomUUID(),
    sessionId: input.sessionId,
    toolName: input.toolName,
    source: input.profile.source,
    capabilities: [...input.profile.capabilities],
    scope,
    createdAt: new Date().toISOString(),
  };
  sessionGrants.set(key, grant);
  while (sessionGrants.size > maxGrantsPerSession) {
    const oldest = sessionGrants.keys().next().value as string | undefined;
    if (!oldest) break;
    sessionGrants.delete(oldest);
  }
  return grant;
}

export function findSessionApproval(input: {
  sessionId: string;
  toolName: string;
  arguments: unknown;
  profile: ToolSecurityProfile;
}): SessionApprovalGrant | undefined {
  const scope = sessionApprovalScope(input.toolName, input.arguments, input.profile);
  return approvals().get(input.sessionId)?.get(grantKey(input.toolName, input.profile, scope));
}

export function clearSessionApprovals(sessionId: string): SessionApprovalGrant[] {
  const grants = [...(approvals().get(sessionId)?.values() ?? [])];
  approvals().delete(sessionId);
  return grants;
}
