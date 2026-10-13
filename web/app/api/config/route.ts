import { NextResponse } from "next/server";

import { getPublicConfig } from "@/lib/agent";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getPublicConfig());
  } catch (error) {
    console.error("Unable to load Agent config", error);
    return NextResponse.json({ error: "无法加载模型配置。" }, { status: 500 });
  }
}
