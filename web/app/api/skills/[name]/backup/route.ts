import { buildSkillBackup, SkillPackageError } from "@/lib/skills";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ name: string }> }) {
  try {
    const name = (await context.params).name;
    const zip = await buildSkillBackup(name);
    return new Response(Buffer.from(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${name}.zip"`,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "备份失败。" },
      { status: error instanceof SkillPackageError ? 422 : 500 },
    );
  }
}
