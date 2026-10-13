import { NextResponse } from "next/server";

import { getSession, validateSessionId } from "@/lib/agent";
import { cancelPendingApprovalsForSession } from "@/lib/pending-approvals";
import { clearSessionApprovals } from "@/lib/session-approvals";
import { deleteSessionRuns } from "@/lib/run-store";
import { deleteSessionContext } from "@/lib/memory-store";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    const sessionId = validateSessionId((await context.params).sessionId);
    await cancelPendingApprovalsForSession(sessionId);
    clearSessionApprovals(sessionId);
    const session = getSession(sessionId);
    await session.clearSession();
    deleteSessionRuns(sessionId);
    deleteSessionContext(sessionId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法清空会话。" }, { status: 422 });
  }
}
