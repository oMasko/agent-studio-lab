import { NextResponse } from "next/server";
import { z } from "zod";

import { mcpInputSchema } from "@/app/api/mcp/servers/route";
import { deleteMcpServer, getMcpServer, McpStoreError, patchMcpServer, updateMcpServer } from "@/lib/mcp-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    return NextResponse.json({ server: await getMcpServer((await context.params).id), stdioAllowed: process.env.ALLOW_STDIO_MCP === "true" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取失败。" }, { status: error instanceof McpStoreError ? 404 : 500 });
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    return NextResponse.json({ server: await updateMcpServer((await context.params).id, mcpInputSchema.parse(await request.json())) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "更新失败。" }, { status: error instanceof McpStoreError || error instanceof z.ZodError ? 422 : 500 });
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const patch = z.object({ enabled: z.boolean().optional(), scope: z.enum(["main", "subagent", "both"]).optional() }).parse(await request.json());
    return NextResponse.json({ server: await patchMcpServer((await context.params).id, patch) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "更新失败。" }, { status: 422 });
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    await deleteMcpServer((await context.params).id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除失败。" }, { status: error instanceof McpStoreError ? 422 : 500 });
  }
}
