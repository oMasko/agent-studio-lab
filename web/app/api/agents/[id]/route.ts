import { NextResponse } from "next/server";

import { agentDefinitionSchema } from "@/app/api/agents/route";
import { deleteAgentDefinition, updateAgentDefinition } from "@/lib/agent-definition-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const agent = updateAgentDefinition((await context.params).id, agentDefinitionSchema.parse(await request.json()));
    return agent ? NextResponse.json({ agent }) : NextResponse.json({ error: "Agent 不存在。" }, { status: 404 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Agent 配置无效。" }, { status: 422 }); }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  return deleteAgentDefinition((await context.params).id) ? new Response(null, { status: 204 }) : NextResponse.json({ error: "Agent 不存在。" }, { status: 404 });
}
