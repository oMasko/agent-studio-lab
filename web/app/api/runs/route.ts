import { NextResponse } from "next/server";

import { isRunActive } from "@/lib/active-runs";
import { listAgentRuns, type RunStatus } from "@/lib/run-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const statuses = new Set<RunStatus>(["running", "awaiting_approval", "completed", "blocked", "failed", "cancelled"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const statusValue = url.searchParams.get("status") ?? undefined;
  const status = statusValue && statuses.has(statusValue as RunStatus) ? statusValue as RunStatus : undefined;
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const sessionId = url.searchParams.get("sessionId")?.trim() || undefined;
  const runs = listAgentRuns({ status, sessionId, limit: Number.isFinite(limit) ? limit : 100 }).map((run) => ({
    id: run.id, sessionId: run.sessionId, requestId: run.requestId, status: run.status,
    input: run.input, traceId: run.traceId, approvalId: run.approvalId,
    result: run.result, error: run.error, createdAt: run.createdAt, updatedAt: run.updatedAt,
    completedAt: run.completedAt, active: isRunActive(run.id),
  }));
  return NextResponse.json({ runs });
}
