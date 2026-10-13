import { NextResponse } from "next/server";
import { builtinTools, type PermissionCatalog } from "@/lib/agent-permissions";
import { listInstalledSkills } from "@/lib/skills";
import { listMcpServers } from "@/lib/mcp-store";
import { getSafetySettings } from "@/lib/safety-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [skills, servers, safety] = await Promise.all([listInstalledSkills(), listMcpServers(), getSafetySettings()]);
  const scopeReason = (item: { enabled: boolean; scope: string }) => !item.enabled ? "全局已停用" : item.scope === "main" ? "仅授权给 Main Agent" : "";
  const catalog: PermissionCatalog = {
    tools: builtinTools.map((item) => {
      const reason = item.name === "workspace_run_command" && !safety.workspace.shellEnabled ? "全局命令执行已关闭"
        : item.name === "workspace_apply_patch" && !safety.workspace.writeEnabled ? "全局文件写入已关闭"
        : ["workspace_list_files", "workspace_read_file", "workspace_search"].includes(item.name) && !safety.workspace.readEnabled ? "全局文件读取已关闭" : "";
      return { ...item, available: !reason, reason };
    }),
    skills: skills.map((item) => ({ name: item.name, description: item.description, available: !scopeReason(item), reason: scopeReason(item) })),
    servers: servers.map((item) => {
      const reason = scopeReason(item) || (item.config.type === "stdio" && (!item.trusted || process.env.ALLOW_STDIO_MCP !== "true") ? "stdio 尚未获得服务端信任或执行授权" : "");
      return { id: item.id, label: item.displayName || item.title, available: !reason, reason };
    }),
  };
  return NextResponse.json(catalog);
}
