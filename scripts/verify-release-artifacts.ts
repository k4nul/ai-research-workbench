import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

const RELEASE_VERSION = "0.2.0";
const DEFAULT_DIRECTORY = path.resolve(
  process.cwd(),
  ".artifacts",
  "release",
  `v${RELEASE_VERSION}`
);
export const REQUIRED_RELEASE_FILES = [
  "CHANGELOG.md",
  "MIGRATION_GUIDE.md",
  "configuration-schema.json",
  "job-schema.json",
  "pipeline-schema.json",
  "eval-summary.json",
  "eval-summary.md",
  "sample-evidence-bundle.json",
  "sample-report.pdf",
  "sample-report.docx",
  "sample-delivery.zip",
  "SHA256SUMS"
] as const;
export const REQUIRED_CONFIGURATION_VARIABLES = [
  "DATABASE_URL",
  "DATABASE_POOL_SIZE",
  "TEST_DATABASE_URL",
  "DEMO_MODE",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "BRAVE_SEARCH_API_KEY",
  "APP_URL",
  "APP_BIND_HOST",
  "WORKER_ID",
  "SERVICE_VERSION",
  "WORKER_CONCURRENCY",
  "WORKER_POLL_INTERVAL_MS",
  "WORKER_SHUTDOWN_GRACE_MS",
  "JOB_LEASE_DURATION_MS",
  "JOB_HEARTBEAT_INTERVAL_MS",
  "JOB_DEFAULT_TIMEOUT_MS",
  "JOB_MAX_ATTEMPTS",
  "PROVIDER_CONCURRENCY",
  "PROVIDER_REQUEST_LIMIT",
  "PROVIDER_REQUEST_WINDOW_SECONDS",
  "DOCUMENT_EXTRACTION_CONCURRENCY",
  "PDF_FONT_PATH",
  "PDF_FONT_NAME",
  "MAX_UPLOAD_BYTES",
  "MAX_FETCH_BYTES",
  "FETCH_TIMEOUT_MS",
  "STORAGE_PROVIDER",
  "STORAGE_DIR",
  "STORAGE_MAX_OBJECT_BYTES",
  "STORAGE_SIGNED_URL_TTL_SECONDS",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_FORCE_PATH_STYLE",
  "MALWARE_SCANNER_PROVIDER",
  "CLAMAV_HOST",
  "CLAMAV_PORT",
  "MALWARE_SCAN_TIMEOUT_MS",
  "MALWARE_MAX_FILE_BYTES",
  "MALWARE_REQUIRED",
  "MALWARE_ALLOW_DEMO_BYPASS",
  "AUTH_ENABLED",
  "AUTH_SESSION_SECRET",
  "AUTH_SESSION_TTL_SECONDS",
  "AUTH_COOKIE_SECURE",
  "AUTH_DEMO_BYPASS",
  "AUTH_LOGIN_MAX_ATTEMPTS",
  "AUTH_LOGIN_WINDOW_SECONDS",
  "AUTH_LOGIN_BLOCK_SECONDS",
  "MODEL_PRICING_JSON"
] as const;
const REQUIRED_DELIVERY_FILES = [
  "final-report.md",
  "final-report.html",
  "final-report.pdf",
  "final-report.docx",
  "sources.csv",
  "claim-evidence-ledger.csv",
  "qa-findings.json",
  "project-metadata.json",
  "README.txt"
] as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJson<T>(bytes: Buffer, filename: string): T {
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch (error) {
    throw new Error(`${filename} is not valid JSON.`, { cause: error });
  }
}

type XmlRecord = Record<string, unknown>;

function xmlRecord(value: unknown): XmlRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as XmlRecord)
    : undefined;
}

function xmlRecords(value: unknown): XmlRecord[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(xmlRecord).filter((item): item is XmlRecord => item !== undefined);
}

async function requiredDocxXml(
  archive: JSZip,
  partName: string,
  label: string
): Promise<XmlRecord> {
  const entry = archive.file(partName);
  if (!entry) {
    throw new Error(`${label} is missing required OPC part ${partName}.`);
  }
  const xml = await entry.async("string");
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error(`${label} contains invalid XML in ${partName}.`);
  }
  try {
    return new XMLParser({ ignoreAttributes: false, removeNSPrefix: true }).parse(
      xml
    ) as XmlRecord;
  } catch (error) {
    throw new Error(`${label} contains unreadable XML in ${partName}.`, { cause: error });
  }
}

async function verifyDocx(bytes: Uint8Array, label: string): Promise<void> {
  const archive = await JSZip.loadAsync(bytes);
  const [contentTypes, relationships, document] = await Promise.all([
    requiredDocxXml(archive, "[Content_Types].xml", label),
    requiredDocxXml(archive, "_rels/.rels", label),
    requiredDocxXml(archive, "word/document.xml", label)
  ]);
  const overrides = xmlRecords(xmlRecord(contentTypes.Types)?.Override);
  if (
    !overrides.some(
      (override) =>
        override["@_PartName"] === "/word/document.xml" &&
        override["@_ContentType"] ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
    )
  ) {
    throw new Error(`${label} does not declare the main WordprocessingML document part.`);
  }
  const rootRelationships = xmlRecords(
    xmlRecord(relationships.Relationships)?.Relationship
  );
  if (
    !rootRelationships.some((relationship) => {
      const type = relationship["@_Type"];
      const target = relationship["@_Target"];
      return (
        typeof type === "string" &&
        type.endsWith("/officeDocument") &&
        typeof target === "string" &&
        target.replace(/^\/+/, "") === "word/document.xml" &&
        relationship["@_TargetMode"] !== "External"
      );
    })
  ) {
    throw new Error(`${label} has no internal package relationship to word/document.xml.`);
  }
  const documentRoot = xmlRecord(document.document);
  if (!documentRoot || !Object.hasOwn(documentRoot, "body")) {
    throw new Error(`${label} has no readable WordprocessingML document body.`);
  }
}

export async function verifyReleaseFileSet(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nonFiles = entries.filter((entry) => !entry.isFile()).map((entry) => entry.name).sort();
  if (nonFiles.length > 0) {
    throw new Error(`Release directory contains non-file entries: ${nonFiles.join(", ")}.`);
  }
  const files = new Set(entries.map((entry) => entry.name));
  const required = new Set<string>(REQUIRED_RELEASE_FILES);
  const unexpected = [...files].filter((filename) => !required.has(filename)).sort();
  if (unexpected.length > 0) {
    throw new Error(`Unexpected release assets: ${unexpected.join(", ")}.`);
  }
  const missing = [...required].filter((filename) => !files.has(filename));
  if (missing.length > 0) {
    throw new Error(`Required release assets are missing: ${missing.join(", ")}.`);
  }
}

export async function verifyChecksums(directory: string): Promise<number> {
  const contents = await readFile(path.join(directory, "SHA256SUMS"), "utf8");
  const lines = contents.trim().split(/\r?\n/u).filter(Boolean);
  const expected = new Set<string>(
    REQUIRED_RELEASE_FILES.filter((filename) => filename !== "SHA256SUMS")
  );
  const required = new Set(expected);
  const seen = new Set<string>();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([^/]+)$/u.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS entry: ${line}`);
    const [, digest, filename] = match;
    if (seen.has(filename)) {
      throw new Error(`SHA256SUMS contains a duplicate entry for ${filename}.`);
    }
    if (!required.has(filename)) {
      throw new Error(`SHA256SUMS contains an unexpected entry for ${filename}.`);
    }
    seen.add(filename);
    const bytes = await readFile(path.join(directory, filename));
    if (sha256(bytes) !== digest) throw new Error(`Checksum mismatch for ${filename}.`);
    expected.delete(filename);
  }
  if (expected.size > 0) {
    throw new Error(`SHA256SUMS is missing: ${[...expected].join(", ")}.`);
  }
  return lines.length;
}

type ReleaseConfiguration = {
  schemaVersion?: unknown;
  applicationVersion?: unknown;
  productionRequirements?: {
    authenticationEnabled?: unknown;
    demoBypassAllowed?: unknown;
    secureCookies?: unknown;
    sessionSecretMinimumCharacters?: unknown;
    malwareScanner?: unknown;
    malwareFailClosed?: unknown;
  };
  variables?: Array<{ name?: unknown }>;
};

type ReleaseEvaluation = {
  schemaVersion?: unknown;
  executionMode?: unknown;
  repetitionsPerFixture?: unknown;
  evaluatedRunCount?: unknown;
  passed?: unknown;
  metrics?: {
    pipelineStageCompletion?: unknown;
    providerRequestCompleteness?: unknown;
    deterministicHashMismatchCount?: unknown;
  };
  fixtureResults?: Array<{
    fixtureId?: unknown;
    primaryRunId?: unknown;
    repeatRunId?: unknown;
    outputHash?: unknown;
    repeatOutputHash?: unknown;
    reproducible?: unknown;
  }>;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function verifyConfigurationSchema(configuration: ReleaseConfiguration): void {
  if (
    configuration.schemaVersion !== "configuration-schema.v1" ||
    configuration.applicationVersion !== RELEASE_VERSION
  ) {
    throw new Error("Configuration schema version is invalid.");
  }
  const requirements = configuration.productionRequirements;
  if (
    requirements?.authenticationEnabled !== true ||
    requirements.demoBypassAllowed !== false ||
    requirements.secureCookies !== true ||
    requirements.sessionSecretMinimumCharacters !== 32 ||
    requirements.malwareScanner !== "clamav" ||
    requirements.malwareFailClosed !== true
  ) {
    throw new Error("Configuration production requirements are invalid.");
  }
  if (
    !Array.isArray(configuration.variables) ||
    configuration.variables.some(
      (variable) => typeof variable.name !== "string" || variable.name.length === 0
    )
  ) {
    throw new Error("Configuration variable inventory is invalid.");
  }
  const names = configuration.variables.map((variable) => variable.name as string);
  const actual = new Set(names);
  const required = new Set<string>(REQUIRED_CONFIGURATION_VARIABLES);
  const missing = [...required].filter((name) => !actual.has(name));
  const unexpected = [...actual].filter((name) => !required.has(name));
  if (actual.size !== names.length || missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      "Configuration variable inventory is invalid: " +
        `missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}].`
    );
  }
}

export function verifyEvaluationSummary(evaluation: ReleaseEvaluation): void {
  const fixtureResults = evaluation.fixtureResults;
  const fixtureIds = fixtureResults?.map((fixture) => fixture.fixtureId) ?? [];
  const runIds =
    fixtureResults?.flatMap((fixture) => [fixture.primaryRunId, fixture.repeatRunId]) ?? [];
  if (
    evaluation.schemaVersion !== "research-eval-v2" ||
    evaluation.executionMode !== "durable-postgresql-orchestration" ||
    evaluation.repetitionsPerFixture !== 2 ||
    evaluation.evaluatedRunCount !== 20 ||
    evaluation.passed !== true ||
    evaluation.metrics?.pipelineStageCompletion !== 1 ||
    evaluation.metrics.providerRequestCompleteness !== 1 ||
    evaluation.metrics.deterministicHashMismatchCount !== 0 ||
    fixtureResults?.length !== 10 ||
    fixtureIds.some((fixtureId) => typeof fixtureId !== "string" || !fixtureId.trim()) ||
    new Set(fixtureIds).size !== 10 ||
    runIds.some((runId) => typeof runId !== "string" || !UUID_PATTERN.test(runId)) ||
    new Set(runIds).size !== 20 ||
    fixtureResults.some(
      (fixture) =>
        typeof fixture.outputHash !== "string" ||
        !SHA256_PATTERN.test(fixture.outputHash) ||
        typeof fixture.repeatOutputHash !== "string" ||
        !SHA256_PATTERN.test(fixture.repeatOutputHash) ||
        fixture.repeatOutputHash !== fixture.outputHash ||
        fixture.reproducible !== true
    )
  ) {
    throw new Error(
      "Mock evaluation is not backed by 20 reproducible, complete PostgreSQL pipeline runs."
    );
  }
}

export async function verifyReleaseArtifacts(directory: string): Promise<void> {
  await verifyReleaseFileSet(directory);
  const checksumCount = await verifyChecksums(directory);

  const configuration = parseJson<ReleaseConfiguration>(
    await readFile(path.join(directory, "configuration-schema.json")),
    "configuration-schema.json"
  );
  verifyConfigurationSchema(configuration);

  const job = parseJson<{
    applicationVersion?: unknown;
    deliverySemantics?: unknown;
    exactlyOnceExecution?: unknown;
    statuses?: unknown[];
    columns?: Array<{ name?: unknown }>;
  }>(await readFile(path.join(directory, "job-schema.json")), "job-schema.json");
  if (
    job.applicationVersion !== RELEASE_VERSION ||
    job.deliverySemantics !== "at-least-once" ||
    job.exactlyOnceExecution !== false ||
    !job.statuses?.includes("DEAD_LETTER") ||
    !job.columns?.some((column) => column.name === "lease_owner") ||
    !job.columns.some((column) => column.name === "idempotency_key")
  ) {
    throw new Error("Durable job schema contract is invalid.");
  }

  const pipeline = parseJson<{
    applicationVersion?: unknown;
    stageCount?: unknown;
    finalHumanApprovalRequired?: unknown;
    stages?: Array<{ id?: unknown; ordinal?: unknown }>;
  }>(await readFile(path.join(directory, "pipeline-schema.json")), "pipeline-schema.json");
  if (
    pipeline.applicationVersion !== RELEASE_VERSION ||
    pipeline.stageCount !== 11 ||
    pipeline.finalHumanApprovalRequired !== true ||
    pipeline.stages?.length !== 11 ||
    new Set(pipeline.stages.map((stage) => stage.id)).size !== 11 ||
    new Set(pipeline.stages.map((stage) => stage.ordinal)).size !== 11
  ) {
    throw new Error("Pipeline schema does not contain 11 unique approval-gated stages.");
  }

  const evaluation = parseJson<ReleaseEvaluation>(
    await readFile(path.join(directory, "eval-summary.json")),
    "eval-summary.json"
  );
  verifyEvaluationSummary(evaluation);

  const evidence = parseJson<{
    syntheticFixture?: unknown;
    releasePreview?: unknown;
    finalDelivery?: unknown;
    humanApprovalRecorded?: unknown;
    claims?: unknown[];
  }>(
    await readFile(path.join(directory, "sample-evidence-bundle.json")),
    "sample-evidence-bundle.json"
  );
  if (
    evidence.syntheticFixture !== true ||
    evidence.releasePreview !== true ||
    evidence.finalDelivery !== false ||
    evidence.humanApprovalRecorded !== false ||
    !evidence.claims?.length
  ) {
    throw new Error("Sanitized evidence bundle is not a populated synthetic fixture.");
  }

  const pdfBytes = await readFile(path.join(directory, "sample-report.pdf"));
  if ((await PDFDocument.load(pdfBytes)).getPageCount() < 1) {
    throw new Error("Sample PDF has no pages.");
  }
  await verifyDocx(await readFile(path.join(directory, "sample-report.docx")), "Sample DOCX");

  const delivery = await JSZip.loadAsync(
    await readFile(path.join(directory, "sample-delivery.zip"))
  );
  const deliveryEntries = Object.values(delivery.files);
  const deliveryDirectories = deliveryEntries
    .filter((entry) => entry.dir)
    .map((entry) => entry.name)
    .sort();
  if (deliveryDirectories.length > 0) {
    throw new Error(
      `Delivery ZIP contains directory entries: ${deliveryDirectories.join(", ")}.`
    );
  }
  const deliveryFiles = new Set(deliveryEntries.map((entry) => entry.name));
  const requiredDeliveryFiles = new Set<string>(REQUIRED_DELIVERY_FILES);
  const missingDeliveryFiles = [...requiredDeliveryFiles].filter(
    (filename) => !deliveryFiles.has(filename)
  );
  const unexpectedDeliveryFiles = [...deliveryFiles].filter(
    (filename) => !requiredDeliveryFiles.has(filename)
  );
  if (missingDeliveryFiles.length > 0 || unexpectedDeliveryFiles.length > 0) {
    throw new Error(
      "Delivery ZIP file set is invalid: " +
        `missing [${missingDeliveryFiles.join(", ")}], ` +
        `unexpected [${unexpectedDeliveryFiles.join(", ")}].`
    );
  }
  const packagedPdf = await delivery.file("final-report.pdf")!.async("uint8array");
  if ((await PDFDocument.load(packagedPdf)).getPageCount() < 1) {
    throw new Error("Packaged PDF has no pages.");
  }
  if (sha256(packagedPdf) !== sha256(pdfBytes)) {
    throw new Error("Packaged PDF differs from the top-level sample PDF.");
  }
  const topLevelDocx = await readFile(path.join(directory, "sample-report.docx"));
  const packagedDocx = await delivery.file("final-report.docx")!.async("uint8array");
  await verifyDocx(packagedDocx, "Packaged DOCX");
  if (sha256(packagedDocx) !== sha256(topLevelDocx)) {
    throw new Error("Packaged DOCX differs from the top-level sample DOCX.");
  }
  const metadata = parseJson<{
    fixture?: unknown;
    releasePreview?: unknown;
    finalDelivery?: unknown;
    humanApprovalRecorded?: unknown;
    approvalStatus?: unknown;
  }>(
    Buffer.from(await delivery.file("project-metadata.json")!.async("uint8array")),
    "project-metadata.json"
  );
  if (
    metadata.fixture !== true ||
    metadata.releasePreview !== true ||
    metadata.finalDelivery !== false ||
    metadata.humanApprovalRecorded !== false ||
    metadata.approvalStatus !== "PENDING"
  ) {
    throw new Error(
      "Delivery ZIP is not marked as an unapproved synthetic release preview."
    );
  }
  const previewReadme = await delivery.file("README.txt")!.async("string");
  if (
    !previewReadme.includes("not a final delivery package") ||
    !previewReadme.includes("records no human approval")
  ) {
    throw new Error("Delivery ZIP does not disclose its unapproved preview status.");
  }
  for (const filename of [
    "final-report.md",
    "final-report.html",
    "sources.csv",
    "claim-evidence-ledger.csv"
  ]) {
    if ((await delivery.file(filename)!.async("string")).trim().length === 0) {
      throw new Error(`Delivery ZIP contains an empty ${filename}.`);
    }
  }
  const packagedQa = parseJson<unknown>(
    Buffer.from(await delivery.file("qa-findings.json")!.async("uint8array")),
    "qa-findings.json"
  );
  if (!Array.isArray(packagedQa)) {
    throw new Error("qa-findings.json must contain an array.");
  }

  const changelog = await readFile(path.join(directory, "CHANGELOG.md"), "utf8");
  const migration = await readFile(path.join(directory, "MIGRATION_GUIDE.md"), "utf8");
  if (!changelog.includes(RELEASE_VERSION) || !migration.includes("v0.1")) {
    throw new Error("Release notes do not describe v0.2.0 and migration from v0.1.");
  }
  process.stdout.write(
    `PASSED: ${REQUIRED_RELEASE_FILES.length} required assets, ${checksumCount} checksums, PDF/DOCX/ZIP/JSON parsed.\n`
  );
}

async function main(): Promise<void> {
  const requested = process.argv[2];
  await verifyReleaseArtifacts(path.resolve(requested ?? DEFAULT_DIRECTORY));
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
