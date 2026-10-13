import { NextResponse } from "next/server";

import { validateSessionId } from "@/lib/agent";
import { approvalResponse, getPendingApprovalForSession } from "@/lib/pending-approvals";
import { latestAwaitingAgentRun } from "@/lib/run-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const sessionId = validateSessionId(new URL(request.url).searchParams.get("sessionId") ?? "");
    const pending = getPendingApprovalForSession(sessionId);
    if (pending) return NextResponse.json(approvalResponse(pending));
    const stored = latestAwaitingAgentRun(sessionId);
    if (!stored?.result) return NextResponse.json({ error: "当前会话没有待审批任务。" }, { status: 404 });
    return NextResponse.json(stored.result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法恢复审批任务。" }, { status: 422 });
  }
}
