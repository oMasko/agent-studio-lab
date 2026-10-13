import { NextResponse } from "next/server";

import { readSkillFile, SkillPackageError } from "@/lib/skills";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ name: string }> }) {
  try {
    const path = new URL(request.url).searchParams.get("path") ?? "";
    const content = await readSkillFile((await context.params).name, path);
    return NextResponse.json({ path, content });
  } catch (error) {
    const status = error instanceof SkillPackageError ? 422 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取失败。" }, { status });
  }
}
