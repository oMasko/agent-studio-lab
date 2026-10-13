import { NextResponse } from "next/server";
import { z } from "zod";

import { createAgentDefinition, listAgentDefinitions } from "@/lib/agent-definition-store";
import { agentPermissionsSchema } from "@/lib/agent-permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const agentDefinitionSchema = z.object({
  name: z.string(), description: z.string(), instructions: z.string(), model: z.string().default(""),
  collaboration: z.enum(["handoff", "tool", "both"]), coreTools: z.boolean(), webTools: z.boolean(),
  workspaceAccess: z.enum(["none", "read", "write"]), skillsEnabled: z.boolean(), mcpEnabled: z.boolean(),
  maxTurns: z.number().int().nullable(), enabled: z.boolean(), sortOrder: z.number().int(),
  permissions: agentPermissionsSchema,
});

export async function GET() { return NextResponse.json({ agents: listAgentDefinitions() }); }

export async function POST(request: Request) {
  try { return NextResponse.json({ agent: createAgentDefinition(agentDefinitionSchema.parse(await request.json())) }, { status: 201 }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Agent 配置无效。" }, { status: 422 }); }
}
