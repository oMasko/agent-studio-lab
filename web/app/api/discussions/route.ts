import { requireAdmin, readBody, failure, checkPublicText } from "@/lib/discussion-access";
import { createRoom, listRooms } from "@/lib/discussion-hub";
import { createSchema } from "@/lib/discussion-hub-schema";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { requireAdmin(request); return Response.json({ rooms: listRooms() }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    requireAdmin(request); const input = createSchema.parse(await readBody(request));
    await checkPublicText(JSON.stringify(input), "input");
    return Response.json({ room: createRoom(input) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  }
  catch (error) { return failure(error); }
}
