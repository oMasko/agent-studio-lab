import { NextResponse } from "next/server";
import { z } from "zod";

import { createMcpServer, listMcpServers, McpStoreError } from "@/lib/mcp-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const mcpInputSchema = z.object({
  title: z.string(),
  displayName: z.string().default(""),
  description: z.string().default(""),
  preset: z.enum(["custom", "fetch", "time", "memory", "sequential-thinking", "context7"]),
  enabled: z.boolean(),
  scope: z.enum(["main", "subagent", "both"]),
  trusted: z.boolean(),
  config: z.unknown(),
});

export async function GET() {
  return NextResponse.json({ servers: await listMcpServers(), stdioAllowed: process.env.ALLOW_STDIO_MCP === "true" });
}

export async function POST(request: Request) {
  try {
    const server = await createMcpServer(mcpInputSchema.parse(await request.json()));
    return NextResponse.json({ server }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建失败。" }, { status: error instanceof McpStoreError || error instanceof z.ZodError ? 422 : 500 });
  }
}
