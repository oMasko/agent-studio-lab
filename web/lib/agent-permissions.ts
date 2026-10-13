import { z } from "zod";

export const builtinTools = [
  { name: "get_current_time", label: "当前时间", group: "基础", description: "读取可信的时间与日期" },
  { name: "calculate", label: "精确计算", group: "基础", description: "受限数学表达式求值" },
  { name: "web_fetch", label: "读取网页", group: "联网", description: "读取已知的公开网页" },
  { name: "web_search", label: "联网搜索", group: "联网", description: "搜索实时信息，需启用联网及可用搜索后端" },
  { name: "workspace_list_files", label: "列出文件", group: "工作区", description: "查看工作区目录" },
  { name: "workspace_read_file", label: "读取文件", group: "工作区", description: "读取工作区文件内容" },
  { name: "workspace_search", label: "搜索文件", group: "工作区", description: "搜索工作区文本" },
  { name: "workspace_apply_patch", label: "修改文件", group: "工作区", description: "真实修改文件，仍受安全审批约束" },
  { name: "workspace_run_command", label: "执行命令", group: "工作区", description: "真实运行进程；命令可读写文件或联网，不是沙箱" },
] as const;

const names = z.array(z.string().trim().min(1).max(256)).max(1000).transform((items) => [...new Set(items)]);
export const agentPermissionsSchema = z.object({
  tools: z.array(z.enum(builtinTools.map((item) => item.name))).max(50).transform((items) => [...new Set(items)]),
  skills: names,
  mcp: z.array(z.object({ serverId: z.string().min(1).max(100), tools: names })).max(100)
    .refine((grants) => new Set(grants.map((grant) => grant.serverId)).size === grants.length, "MCP Server 授权项不能重复"),
});
export type AgentPermissions = z.infer<typeof agentPermissionsSchema>;
export const emptyPermissions = (): AgentPermissions => ({ tools: [], skills: [], mcp: [] });

export function permitsMcp(permissions: AgentPermissions, serverId: string, toolName: string): boolean {
  return permissions.mcp.some((grant) => grant.serverId === serverId && grant.tools.includes(toolName));
}

export function selectAllowedTools<T extends { name: string }>(tools: T[], permissions: AgentPermissions): T[] {
  return tools.filter((tool) => permissions.tools.some((name) => name === tool.name));
}

export function legacyToolSelection(input: { coreTools: boolean; webTools: boolean; workspaceAccess: string }): AgentPermissions["tools"] {
  return builtinTools.filter(({ name, group }) => group === "基础" ? input.coreTools
    : group === "联网" ? input.webTools
    : input.workspaceAccess === "write" || (input.workspaceAccess === "read" && !["workspace_apply_patch", "workspace_run_command"].includes(name)))
    .map(({ name }) => name);
}

export type PermissionCatalog = {
  tools: Array<{ name: string; label: string; group: string; description: string; available: boolean; reason: string }>;
  skills: Array<{ name: string; description: string; available: boolean; reason: string }>;
  servers: Array<{ id: string; label: string; available: boolean; reason: string }>;
};
