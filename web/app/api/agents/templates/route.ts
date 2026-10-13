import { NextResponse } from "next/server";
import { z } from "zod";

import { installAgentTemplate } from "@/lib/agent-definition-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { template } = z.object({ template: z.literal("planner_executor_reviewer") }).parse(await request.json());
    return NextResponse.json({ agents: installAgentTemplate(template) }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "模板参数无效。" }, { status: 422 }); }
}
