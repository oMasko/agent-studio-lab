import { NextResponse } from "next/server";
import { contextLimitsSchema } from "@/lib/context-usage-schema";
import { saveContextLimits } from "@/lib/context-usage-store";
export const runtime = "nodejs";
export async function PUT(request: Request) {
  try {
    const { identity, limits } = contextLimitsSchema.parse(await request.json());
    saveContextLimits(identity, limits);
    return NextResponse.json({ limits });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "窗口配置无效" }, { status: 422 }); }
}
