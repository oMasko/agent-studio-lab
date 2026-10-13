import { NextResponse } from "next/server";
import { z } from "zod";

import { deletePromptPreset, listPromptPresets, PromptStoreError, updatePromptPreset } from "@/lib/prompt-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

const schema = z.object({
  name: z.string(),
  description: z.string().default(""),
  mainInstructions: z.string(),
  subagentInstructions: z.string(),
});

export async function GET(_request: Request, context: Context) {
  const id = (await context.params).id;
  const prompt = (await listPromptPresets()).find((item) => item.id === id);
  return prompt ? NextResponse.json({ prompt }) : NextResponse.json({ error: "提示词方案不存在。" }, { status: 404 });
}

export async function PATCH(request: Request, context: Context) {
  try {
    const prompt = await updatePromptPreset((await context.params).id, schema.parse(await request.json()));
    return NextResponse.json({ prompt });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "更新失败。" }, { status: error instanceof PromptStoreError || error instanceof z.ZodError ? 422 : 500 });
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    await deletePromptPreset((await context.params).id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除失败。" }, { status: error instanceof PromptStoreError ? 422 : 500 });
  }
}
