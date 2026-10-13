import { NextResponse } from "next/server";
import { getAgentDefinition, migrateAgentPermissions } from "@/lib/agent-definition-store";
import { inspectManagedMcpServer } from "@/lib/agent";
import { listInstalledSkills } from "@/lib/skills";
import { listMcpServers } from "@/lib/mcp-store";

export const runtime = "nodejs";
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = (await context.params).id;
    const agent = getAgentDefinition(id);
    if (!agent) return NextResponse.json({ error: "Agent 不存在" }, { status: 404 });
    if (agent.permissionsMigrated) return NextResponse.json({ agent });
    const [skills, servers] = await Promise.all([listInstalledSkills(), listMcpServers()]);
    const eligible = servers.filter((item) => agent.mcpEnabled && item.enabled && item.scope !== "main");
    const grants = await Promise.all(eligible.map(async (server) => ({ id: server.id, tools: (await inspectManagedMcpServer(server, true)).map((item) => item.name) })));
    migrateAgentPermissions(skills.filter((item) => item.enabled && item.scope !== "main").map((item) => item.name), grants, id);
    return NextResponse.json({ agent: getAgentDefinition(id) });
  } catch (error) {
    return NextResponse.json({ error: `旧权限迁移未完成，原配置已保留：${error instanceof Error ? error.message : "工具发现失败"}` }, { status: 502 });
  }
}
