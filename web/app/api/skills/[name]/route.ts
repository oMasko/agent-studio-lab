import { NextResponse } from "next/server";
import { z } from "zod";

import { deleteSkill, listInstalledSkills, SkillPackageError, updateSkillState } from "@/lib/skills";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ name: string }> };

export async function GET(_request: Request, context: Context) {
  const name = (await context.params).name;
  const skill = (await listInstalledSkills(true)).find((item) => item.name === name);
  return skill
    ? NextResponse.json({ skill })
    : NextResponse.json({ error: "Skill 不存在。" }, { status: 404 });
}

export async function PATCH(request: Request, context: Context) {
  try {
    const name = (await context.params).name;
    const patch = z.object({
      enabled: z.boolean().optional(),
      scope: z.enum(["main", "subagent", "both"]).optional(),
    }).parse(await request.json());
    await updateSkillState(name, patch);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "更新失败。" }, { status: 422 });
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    await deleteSkill((await context.params).name);
    return new Response(null, { status: 204 });
  } catch (error) {
    const status = error instanceof SkillPackageError ? 422 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除失败。" }, { status });
  }
}
