import { NextResponse } from "next/server";

import { cancelActiveRun } from "@/lib/active-runs";
import { cancelPendingApproval } from "@/lib/pending-approvals";
import { getAgentRun, updateAgentRun } from "@/lib/run-store";
import { markTraceCancelled } from "@/lib/trace-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const run = getAgentRun((await context.params).id);
  if (!run) return NextResponse.json({ error: "Run 不存在。" }, { status: 404 });
  if (!["running", "awaiting_approval"].includes(run.status)) {
    return NextResponse.json({ error: `Run 已经是 ${run.status}，无需取消。`, run }, { status: 409 });
  }
  const reason = "用户从运行中心取消了 Agent Run";
  const aborted = cancelActiveRun(run.id, reason);
  const approvalCancelled = run.approvalId ? await cancelPendingApproval(run.approvalId, reason) : false;
  if (!aborted && !approvalCancelled && run.traceId) await markTraceCancelled(run.traceId, reason);
  const updated = updateAgentRun(run.id, {
    status: "cancelled", error: reason, approvalId: null,
    result: { status: "cancelled", message: "任务已取消。", detail: reason, traceId: run.traceId, runId: run.id }, completed: true,
  });
  return NextResponse.json({ run: updated, signalDelivered: aborted, approvalCancelled });
}
