import { bearer, readBody, failure, DiscussionError, hash, checkPublicText } from "@/lib/discussion-access";
import { connectSchema } from "@/lib/discussion-hub-schema";
import { connectRoom } from "@/lib/discussion-hub";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const state = globalThis as typeof globalThis & { __discussionPolls?: Set<string> };
const polls = state.__discussionPolls ??= new Set();
export async function POST(request: Request) {
  let lock: string | undefined;
  try {
    const token = bearer(request);
    const input = connectSchema.parse(await readBody(request));
    if (input.action === "submit") await checkPublicText(input.content, "output");
    let data = connectRoom(token, input);
    if (input.action === "poll" && input.waitSeconds > 0 && "task" in data && !data.task && ["lobby", "running", "paused"].includes(data.status)) {
      const key = hash(token);
      if (polls.has(key) || polls.size >= 64) throw new DiscussionError("BUSY", "已有等待请求，请勿并发轮询", 429);
      lock = key; polls.add(key);
      const deadline = Date.now() + input.waitSeconds * 1000;
      const initialStatus = data.status;
      while (Date.now() < deadline && !request.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
        if (request.signal.aborted) break;
        // Re-authenticate each time: revocation takes effect during a long poll.
        data = connectRoom(token, input);
        if (("task" in data && data.task) || data.status !== initialStatus) break;
      }
    }
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
  finally { if (lock) polls.delete(lock); }
}
