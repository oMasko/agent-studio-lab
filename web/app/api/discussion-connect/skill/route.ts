import { readFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import { discussionSkill } from "@/lib/discussion-access";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const skill = discussionSkill();
  const format = new URL(request.url).searchParams.get("format");
  const headers = { "Cache-Control": "no-store", "X-Skill-Hash": skill.hash, "X-Content-Type-Options": "nosniff" };
  if (format === "zip") {
    const zip = new JSZip(); zip.file("discussion-room-participant/SKILL.md", skill.content);
    zip.file("discussion-room-participant/scripts/participate.mjs", await readFile(join(process.cwd(), "resources/discussion-room-participant/scripts/participate.mjs")));
    return new Response(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { headers: { ...headers, "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="discussion-room-participant.zip"' } });
  }
  if (format === "json") return Response.json(skill, { headers });
  return new Response(skill.content, { headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
}
