import { NextResponse } from "next/server";

import { getTrace } from "@/lib/trace-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const trace = await getTrace(id);
  if (!trace) return NextResponse.json({ error: "Trace 不存在。" }, { status: 404 });
  return NextResponse.json({ trace });
}
