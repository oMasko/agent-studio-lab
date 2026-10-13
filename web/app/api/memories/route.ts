import { NextResponse } from "next/server";
import { z } from "zod";

import { createMemory, listMemories } from "@/lib/memory-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  scope: z.enum(["global", "session"]),
  sessionId: z.string().trim().max(80).optional(),
  content: z.string().trim().min(1).max(4_000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim() || undefined;
  return NextResponse.json({ memories: listMemories(sessionId) });
}

export async function POST(request: Request) {
  try {
    const payload = createSchema.parse(await request.json());
    if (payload.scope === "session" && !payload.sessionId) return NextResponse.json({ error: "会话记忆必须填写 Session ID。" }, { status: 422 });
    return NextResponse.json({ memory: createMemory(payload) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "记忆参数无效。" }, { status: 422 });
  }
}
