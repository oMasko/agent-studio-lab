import { NextResponse } from "next/server";

import { getSession, validateSessionId, visibleMessages } from "@/lib/agent";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const sessionId = validateSessionId(new URL(request.url).searchParams.get("sessionId") ?? "");
    const session = getSession(sessionId);
    const messages = visibleMessages(await session.getItems());
    return NextResponse.json({ sessionId, messages });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取会话。" }, { status: 422 });
  }
}
