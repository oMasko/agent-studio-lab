import { requireAdmin, readBody, failure, checkPublicText } from "@/lib/discussion-access";
import { getRoom, manageRoom } from "@/lib/discussion-hub";
import { actionSchema } from "@/lib/discussion-hub-schema";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try { requireAdmin(request); return Response.json({ room: getRoom((await context.params).id) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return failure(error); }
}
export async function PATCH(request: Request, context: Context) {
  try {
    requireAdmin(request); const action = actionSchema.parse(await readBody(request));
    if (action.action === "note") await checkPublicText(action.content, "input");
    return Response.json(manageRoom((await context.params).id, action), { headers: { "Cache-Control": "no-store" } });
  }
  catch (error) { return failure(error); }
}
