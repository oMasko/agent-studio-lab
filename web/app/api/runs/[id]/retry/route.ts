import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { POST as startStreamingRun } from "@/app/api/chat/stream/route";
import { getAgentRun } from "@/lib/run-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const run = getAgentRun((await context.params).id);
  if (!run) return NextResponse.json({ error: "Run 不存在。" }, { status: 404 });
  if (["running", "awaiting_approval"].includes(run.status)) {
    return NextResponse.json({ error: "运行中或等待审批的 Run 不能重试，请先取消。" }, { status: 409 });
  }
  const retryRequest = new Request(new URL("/api/chat/stream", request.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: randomUUID(), sessionId: run.sessionId, message: run.input,
      history: [], config: run.config,
    }),
  });
  return startStreamingRun(retryRequest);
}
