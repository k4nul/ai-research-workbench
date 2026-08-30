import { z } from "zod";
import { routeErrorResponse } from "@/lib/http";
import {
  generateArtifact,
  type ExportFormat
} from "@/lib/export/generate";

type Context = {
  params: Promise<{ projectId: string; format: string }>;
};

const formatSchema = z.enum(["markdown", "html", "pdf", "docx", "csv", "zip"]);

export async function GET(request: Request, context: Context) {
  try {
    const { projectId, format: rawFormat } = await context.params;
    const parsed = formatSchema.parse(rawFormat.toLowerCase());
    const format = parsed.toUpperCase() as ExportFormat;
    const persist = new URL(request.url).searchParams.get("persist") === "true";
    const artifact = await generateArtifact(projectId, format, { persist });
    const body = new Uint8Array(artifact.buffer.byteLength);
    body.set(artifact.buffer);
    return new Response(body, {
      headers: {
        "Content-Type": artifact.mimeType,
        "Content-Disposition": 'attachment; filename="' + artifact.filename + '"',
        "Content-Length": String(artifact.buffer.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
