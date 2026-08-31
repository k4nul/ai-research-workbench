import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import {
  REQUIRED_CONFIGURATION_VARIABLES,
  REQUIRED_RELEASE_FILES,
  verifyReleaseArtifacts
} from "@/scripts/verify-release-artifacts";

const temporaryDirectories: string[] = [];

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function refreshChecksums(directory: string): Promise<void> {
  const lines: string[] = [];
  for (const filename of REQUIRED_RELEASE_FILES) {
    if (filename === "SHA256SUMS") continue;
    const bytes = await readFile(path.join(directory, filename));
    lines.push(`${sha256(bytes)}  ${filename}`);
  }
  await writeFile(path.join(directory, "SHA256SUMS"), lines.join("\n") + "\n");
}

async function validPdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.addPage([200, 200]);
  return Buffer.from(await document.save());
}

async function validDocx(): Promise<Buffer> {
  const archive = new JSZip();
  archive.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  archive.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  archive.file(
    "word/document.xml",
    '<?xml version="1.0"?><w:document xmlns:w="urn:fixture"><w:body/></w:document>'
  );
  return Buffer.from(await archive.generateAsync({ type: "uint8array" }));
}

async function documentXmlOnlyDocx(): Promise<Buffer> {
  const archive = new JSZip();
  archive.file(
    "word/document.xml",
    '<?xml version="1.0"?><w:document xmlns:w="urn:fixture"><w:body/></w:document>'
  );
  return Buffer.from(await archive.generateAsync({ type: "uint8array" }));
}

async function releasePreviewFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "release-preview-test-"));
  temporaryDirectories.push(directory);
  const pdf = await validPdf();
  const docx = await validDocx();
  const delivery = new JSZip();
  delivery.file("final-report.md", "# Synthetic preview\n");
  delivery.file("final-report.html", "<h1>Synthetic preview</h1>\n");
  delivery.file("final-report.pdf", pdf);
  delivery.file("final-report.docx", docx);
  delivery.file("sources.csv", "source_id,title\nsource-fixture,Synthetic source\n");
  delivery.file("claim-evidence-ledger.csv", "claim_id,evidence_id\nclaim-fixture,evidence-fixture\n");
  delivery.file("qa-findings.json", "[]\n");
  delivery.file(
    "project-metadata.json",
    json({
      fixture: true,
      releasePreview: true,
      finalDelivery: false,
      humanApprovalRecorded: false,
      approvalStatus: "PENDING"
    })
  );
  delivery.file(
    "README.txt",
    "Synthetic fixture: this is not a final delivery package and records no human approval.\n"
  );

  const stages = Array.from({ length: 11 }, (_, index) => ({
    id: `stage-${index + 1}`,
    ordinal: index + 1
  }));
  const fixtureIds = [
    "supported",
    "conflict",
    "stale",
    "numeric-units",
    "irrelevant",
    "prompt-injection",
    "insufficient",
    "partial-answer",
    "duplicate-source",
    "closed-corpus"
  ];
  const fixtureResults = fixtureIds.map((fixtureId, index) => ({
    fixtureId,
    primaryRunId: `00000000-0000-4000-8000-${(index * 2 + 1)
      .toString(16)
      .padStart(12, "0")}`,
    repeatRunId: `00000000-0000-4000-8000-${(index * 2 + 2)
      .toString(16)
      .padStart(12, "0")}`,
    outputHash: String(index).padStart(64, "0"),
    repeatOutputHash: String(index).padStart(64, "0"),
    reproducible: true
  }));
  await Promise.all([
    writeFile(path.join(directory, "CHANGELOG.md"), "# 0.2.0\n"),
    writeFile(path.join(directory, "MIGRATION_GUIDE.md"), "# Migration from v0.1\n"),
    writeFile(
      path.join(directory, "configuration-schema.json"),
      json({
        schemaVersion: "configuration-schema.v1",
        applicationVersion: "0.2.0",
        productionRequirements: {
          authenticationEnabled: true,
          demoBypassAllowed: false,
          secureCookies: true,
          sessionSecretMinimumCharacters: 32,
          malwareScanner: "clamav",
          malwareFailClosed: true
        },
        variables: REQUIRED_CONFIGURATION_VARIABLES.map((name) => ({ name }))
      })
    ),
    writeFile(
      path.join(directory, "job-schema.json"),
      json({
        applicationVersion: "0.2.0",
        deliverySemantics: "at-least-once",
        exactlyOnceExecution: false,
        statuses: ["DEAD_LETTER"],
        columns: [{ name: "lease_owner" }, { name: "idempotency_key" }]
      })
    ),
    writeFile(
      path.join(directory, "pipeline-schema.json"),
      json({
        applicationVersion: "0.2.0",
        stageCount: 11,
        finalHumanApprovalRequired: true,
        stages
      })
    ),
    writeFile(
      path.join(directory, "eval-summary.json"),
      json({
        schemaVersion: "research-eval-v2",
        executionMode: "durable-postgresql-orchestration",
        repetitionsPerFixture: 2,
        evaluatedRunCount: 20,
        passed: true,
        metrics: {
          pipelineStageCompletion: 1,
          providerRequestCompleteness: 1,
          deterministicHashMismatchCount: 0
        },
        fixtureResults
      })
    ),
    writeFile(path.join(directory, "eval-summary.md"), "# Synthetic evaluation\n"),
    writeFile(
      path.join(directory, "sample-evidence-bundle.json"),
      json({
        syntheticFixture: true,
        releasePreview: true,
        finalDelivery: false,
        humanApprovalRecorded: false,
        claims: [{ id: "claim-fixture" }]
      })
    ),
    writeFile(path.join(directory, "sample-report.pdf"), pdf),
    writeFile(path.join(directory, "sample-report.docx"), docx),
    writeFile(
      path.join(directory, "sample-delivery.zip"),
      await delivery.generateAsync({ type: "uint8array" })
    )
  ]);
  await refreshChecksums(directory);
  return directory;
}

async function updateDelivery(
  directory: string,
  update: (archive: JSZip) => void | Promise<void>
): Promise<void> {
  const archive = await JSZip.loadAsync(
    await readFile(path.join(directory, "sample-delivery.zip"))
  );
  await update(archive);
  await writeFile(
    path.join(directory, "sample-delivery.zip"),
    await archive.generateAsync({ type: "uint8array" })
  );
  await refreshChecksums(directory);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("unapproved synthetic release preview", () => {
  it("accepts a fully labeled preview with closed top-level and ZIP inventories", async () => {
    await expect(verifyReleaseArtifacts(await releasePreviewFixture())).resolves.toBeUndefined();
  });

  it("rejects a document.xml-only top-level DOCX ZIP", async () => {
    const directory = await releasePreviewFixture();
    await writeFile(path.join(directory, "sample-report.docx"), await documentXmlOnlyDocx());
    await refreshChecksums(directory);

    await expect(verifyReleaseArtifacts(directory)).rejects.toThrow(
      "Sample DOCX is missing required OPC part [Content_Types].xml"
    );
  });

  it("rejects a document.xml-only DOCX ZIP inside the delivery bundle", async () => {
    const directory = await releasePreviewFixture();
    await updateDelivery(directory, async (archive) => {
      archive.file("final-report.docx", await documentXmlOnlyDocx());
    });

    await expect(verifyReleaseArtifacts(directory)).rejects.toThrow(
      "Packaged DOCX is missing required OPC part [Content_Types].xml"
    );
  });

  it("rejects missing or unexpected delivery ZIP entries", async () => {
    const missing = await releasePreviewFixture();
    await updateDelivery(missing, (archive) => {
      archive.remove("sources.csv");
    });
    await expect(verifyReleaseArtifacts(missing)).rejects.toThrow(
      "missing [sources.csv]"
    );

    const unexpected = await releasePreviewFixture();
    await updateDelivery(unexpected, (archive) => {
      archive.file("debug.log", "not a release asset\n");
    });
    await expect(verifyReleaseArtifacts(unexpected)).rejects.toThrow(
      "unexpected [debug.log]"
    );

    const directoryEntry = await releasePreviewFixture();
    await updateDelivery(directoryEntry, (archive) => {
      archive.folder("nested");
    });
    await expect(verifyReleaseArtifacts(directoryEntry)).rejects.toThrow(
      "Delivery ZIP contains directory entries: nested/"
    );
  });

  it("rejects preview artifacts that claim final delivery or human approval", async () => {
    const evidence = await releasePreviewFixture();
    const evidencePath = path.join(evidence, "sample-evidence-bundle.json");
    const evidencePayload = JSON.parse(await readFile(evidencePath, "utf8")) as Record<
      string,
      unknown
    >;
    evidencePayload.finalDelivery = true;
    await writeFile(evidencePath, json(evidencePayload));
    await refreshChecksums(evidence);
    await expect(verifyReleaseArtifacts(evidence)).rejects.toThrow(
      "Sanitized evidence bundle"
    );

    const metadata = await releasePreviewFixture();
    await updateDelivery(metadata, async (archive) => {
      const metadataFile = archive.file("project-metadata.json");
      const payload = JSON.parse(await metadataFile!.async("string")) as Record<
        string,
        unknown
      >;
      payload.humanApprovalRecorded = true;
      archive.file("project-metadata.json", json(payload));
    });
    await expect(verifyReleaseArtifacts(metadata)).rejects.toThrow(
      "unapproved synthetic release preview"
    );
  });

  it("requires a human-readable unapproved-preview disclosure", async () => {
    const directory = await releasePreviewFixture();
    await updateDelivery(directory, (archive) => {
      archive.file("README.txt", "Synthetic fixture.\n");
    });

    await expect(verifyReleaseArtifacts(directory)).rejects.toThrow(
      "does not disclose its unapproved preview status"
    );
  });
});
