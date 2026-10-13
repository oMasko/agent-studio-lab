import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "dotenv";
import { getSafetySettings, findBlockedTerm } from "@/lib/safety-store";
export class DiscussionError extends Error { constructor(public code: string, message: string, public status = 409) { super(message); } }
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function bearer(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9_-]{24,256}$/.test(header)) throw new DiscussionError("UNAUTHORIZED", "缺少或无效的访问令牌", 401);
  return header.slice(7);
}
export function requireAdmin(request: Request) {
  config({ path: resolve(process.cwd(), "../.env"), quiet: true });
  const expected = process.env.DISCUSSION_ADMIN_TOKEN?.trim();
  if (!expected || !/^[A-Za-z0-9_-]{24,256}$/.test(expected)) throw new DiscussionError("SETUP_REQUIRED", "请在项目 .env 配置至少 24 位的 DISCUSSION_ADMIN_TOKEN 并重启，再输入该管理口令。外部 Agent 只使用各自邀请令牌。", 503);
  const actual = bearer(request);
  if (!timingSafeEqual(Buffer.from(hash(actual)), Buffer.from(hash(expected)))) throw new DiscussionError("UNAUTHORIZED", "管理口令不正确；参与者令牌不能管理讨论室", 401);
}
export function discussionSkill() {
  const content = readFileSync(join(process.cwd(), "resources/discussion-room-participant/SKILL.md"), "utf8");
  return { content, hash: hash(content) };
}
export async function checkPublicText(text: string, direction: "input" | "output") {
  const safety = await getSafetySettings();
  const rule = direction === "input" ? safety.inputGuardrail : safety.outputGuardrail;
  if (rule.enabled && findBlockedTerm(text, rule.blockedTerms)) throw new DiscussionError("GUARDRAIL", "公开文本触发安全围栏，请调整内容后再提交", 422);
}
export async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new DiscussionError("BAD_INPUT", "请求内容为空", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
      if (size > 128000) { await reader.cancel(); throw new DiscussionError("TOO_LARGE", "请求超过 128 KB", 413); } chunks.push(chunk.value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { if (error instanceof DiscussionError) throw error; throw new DiscussionError("BAD_INPUT", "请求必须是有效 JSON", 400); }
  finally { reader.releaseLock(); }
}
export function failure(error: unknown) {
  if (error instanceof DiscussionError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  return Response.json({ error: "请求失败，请检查字段或稍后重试", code: "BAD_INPUT" }, { status: 400 });
}
