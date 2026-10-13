import { NextResponse } from "next/server";

import { activatePromptPreset, PromptStoreError } from "@/lib/prompt-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    return NextResponse.json({ prompt: await activatePromptPreset((await context.params).id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "启用失败。" }, { status: error instanceof PromptStoreError ? 422 : 500 });
  }
}
