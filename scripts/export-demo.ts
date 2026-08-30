import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateArtifact, type ExportFormat } from "../lib/export/generate";
import { runApprovalAction } from "../lib/services/approval";
import { closePool } from "../lib/db";

const projectId = "project-demo";
const outputDirectory = path.resolve(process.cwd(), "exports", "demo");
const approve = process.argv.includes("--approve");

async function exportDemo(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const formats: ExportFormat[] = ["MARKDOWN", "HTML", "PDF", "DOCX", "CSV"];
  if (approve) {
    await runApprovalAction(projectId, "request");
    await runApprovalAction(projectId, "approve", true);
    formats.push("ZIP");
  }
  for (const format of formats) {
    const artifact = await generateArtifact(projectId, format, {
      persist: format === "ZIP"
    });
    const target = path.join(outputDirectory, artifact.filename);
    await writeFile(target, artifact.buffer);
    process.stdout.write(
      format + " " + artifact.buffer.byteLength + " bytes -> " + target + "\n"
    );
  }
  if (!approve) {
    process.stdout.write(
      "Final ZIP skipped: rerun with --approve to record explicit demo approval and create it.\n"
    );
  }
}

exportDemo()
  .catch((error: unknown) => {
    process.stderr.write(
      "Demo export failed: " +
        (error instanceof Error ? error.message : "Unknown error") +
        "\n"
    );
    process.exitCode = 1;
  })
  .finally(() => closePool());
