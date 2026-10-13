import { NextResponse } from "next/server";
import { z } from "zod";

import { createPromptPreset, listPromptPresets, PromptStoreError } from "@/lib/prompt-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string(),
  description: z.string().default(""),
  mainInstructions: z.string(),
  subagentInstructions: z.string(),
});

export async function GET() {
  return NextResponse.json({ prompts: await listPromptPresets() });
}

export async function POST(request: Request) {
  try {
    const prompt = await createPromptPreset(schema.parse(await request.json()));
    return NextResponse.json({ prompt }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建失败。" }, { status: error instanceof PromptStoreError || error instanceof z.ZodError ? 422 : 500 });
  }
}
