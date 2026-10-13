import { NextResponse } from "next/server";

import { getAgentRunByRequestId } from "@/lib/run-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ requestId: string }> }) {
  const run = getAgentRunByRequestId((await context.params).requestId);
  if (!run) return NextResponse.json({ error: "Run 尚未创建。" }, { status: 404 });
  return NextResponse.json({ run: {
    id: run.id, sessionId: run.sessionId, requestId: run.requestId, status: run.status,
    traceId: run.traceId, approvalId: run.approvalId, result: run.result, error: run.error,
    createdAt: run.createdAt, updatedAt: run.updatedAt, completedAt: run.completedAt,
  } });
}
