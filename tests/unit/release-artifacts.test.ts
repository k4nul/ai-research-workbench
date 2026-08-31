import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REQUIRED_CONFIGURATION_VARIABLES,
  REQUIRED_RELEASE_FILES,
  verifyChecksums,
  verifyConfigurationSchema,
  verifyEvaluationSummary,
  verifyReleaseFileSet
} from "@/scripts/verify-release-artifacts";

const temporaryDirectories: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function releaseFixture(): Promise<{ directory: string; checksumLines: string[] }> {
  const directory = await mkdtemp(path.join(tmpdir(), "release-verification-test-"));
  temporaryDirectories.push(directory);
  const checksumLines: string[] = [];
  for (const filename of REQUIRED_RELEASE_FILES) {
    if (filename === "SHA256SUMS") continue;
    const contents = `${filename} synthetic fixture\n`;
    await writeFile(path.join(directory, filename), contents);
    checksumLines.push(`${sha256(contents)}  ${filename}`);
  }
  await writeFile(path.join(directory, "SHA256SUMS"), checksumLines.join("\n") + "\n");
  return { directory, checksumLines };
}

function configuration(variableNames: readonly string[] = REQUIRED_CONFIGURATION_VARIABLES) {
  return {
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
    variables: variableNames.map((name) => ({ name }))
  };
}

const EVALUATION_FIXTURE_IDS = [
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
] as const;

function persistedRunId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function evaluationSummary() {
  return {
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
    fixtureResults: EVALUATION_FIXTURE_IDS.map((fixtureId, index) => {
      const outputHash = sha256(fixtureId);
      return {
        fixtureId,
        primaryRunId: persistedRunId(index * 2 + 1),
        repeatRunId: persistedRunId(index * 2 + 2),
        outputHash,
        repeatOutputHash: outputHash,
        reproducible: true
      };
    })
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("release artifact verification", () => {
  it("accepts only the exact required file and checksum sets", async () => {
    const fixture = await releaseFixture();

    await expect(verifyReleaseFileSet(fixture.directory)).resolves.toBeUndefined();
    await expect(verifyChecksums(fixture.directory)).resolves.toBe(
      REQUIRED_RELEASE_FILES.length - 1
    );
  });

  it("rejects unexpected assets, missing assets, and non-file entries", async () => {
    const unexpected = await releaseFixture();
    await writeFile(path.join(unexpected.directory, "debug.log"), "not a release asset\n");
    await expect(verifyReleaseFileSet(unexpected.directory)).rejects.toThrow(
      "Unexpected release assets: debug.log"
    );

    const missing = await releaseFixture();
    await rm(path.join(missing.directory, "CHANGELOG.md"));
    await expect(verifyReleaseFileSet(missing.directory)).rejects.toThrow(
      "Required release assets are missing: CHANGELOG.md"
    );

    const nonFile = await releaseFixture();
    await mkdir(path.join(nonFile.directory, "nested"));
    await expect(verifyReleaseFileSet(nonFile.directory)).rejects.toThrow(
      "Release directory contains non-file entries: nested"
    );
  });

  it("rejects unexpected, duplicate, and missing checksum entries", async () => {
    const unexpected = await releaseFixture();
    await writeFile(
      path.join(unexpected.directory, "SHA256SUMS"),
      unexpected.checksumLines.join("\n") + `\n${"0".repeat(64)}  debug.log\n`
    );
    await expect(verifyChecksums(unexpected.directory)).rejects.toThrow(
      "unexpected entry for debug.log"
    );

    const duplicate = await releaseFixture();
    await writeFile(
      path.join(duplicate.directory, "SHA256SUMS"),
      duplicate.checksumLines.join("\n") + `\n${duplicate.checksumLines[0]}\n`
    );
    await expect(verifyChecksums(duplicate.directory)).rejects.toThrow(
      "duplicate entry for CHANGELOG.md"
    );

    const missing = await releaseFixture();
    await writeFile(
      path.join(missing.directory, "SHA256SUMS"),
      missing.checksumLines.slice(1).join("\n") + "\n"
    );
    await expect(verifyChecksums(missing.directory)).rejects.toThrow(
      "SHA256SUMS is missing: CHANGELOG.md"
    );
  });
});

describe("release configuration inventory", () => {
  it("matches the exact variable inventory generated from .env.example", async () => {
    const contents = await readFile(path.resolve(process.cwd(), ".env.example"), "utf8");
    const names = contents
      .split(/\r?\n/u)
      .filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line))
      .map((line) => line.slice(0, line.indexOf("=")));

    expect(names).toEqual(REQUIRED_CONFIGURATION_VARIABLES);
  });

  it("requires the complete configuration schema and production contract", () => {
    expect(() => verifyConfigurationSchema(configuration())).not.toThrow();
    expect(() =>
      verifyConfigurationSchema({ ...configuration(), schemaVersion: "unknown" })
    ).toThrow("Configuration schema version is invalid");
    expect(() =>
      verifyConfigurationSchema({
        ...configuration(),
        productionRequirements: {
          ...configuration().productionRequirements,
          malwareFailClosed: false
        }
      })
    ).toThrow("Configuration production requirements are invalid");
  });

  it.each(["WORKER_ID", "WORKER_SHUTDOWN_GRACE_MS", "SERVICE_VERSION"])(
    "rejects an inventory missing %s",
    (missingName) => {
      expect(() =>
        verifyConfigurationSchema(
          configuration(REQUIRED_CONFIGURATION_VARIABLES.filter((name) => name !== missingName))
        )
      ).toThrow(`missing [${missingName}]`);
    }
  );
});

describe("release evaluation evidence", () => {
  it("accepts ten unique fixtures backed by twenty unique persisted UUID runs", () => {
    expect(() => verifyEvaluationSummary(evaluationSummary())).not.toThrow();
  });

  it("rejects duplicate fixture IDs", () => {
    const evaluation = evaluationSummary();
    evaluation.fixtureResults[1].fixtureId = evaluation.fixtureResults[0].fixtureId;

    expect(() => verifyEvaluationSummary(evaluation)).toThrow(
      "20 reproducible, complete PostgreSQL pipeline runs"
    );
  });

  it("rejects a run ID duplicated across fixtures", () => {
    const evaluation = evaluationSummary();
    evaluation.fixtureResults[1].primaryRunId =
      evaluation.fixtureResults[0].repeatRunId;

    expect(() => verifyEvaluationSummary(evaluation)).toThrow(
      "20 reproducible, complete PostgreSQL pipeline runs"
    );
  });

  it("rejects malformed or non-lowercase SHA-256 hashes", () => {
    for (const malformedHash of ["A".repeat(64), "g".repeat(64), "a".repeat(63)]) {
      const evaluation = evaluationSummary();
      evaluation.fixtureResults[0].outputHash = malformedHash;
      evaluation.fixtureResults[0].repeatOutputHash = malformedHash;

      expect(() => verifyEvaluationSummary(evaluation)).toThrow(
        "20 reproducible, complete PostgreSQL pipeline runs"
      );
    }
  });

  it("rejects run identifiers that are not UUIDs", () => {
    const evaluation = evaluationSummary();
    evaluation.fixtureResults[0].primaryRunId = "primary-run-1";

    expect(() => verifyEvaluationSummary(evaluation)).toThrow(
      "20 reproducible, complete PostgreSQL pipeline runs"
    );
  });
});
