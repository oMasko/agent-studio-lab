import { NextResponse } from "next/server";

import { getAgentRun } from "@/lib/run-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const run = getAgentRun((await context.params).id);
  if (!run) return NextResponse.json({ error: "Run 不存在。" }, { status: 404 });
  return NextResponse.json({
    run: {
      id: run.id,
      sessionId: run.sessionId,
      requestId: run.requestId,
      status: run.status,
      input: run.input,
      traceId: run.traceId,
      approvalId: run.approvalId,
      result: run.result,
      error: run.error,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
    },
  });
}
