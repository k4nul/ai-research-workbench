import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    await query("SELECT 1");
    return NextResponse.json(
      {
        status: "ok",
        database: "connected",
        mode: getConfig().demoMode ? "demo" : "live"
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      { status: "degraded", database: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
