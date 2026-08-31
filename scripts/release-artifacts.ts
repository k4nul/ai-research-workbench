import "dotenv/config";

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { closePool, query } from "../lib/db.js";
import { JOB_ERROR_CLASSES, JOB_STATUSES } from "../lib/domain/jobs.js";
import {
  RESEARCH_RUN_STATUSES,
  RUN_STAGE_STATUSES
} from "../lib/domain/research-runs.js";
import {
  generateArtifact,
  loadExportData
} from "../lib/export/generate.js";
import { renderSourcesCsv } from "../lib/export/render.js";
import {
  PIPELINE_STAGE_CATALOG,
  RESEARCH_PIPELINE_VERSION
} from "../lib/execution/stages.js";

const RELEASE_VERSION = "0.2.0";
const RELEASE_TAG = `v${RELEASE_VERSION}`;
const DEMO_PROJECT_ID = "project-demo";
const RELEASE_ROOT = path.resolve(process.cwd(), ".artifacts", "release");
const OUTPUT_DIRECTORY = path.join(RELEASE_ROOT, RELEASE_TAG);

type JobColumn = {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  ordinal_position: number;
};

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function packageVersion(): Promise<string> {
  const raw = await readFile(path.resolve(process.cwd(), "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (parsed.version !== RELEASE_VERSION) {
    throw new Error(
      `package.json version must be ${RELEASE_VERSION}; received ${String(parsed.version)}.`
    );
  }
  return parsed.version;
}

async function configurationSchema(version: string): Promise<unknown> {
  const contents = await readFile(path.resolve(process.cwd(), ".env.example"), "utf8");
  const variables = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const separator = line.indexOf("=");
      const name = line.slice(0, separator);
      const rawExample = line.slice(separator + 1);
      const sensitive = /(?:API_KEY|ACCESS_KEY|PASSWORD|SECRET|SESSION_SECRET)/u.test(name);
      return {
        name,
        sensitive,
        example: sensitive ? null : rawExample || null
      };
    });
  const names = new Set(variables.map((variable) => variable.name));
  if (names.size !== variables.length) {
    throw new Error(".env.example contains duplicate variable names.");
  }
  return {
    schemaVersion: "configuration-schema.v1",
    applicationVersion: version,
    source: ".env.example",
    productionRequirements: {
      authenticationEnabled: true,
      demoBypassAllowed: false,
      secureCookies: true,
      sessionSecretMinimumCharacters: 32,
      malwareScanner: "clamav",
      malwareFailClosed: true
    },
    variables
  };
}

async function jobSchema(version: string): Promise<unknown> {
  const result = await query<JobColumn>(
    "SELECT column_name, data_type, udt_name, is_nullable, column_default," +
      " ordinal_position FROM information_schema.columns" +
      " WHERE table_schema = current_schema() AND table_name = 'jobs'" +
      " ORDER BY ordinal_position"
  );
  if (result.rows.length === 0) {
    throw new Error("The jobs table is missing. Run migrations before preparing release assets.");
  }
  return {
    schemaVersion: "durable-job-schema.v1",
    applicationVersion: version,
    authoritativeQueue: "PostgreSQL",
    deliverySemantics: "at-least-once",
    exactlyOnceExecution: false,
    idempotentDomainCommitRequired: true,
    statuses: JOB_STATUSES,
    errorClasses: JOB_ERROR_CLASSES,
    researchRunStatuses: RESEARCH_RUN_STATUSES,
    runStageStatuses: RUN_STAGE_STATUSES,
    columns: result.rows.map((column) => ({
      name: column.column_name,
      dataType: column.data_type,
      databaseType: column.udt_name,
      nullable: column.is_nullable === "YES",
      default: column.column_default
    }))
  };
}

function pipelineSchema(version: string): unknown {
  return {
    schemaVersion: "research-pipeline-schema.v1",
    applicationVersion: version,
    pipelineVersion: RESEARCH_PIPELINE_VERSION,
    stageCount: PIPELINE_STAGE_CATALOG.length,
    finalHumanApprovalRequired: true,
    stages: PIPELINE_STAGE_CATALOG
  };
}

async function sanitizedEvidenceBundle(version: string): Promise<unknown> {
  const data = await loadExportData(DEMO_PROJECT_ID);
  if (!data.project.is_sample) {
    throw new Error("Release evidence can only be generated from the synthetic demo project.");
  }
  return {
    schemaVersion: "sanitized-evidence-bundle.v1",
    applicationVersion: version,
    syntheticFixture: true,
    releasePreview: true,
    finalDelivery: false,
    humanApprovalRecorded: false,
    disclaimer: "Synthetic demonstration data; not a real-world factual research result.",
    project: {
      id: data.project.id,
      name: data.project.name,
      coreQuestion: data.project.core_question,
      researchDate: data.project.research_date
    },
    sources: data.sources.map((source) => ({
      id: source.id,
      title: source.title,
      publisher: source.publisher,
      publishedAt: source.published_at,
      accessedAt: source.accessed_at,
      sourceType: source.source_type,
      reliabilityGrade: source.reliability_grade,
      freshnessStatus: source.freshness_status
    })),
    claims: data.claims.map((claim) => ({
      id: claim.id,
      content: claim.content,
      claimType: claim.claim_type,
      importance: claim.importance,
      supportStatus: claim.support_status,
      factOrInference: claim.fact_or_inference,
      citations: claim.linked_evidence.map((evidence) => ({
        evidenceId: evidence.evidenceId,
        sourceId: evidence.sourceId,
        relationship: evidence.relationship,
        supportExtent: evidence.supportExtent,
        summary: evidence.summary,
        minimalQuote: evidence.quote
      }))
    }))
  };
}

async function syntheticReleasePreview(): Promise<{
  pdf: Buffer;
  docx: Buffer;
  deliveryZip: Buffer;
}> {
  const data = await loadExportData(DEMO_PROJECT_ID);
  const fixtureState = await query<{
    status: string;
    approval_status: string;
    approved_at: string | null;
    approval_events: number;
    final_exports: number;
  }>(
    `SELECT p.status, p.approval_status, p.approved_at::text,
       (SELECT COUNT(*)::integer FROM audit_events ae
          WHERE ae.project_id = p.id AND ae.action = 'PROJECT_APPROVED') AS approval_events,
       (SELECT COUNT(*)::integer FROM project_exports pe
          WHERE pe.project_id = p.id AND pe.format = 'ZIP') AS final_exports
     FROM research_projects p WHERE p.id = $1`,
    [DEMO_PROJECT_ID]
  );
  const state = fixtureState.rows[0];
  if (
    !data.project.is_sample ||
    !state ||
    state.status !== "APPROVAL_REQUIRED" ||
    state.approval_status !== "PENDING" ||
    state.approved_at !== null ||
    state.approval_events !== 0 ||
    state.final_exports !== 0
  ) {
    throw new Error(
      "Release samples require the unapproved synthetic fixture; automation must not create or claim human approval."
    );
  }

  const [markdown, html, pdf, docx, ledger] = await Promise.all([
    generateArtifact(DEMO_PROJECT_ID, "MARKDOWN"),
    generateArtifact(DEMO_PROJECT_ID, "HTML"),
    generateArtifact(DEMO_PROJECT_ID, "PDF"),
    generateArtifact(DEMO_PROJECT_ID, "DOCX"),
    generateArtifact(DEMO_PROJECT_ID, "CSV")
  ]);
  const metadata = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: data.project,
    deliverable: {
      id: data.deliverable.id,
      version: data.deliverable.version,
      title: data.deliverable.title
    },
    fixture: true,
    releasePreview: true,
    finalDelivery: false,
    humanApprovalRecorded: false,
    approvalStatus: state.approval_status
  };
  const readme = [
    "AI Research Workbench synthetic release preview",
    "",
    "IMPORTANT: This is not a final delivery package and records no human approval.",
    "It contains only synthetic SAMPLE fixtures for release-format verification.",
    "Production delivery remains blocked until a named human approves a blocker-free project.",
    "",
    "The final-report filenames mirror the production package layout only for parser testing.",
    "sources.csv records publication and access dates separately.",
    "claim-evidence-ledger.csv maps claims to synthetic fixture evidence.",
    "project-metadata.json records the unapproved release-preview state."
  ].join("\n");
  const archive = new JSZip();
  archive.file("final-report.md", markdown.buffer);
  archive.file("final-report.html", html.buffer);
  archive.file("final-report.pdf", pdf.buffer);
  archive.file("final-report.docx", docx.buffer);
  archive.file("sources.csv", renderSourcesCsv(data.sources));
  archive.file("claim-evidence-ledger.csv", ledger.buffer);
  archive.file("qa-findings.json", JSON.stringify(data.qaFindings, null, 2));
  archive.file("project-metadata.json", JSON.stringify(metadata, null, 2));
  archive.file("README.txt", readme);
  const deliveryZip = await archive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 }
  });
  return { pdf: pdf.buffer, docx: docx.buffer, deliveryZip };
}

async function copyRequiredFile(source: string, targetName: string): Promise<void> {
  const absoluteSource = path.resolve(process.cwd(), source);
  await copyFile(absoluteSource, path.join(OUTPUT_DIRECTORY, targetName));
}

async function writeChecksums(): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const filenames = (await readdir(OUTPUT_DIRECTORY))
    .filter((filename) => filename !== "SHA256SUMS")
    .sort();
  const lines: string[] = [];
  for (const filename of filenames) {
    const bytes = await readFile(path.join(OUTPUT_DIRECTORY, filename));
    lines.push(`${sha256(bytes)}  ${filename}`);
  }
  await writeFile(path.join(OUTPUT_DIRECTORY, "SHA256SUMS"), lines.join("\n") + "\n", {
    mode: 0o600
  });
}

async function main(): Promise<void> {
  const version = await packageVersion();
  if (!OUTPUT_DIRECTORY.startsWith(RELEASE_ROOT + path.sep)) {
    throw new Error("Release output escaped the expected artifact directory.");
  }
  await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
  await mkdir(OUTPUT_DIRECTORY, { recursive: true, mode: 0o700 });

  const [configuration, jobs, evidence, preview] = await Promise.all([
    configurationSchema(version),
    jobSchema(version),
    sanitizedEvidenceBundle(version),
    syntheticReleasePreview()
  ]);

  await Promise.all([
    copyRequiredFile("CHANGELOG.md", "CHANGELOG.md"),
    copyRequiredFile("docs/MIGRATING_FROM_V0_1.md", "MIGRATION_GUIDE.md"),
    copyRequiredFile(".artifacts/evals/mock/eval-summary.json", "eval-summary.json"),
    copyRequiredFile(".artifacts/evals/mock/eval-summary.md", "eval-summary.md"),
    writeFile(path.join(OUTPUT_DIRECTORY, "configuration-schema.json"), json(configuration), {
      mode: 0o600
    }),
    writeFile(path.join(OUTPUT_DIRECTORY, "job-schema.json"), json(jobs), { mode: 0o600 }),
    writeFile(
      path.join(OUTPUT_DIRECTORY, "pipeline-schema.json"),
      json(pipelineSchema(version)),
      { mode: 0o600 }
    ),
    writeFile(
      path.join(OUTPUT_DIRECTORY, "sample-evidence-bundle.json"),
      json(evidence),
      { mode: 0o600 }
    ),
    writeFile(path.join(OUTPUT_DIRECTORY, "sample-report.pdf"), preview.pdf, { mode: 0o600 }),
    writeFile(path.join(OUTPUT_DIRECTORY, "sample-report.docx"), preview.docx, { mode: 0o600 }),
    writeFile(path.join(OUTPUT_DIRECTORY, "sample-delivery.zip"), preview.deliveryZip, {
      mode: 0o600
    })
  ]);
  await writeChecksums();
  process.stdout.write(`Prepared ${RELEASE_TAG} assets in ${OUTPUT_DIRECTORY}\n`);
}

await main().finally(() => closePool());
