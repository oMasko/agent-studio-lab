import { NextResponse } from "next/server";
import { contextIdentitySchema } from "@/lib/context-usage-schema";
import { getContextLimits, getContextSnapshot } from "@/lib/context-usage-store";
import { estimateContextTokens, type ContextUsageView } from "@/lib/context-usage-types";
import { previewSessionContext } from "@/lib/persistent-session";
import { listAgentDefinitions } from "@/lib/agent-definition-store";
import { z } from "zod";
import { getCompaction, getCompactionSettings } from "@/lib/compaction-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = contextIdentitySchema.extend({ subagentModel: z.string().trim().max(256).default("") });
export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const sessionId = (await context.params).sessionId;
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(sessionId)) throw new Error("会话 ID 无效");
    const config = schema.parse(await request.json());
    const definitions = [{ id: "main", name: "Main Agent", model: config.model },
      ...listAgentDefinitions(true).map((item) => ({ id: item.id, name: item.name, model: item.model || config.subagentModel || config.model }))];
    const history = previewSessionContext(sessionId);
    const result: ContextUsageView = { sessionId, agents: definitions.map((item) => {
      const identity = { provider: config.provider, model: item.model, baseURL: config.baseURL, apiMode: config.apiMode };
      return { agentId: item.id, agentName: item.name, identity, limits: getContextLimits(identity), snapshot: getContextSnapshot(sessionId, item.id, identity), compaction: getCompaction(sessionId, item.id, identity) };
    }), compactionSettings: getCompactionSettings(sessionId), history: { storedItems: history.storedItems, effectiveItems: history.items.length, estimatedTokens: estimateContextTokens(history.items),
      autoCompact: history.context.autoCompact, compacted: history.compacted, recentItemLimit: history.context.recentItemLimit, summaryIncluded: Boolean(history.summary) } };
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "上下文统计读取失败" }, { status: 422 }); }
}
