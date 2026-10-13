import { NextResponse } from "next/server";
import { z } from "zod";

import { getSafetySettings, saveSafetySettings, SafetyStoreError } from "@/lib/safety-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const section = z.object({
  enabled: z.boolean(),
  blockedTerms: z.array(z.string()),
});

const payloadSchema = z.object({
  inputGuardrail: section,
  outputGuardrail: section,
  toolGuardrail: section,
  approval: z.object({
    enabled: z.boolean(),
    demoToolEnabled: z.boolean(),
  }),
  workspace: z.object({
    readEnabled: z.boolean(),
    writeEnabled: z.boolean(),
    shellEnabled: z.boolean(),
    maxCommandSeconds: z.number().int().min(5).max(120),
  }),
  toolPolicy: z.object({
    enabled: z.boolean(),
    defaultAction: z.enum(["allow", "approval", "deny"]),
    rules: z.array(z.object({
      id: z.string(),
      enabled: z.boolean(),
      source: z.enum(["all", "function", "skill", "mcp", "agent"]),
      pattern: z.string(),
      capability: z.string().default("*"),
      action: z.enum(["allow", "approval", "deny"]),
      description: z.string(),
    })).max(100),
  }),
});

export async function GET() {
  return NextResponse.json({ settings: await getSafetySettings() });
}

export async function PUT(request: Request) {
  try {
    const payload = payloadSchema.parse(await request.json());
    return NextResponse.json({ settings: await saveSafetySettings(payload) });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SafetyStoreError) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "安全策略格式无效。" }, { status: 422 });
    }
    console.error("Safety settings update failed", error);
    return NextResponse.json({ error: "保存安全策略失败。" }, { status: 500 });
  }
}
