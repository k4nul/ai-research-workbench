import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { validateAuthRuntime } from "@/lib/auth/runtime";
import { getDocumentRuntime } from "@/lib/documents/runtime";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const config = getConfig();
    const auth = validateAuthRuntime();
    const runtime = getDocumentRuntime();
    const [database, objectStorage] = await Promise.allSettled([
      query("SELECT 1"),
      runtime.storage.list("debug/health")
    ]);
    const healthy = database.status === "fulfilled" && objectStorage.status === "fulfilled";
    return NextResponse.json(
      {
        status: healthy ? "ok" : "degraded",
        database: database.status === "fulfilled" ? "connected" : "unavailable",
        objectStorage:
          objectStorage.status === "fulfilled" ? "connected" : "unavailable",
        storageProvider: runtime.storage.provider,
        auth: auth.demoAuthBypass ? "bypassed-local" : "configured",
        mode: config.demoMode ? "demo" : "live"
      },
      {
        status: healthy ? 200 : 503,
        headers: { "Cache-Control": "no-store" }
      }
    );
  } catch {
    return NextResponse.json(
      {
        status: "degraded",
        database: "unknown",
        objectStorage: "unknown",
        auth: "invalid",
        mode: "unknown"
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
