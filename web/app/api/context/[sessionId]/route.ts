import { NextResponse } from "next/server";
import { z } from "zod";

import { agentDatabase } from "@/lib/database";
import { getSessionContext, saveSessionContext } from "@/lib/memory-store";
import { getCompactionSettings, saveCompactionSettings } from "@/lib/compaction-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  summary: z.string().max(12_000).optional(), autoCompact: z.boolean().optional(),
  recentItemLimit: z.number().int().min(10).max(200).optional(),
  triggerPercent: z.number().int().min(40).max(90).optional(),
  targetPercent: z.number().int().min(20).max(80).optional(),
  summaryTokens: z.number().int().min(256).max(8192).optional(),
  fallbackTokenBudget: z.number().int().min(4096).max(1000000).optional(),
});

function stats(sessionId: string) {
  const row = agentDatabase().prepare(`SELECT COUNT(*) AS item_count, COALESCE(SUM(LENGTH(item_json)), 0) AS chars
    FROM session_items WHERE session_id = ?`).get(sessionId) as { item_count: number; chars: number };
  return { itemCount: Number(row.item_count), estimatedTokens: Math.ceil(Number(row.chars) / 4) };
}

export async function GET(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const sessionId = (await context.params).sessionId;
  return NextResponse.json({ context: { ...getSessionContext(sessionId), ...getCompactionSettings(sessionId) }, stats: stats(sessionId) });
}

export async function PATCH(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const sessionId = (await context.params).sessionId;
    const patch = patchSchema.parse(await request.json());
    const { triggerPercent, targetPercent, summaryTokens, fallbackTokenBudget } = patch;
    const settings = saveCompactionSettings(sessionId, Object.fromEntries(Object.entries({ triggerPercent, targetPercent, summaryTokens, fallbackTokenBudget }).filter(([, value]) => value !== undefined)));
    const value = saveSessionContext(sessionId, patch);
    return NextResponse.json({ context: { ...value, ...settings }, stats: stats(sessionId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "上下文配置无效。" }, { status: 422 });
  }
}
