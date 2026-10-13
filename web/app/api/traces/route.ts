import { NextResponse } from "next/server";

import { clearTraces, listTraceSummaries, type TraceStatus } from "@/lib/trace-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const statuses = new Set<TraceStatus>(["running", "awaiting_approval", "completed", "blocked", "failed", "cancelled"]);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const statusValue = params.get("status") || undefined;
  if (statusValue && !statuses.has(statusValue as TraceStatus)) {
    return NextResponse.json({ error: "Trace 状态筛选值无效。" }, { status: 422 });
  }
  const limitValue = Number(params.get("limit") || 100);
  const traces = await listTraceSummaries({
    limit: Number.isFinite(limitValue) ? limitValue : 100,
    sessionId: params.get("sessionId")?.trim() || undefined,
    status: statusValue as TraceStatus | undefined,
  });
  return NextResponse.json({ traces });
}

export async function DELETE() {
  await clearTraces();
  return NextResponse.json({ ok: true });
}
