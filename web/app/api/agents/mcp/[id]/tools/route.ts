import { NextResponse } from "next/server";
import { inspectManagedMcpServer } from "@/lib/agent";
import { getMcpServer } from "@/lib/mcp-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const server = await getMcpServer((await context.params).id);
    if (!server.enabled || server.scope === "main") return NextResponse.json({ error: "该服务尚未向 Subagent 启用。" }, { status: 422 });
    return NextResponse.json({ tools: await inspectManagedMcpServer(server, true) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "工具发现失败" }, { status: 502 });
  }
}
