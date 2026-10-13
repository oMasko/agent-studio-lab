import { NextResponse } from "next/server";

import { inspectManagedMcpServer } from "@/lib/agent";
import { getMcpServer, McpStoreError } from "@/lib/mcp-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const server = await getMcpServer((await context.params).id);
    return NextResponse.json({ tools: await inspectManagedMcpServer(server) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "MCP 连接失败。";
    return NextResponse.json({ error: message }, { status: error instanceof McpStoreError ? 422 : 502 });
  }
}
