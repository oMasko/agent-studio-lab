import { NextResponse } from "next/server";
import { z } from "zod";

import { deleteMemory, updateMemory } from "@/lib/memory-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  content: z.string().trim().min(1).max(4_000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const memory = updateMemory((await context.params).id, patchSchema.parse(await request.json()));
    return memory ? NextResponse.json({ memory }) : NextResponse.json({ error: "记忆不存在。" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "记忆参数无效。" }, { status: 422 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  return deleteMemory((await context.params).id) ? new Response(null, { status: 204 }) : NextResponse.json({ error: "记忆不存在。" }, { status: 404 });
}
