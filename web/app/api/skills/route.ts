import { NextResponse } from "next/server";

import { installSkillFiles, installSkillZip, listInstalledSkills, SkillPackageError } from "@/lib/skills";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ skills: await listInstalledSkills() });
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const mode = form.get("mode");
    if (mode === "zip") {
      const archive = form.get("archive");
      if (!(archive instanceof File)) throw new SkillPackageError("请选择 ZIP 文件。");
      const skill = await installSkillZip(new Uint8Array(await archive.arrayBuffer()));
      return NextResponse.json({ skill }, { status: 201 });
    }
    if (mode === "directory") {
      const uploaded = form.getAll("files").filter((value): value is File => value instanceof File);
      const paths = form.getAll("paths").map(String);
      if (paths.length !== uploaded.length) throw new SkillPackageError("目录文件路径信息不完整。");
      const files = await Promise.all(uploaded.map(async (file, index) => ({
        path: paths[index],
        data: new Uint8Array(await file.arrayBuffer()),
      })));
      const skill = await installSkillFiles(files);
      return NextResponse.json({ skill }, { status: 201 });
    }
    throw new SkillPackageError("不支持的导入方式。");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Skill 安装失败。";
    return NextResponse.json({ error: message }, { status: error instanceof SkillPackageError ? 422 : 500 });
  }
}
