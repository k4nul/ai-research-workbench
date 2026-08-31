import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const schemas: string[] = [];
const migrationImages: string[] = [];

function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  const parsed = new URL(value);
  if (!parsed.pathname.toLowerCase().includes("test")) {
    throw new Error("Migration concurrency tests require a test database.");
  }
  return parsed.toString();
}

async function withClient<T>(operation: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

afterAll(async () => {
  await withClient(async (client) => {
    for (const schema of schemas) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });
  await Promise.all(
    migrationImages.map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function migrationImageThrough(maximum: number): Promise<string> {
  const imageRoot = await mkdtemp(path.join(tmpdir(), "migration-image-"));
  migrationImages.push(imageRoot);
  const imageMigrations = path.join(imageRoot, "migrations");
  await mkdir(imageMigrations);
  const sourceMigrations = path.join(process.cwd(), "migrations");
  const names = (await readdir(sourceMigrations)).filter((name) => {
    const order = Number.parseInt(name.slice(0, 3), 10);
    return name.endsWith(".sql") && order <= maximum;
  });
  await Promise.all(
    names.map((name) =>
      copyFile(path.join(sourceMigrations, name), path.join(imageMigrations, name))
    )
  );
  return imageRoot;
}

describe("migration runner serialization", () => {
  it("serializes concurrent first-time migration processes before checking state", async () => {
    const schema = `migration_concurrency_${Date.now().toString(36)}`;
    schemas.push(schema);
    await withClient((client) => client.query(`CREATE SCHEMA "${schema}"`));

    const scopedUrl = new URL(testDatabaseUrl());
    scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    const executable = path.resolve(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx"
    );
    const run = () =>
      execFileAsync(executable, ["scripts/migrate.ts"], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: scopedUrl.toString() },
        timeout: 60_000
      });

    await expect(Promise.all([run(), run()])).resolves.toHaveLength(2);
    const migrationCount = (await readdir(path.join(process.cwd(), "migrations"))).filter(
      (name) => name.endsWith(".sql")
    ).length;
    const result = await withClient(async (client) => {
      await client.query(`SET search_path TO "${schema}"`);
      return client.query<{ count: number; checksums: number }>(
        `SELECT COUNT(*)::integer AS count,
          COUNT(checksum)::integer AS checksums
         FROM schema_migrations WHERE checksum IS NOT NULL`
      );
    });
    expect(result.rows[0].count).toBe(migrationCount);
    expect(result.rows[0].checksums).toBe(migrationCount);
    const expectedConstraints = [
      ["research_projects", "research_projects_scope_revision_fkey"],
      ["research_projects", "research_projects_plan_revision_fkey"],
      ["jobs", "jobs_run_fkey"],
      ["jobs", "jobs_run_stage_fkey"],
      ["jobs", "jobs_parent_fkey"],
      ["ai_runs", "ai_runs_research_run_fkey"],
      ["ai_runs", "ai_runs_run_stage_fkey"],
      ["ai_runs", "ai_runs_job_fkey"],
      ["ai_runs", "ai_runs_job_attempt_fkey"],
      ["evidence", "evidence_generated_run_stage_fkey"],
      ["claims", "claims_generated_run_stage_fkey"],
      ["findings", "findings_generated_run_stage_fkey"],
      ["qa_findings", "qa_findings_generated_run_stage_fkey"],
      ["research_questions", "research_questions_gap_run_stage_fkey"]
    ];
    const constraints = await withClient((client) =>
      client.query<{ table_name: string; constraint_name: string }>(
        `SELECT cls.relname AS table_name, con.conname AS constraint_name
         FROM pg_constraint con
         JOIN pg_class cls ON cls.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = cls.relnamespace
         WHERE ns.nspname = $1 AND con.conname = ANY($2::text[])`,
        [schema, expectedConstraints.map((entry) => entry[1])]
      )
    );
    expect(
      constraints.rows
        .map((row) => [row.table_name, row.constraint_name])
        .sort((left, right) => left.join(":").localeCompare(right.join(":")))
    ).toEqual(
      expectedConstraints.sort((left, right) =>
        left.join(":").localeCompare(right.join(":"))
      )
    );
  }, 90_000);

  it("refuses to run an image whose local migration set is older than the database", async () => {
    const schema = `migration_future_${Date.now().toString(36)}`;
    schemas.push(schema);
    await withClient((client) => client.query(`CREATE SCHEMA "${schema}"`));
    const scopedUrl = new URL(testDatabaseUrl());
    scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    const executable = path.resolve(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx"
    );
    const run = () =>
      execFileAsync(executable, ["scripts/migrate.ts"], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: scopedUrl.toString() },
        timeout: 60_000
      });

    await run();
    await withClient(async (client) => {
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(
        "INSERT INTO schema_migrations (name, checksum) VALUES ('999_future.sql', $1)",
        ["f".repeat(64)]
      );
    });
    await expect(run()).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Database contains migrations absent from this release: 999_future.sql"
      )
    });
  }, 90_000);

  it("reconciles stale generated domain effects during an upgrade", async () => {
    const schema = `migration_currentness_${Date.now().toString(36)}`;
    schemas.push(schema);
    await withClient((client) => client.query(`CREATE SCHEMA "${schema}"`));
    const scopedUrl = new URL(testDatabaseUrl());
    scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    const executable = path.resolve(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx"
    );
    const migrationScript = path.resolve(process.cwd(), "scripts/migrate.ts");
    const run = (imageRoot = process.cwd()) =>
      execFileAsync(executable, [migrationScript], {
        cwd: imageRoot,
        env: {
          ...process.env,
          DATABASE_URL: scopedUrl.toString(),
          TSX_TSCONFIG_PATH: path.resolve(process.cwd(), "tsconfig.json")
        },
        timeout: 60_000
      });

    const image014 = await migrationImageThrough(14);
    await run(image014);
    await withClient(async (client) => {
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(
        "INSERT INTO workspaces (id, name) VALUES ('upgrade-workspace', 'Upgrade fixture')"
      );
      await client.query(
        `INSERT INTO research_projects (
           id, workspace_id, name, core_question, purpose, audience, scope, research_date
         ) VALUES (
           'upgrade-project', 'upgrade-workspace', 'Upgrade project', 'Question?',
           'Verify migration', 'Test operators', 'Synthetic fixture', '2026-01-01'
         )`
      );
      await client.query(
        `INSERT INTO research_runs (
           id, project_id, mode, status, pipeline_version, request_hash,
           idempotency_key, created_by
         ) VALUES
           ('upgrade-run', 'upgrade-project', 'ORCHESTRATED', 'CREATED', 'v2',
            'fixture-request-hash', 'upgrade-run', 'Migration test'),
           ('upgrade-run-2', 'upgrade-project', 'ORCHESTRATED', 'CREATED', 'v2',
            'fixture-request-hash-2', 'upgrade-run-2', 'Migration test')`
      );
      const stages = [
        ["stage-evidence-old", "evidence_extraction", 5, 1, "STALE", "2026-01-01"],
        ["stage-evidence-current", "evidence_extraction", 5, 2, "SUCCEEDED", "2026-01-02"],
        ["stage-claim-old", "claim_generation", 6, 1, "STALE", "2026-01-01"],
        ["stage-claim-current", "claim_generation", 6, 2, "SUCCEEDED", "2026-01-02"],
        ["stage-gap-old", "gap_detection", 7, 1, "STALE", "2026-01-01"],
        ["stage-gap-current", "gap_detection", 7, 2, "SUCCEEDED", "2026-01-02"],
        ["stage-conflict-old", "conflict_detection", 8, 1, "STALE", "2026-01-01"],
        ["stage-conflict-current", "conflict_detection", 8, 1, "SUCCEEDED", "2026-01-02"],
        ["stage-qa-old", "qa_revision", 11, 1, "STALE", "2026-01-01"],
        ["stage-qa-current", "qa_revision", 11, 2, "SUCCEEDED", "2026-01-02"],
        ["stage-summary-old", "source_summary", 4, 1, "SUCCEEDED", "2026-01-01"],
        ["stage-summary-new", "source_summary", 4, 2, "QUEUED", "2026-01-02"]
      ] as const;
      for (const [id, stageId, ordinal, generation, status, timestamp] of stages) {
        const runId = id === "stage-conflict-current" ? "upgrade-run-2" : "upgrade-run";
        await client.query(
          `INSERT INTO research_run_stages (
             id, run_id, stage_id, ordinal, generation, status, pipeline_version,
             prompt_template_version, structured_schema_version, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'v2', 'v1', 'v1', $7)`,
          [id, runId, stageId, ordinal, generation, status, timestamp]
        );
        if (status !== "QUEUED") {
          await client.query(
            `INSERT INTO stage_domain_commits (
               id, run_stage_id, generation, idempotency_key, output_hash, committed_at
             ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [`commit-${id}`, id, generation, `commit-${id}`, `hash-${id}`, timestamp]
          );
        }
      }
      await client.query(
        `INSERT INTO sources (id, project_id, title, source_type)
         VALUES ('upgrade-source', 'upgrade-project', 'Synthetic source', 'FIXTURE')`
      );
      await client.query(
        `INSERT INTO research_questions (
           id, project_id, question, completion_criteria, research_gap, gap_status
         ) VALUES
           ('gap-old', 'upgrade-project', 'Old gap?', 'Test', 'Stale generated gap',
            'OPEN'),
           ('gap-current', 'upgrade-project', 'Current gap?', 'Test', 'Current generated gap',
            'OPEN'),
           ('gap-accepted', 'upgrade-project', 'Accepted gap?', 'Test', 'Human accepted gap',
            'ACCEPTED')`
      );
      await client.query(
        `INSERT INTO evidence (
           id, source_id, summary, verification_status
         ) VALUES
           ('ai-evidence-stage-evidence-old-1', 'upgrade-source', 'Old generated',
            'PENDING'),
           ('ai-evidence-stage-evidence-current-1', 'upgrade-source', 'Current generated',
            'PENDING'),
           ('manual-evidence', 'upgrade-source', 'Manual evidence', 'VERIFIED')`
      );
      await client.query(
        `INSERT INTO claims (
           id, project_id, question_id, content, claim_type, support_status,
           fact_or_inference
         ) VALUES
           ('ai-claim-stage-claim-old-1', 'upgrade-project', 'gap-current', 'Old claim',
            'FACT', 'UNSUPPORTED', 'FACT'),
           ('ai-claim-stage-claim-current-1', 'upgrade-project', 'gap-current', 'Current claim',
            'FACT', 'UNSUPPORTED', 'FACT'),
           ('manual-claim', 'upgrade-project', 'gap-current', 'Manual claim',
            'FACT', 'SUPPORTED', 'FACT')`
      );
      await client.query(
        `INSERT INTO findings (
           id, project_id, question_id, finding
         ) VALUES
           ('old-finding', 'upgrade-project', 'gap-current', 'Old finding'),
           ('current-finding', 'upgrade-project', 'gap-current', 'Current finding'),
           ('invalidated-before-commit', 'upgrade-project', 'gap-current',
            'A newer queued generation invalidated this finding'),
           ('manual-finding', 'upgrade-project', 'gap-current', 'Manual finding')`
      );
      await client.query(
        `INSERT INTO qa_findings (
           id, project_id, rule_code, severity, location, problem, remediation,
           resolution_status
         ) VALUES
           ('ai-qa-stage-qa-old-1', 'upgrade-project', 'AI_QA_REVISION', 'BLOCKER',
            'old', 'Old QA', 'Rerun', 'OPEN'),
           ('ai-qa-stage-qa-current-1', 'upgrade-project', 'AI_QA_REVISION', 'LOW',
            'current', 'Current QA', 'Review', 'OPEN'),
           ('ai-conflict-stage-conflict-old-1', 'upgrade-project', 'AI_SOURCE_CONFLICT',
            'BLOCKER', 'old-conflict', 'Old conflict', 'Rerun', 'OPEN'),
           ('ai-conflict-stage-conflict-current-1', 'upgrade-project', 'AI_SOURCE_CONFLICT',
            'MEDIUM', 'current-conflict', 'Current conflict', 'Review', 'OPEN'),
           ('manual-qa', 'upgrade-project', 'MANUAL', 'LOW', 'manual', 'Manual QA',
            'Review', 'OPEN')`
      );
    });

    const image019 = await migrationImageThrough(19);
    await run(image019);
    await withClient(async (client) => {
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(
        `UPDATE research_questions
         SET gap_generated_by_run_stage_id = CASE id
           WHEN 'gap-current' THEN 'stage-gap-current'
           ELSE 'stage-gap-old'
         END`
      );
      await client.query(
        `UPDATE findings
         SET generated_by_run_stage_id = CASE id
           WHEN 'current-finding' THEN 'stage-claim-current'
           WHEN 'old-finding' THEN 'stage-claim-old'
           WHEN 'invalidated-before-commit' THEN 'stage-summary-old'
           ELSE NULL
         END`
      );
      await client.query(
        `INSERT INTO evidence (
           id, source_id, summary, verification_status, generated_by_run_stage_id, is_current
         ) VALUES (
           'reviewed-out-evidence', 'upgrade-source', 'Deliberately non-current',
           'PENDING', 'stage-evidence-current', FALSE
         )`
      );
    });
    await run();
    await withClient(async (client) => {
      await client.query(`SET search_path TO "${schema}"`);
      const evidence = await client.query<{
        id: string;
        is_current: boolean;
        generated_by_run_stage_id: string | null;
      }>("SELECT id, is_current, generated_by_run_stage_id FROM evidence ORDER BY id");
      expect(evidence.rows).toEqual([
        {
          id: "ai-evidence-stage-evidence-current-1",
          is_current: true,
          generated_by_run_stage_id: "stage-evidence-current"
        },
        {
          id: "ai-evidence-stage-evidence-old-1",
          is_current: false,
          generated_by_run_stage_id: "stage-evidence-old"
        },
        { id: "manual-evidence", is_current: true, generated_by_run_stage_id: null },
        {
          id: "reviewed-out-evidence",
          is_current: false,
          generated_by_run_stage_id: "stage-evidence-current"
        }
      ]);
      const currentness = await client.query<{ table_name: string; id: string; is_current: boolean }>(
        `SELECT 'claims' AS table_name, id, is_current FROM claims
         UNION ALL SELECT 'findings', id, is_current FROM findings
         UNION ALL SELECT 'qa_findings', id, is_current FROM qa_findings
         ORDER BY table_name, id`
      );
      expect(currentness.rows).toEqual([
        { table_name: "claims", id: "ai-claim-stage-claim-current-1", is_current: true },
        { table_name: "claims", id: "ai-claim-stage-claim-old-1", is_current: false },
        { table_name: "claims", id: "manual-claim", is_current: true },
        { table_name: "findings", id: "current-finding", is_current: true },
        { table_name: "findings", id: "invalidated-before-commit", is_current: false },
        { table_name: "findings", id: "manual-finding", is_current: true },
        { table_name: "findings", id: "old-finding", is_current: false },
        {
          table_name: "qa_findings",
          id: "ai-conflict-stage-conflict-current-1",
          is_current: true
        },
        {
          table_name: "qa_findings",
          id: "ai-conflict-stage-conflict-old-1",
          is_current: false
        },
        { table_name: "qa_findings", id: "ai-qa-stage-qa-current-1", is_current: true },
        { table_name: "qa_findings", id: "ai-qa-stage-qa-old-1", is_current: false },
        { table_name: "qa_findings", id: "manual-qa", is_current: true }
      ]);
      const gaps = await client.query<{
        id: string;
        research_gap: string | null;
        gap_status: string;
        gap_generated_by_run_stage_id: string | null;
      }>(
        `SELECT id, research_gap, gap_status, gap_generated_by_run_stage_id
         FROM research_questions ORDER BY id`
      );
      expect(gaps.rows).toEqual([
        {
          id: "gap-accepted",
          research_gap: "Human accepted gap",
          gap_status: "ACCEPTED",
          gap_generated_by_run_stage_id: "stage-gap-old"
        },
        {
          id: "gap-current",
          research_gap: "Current generated gap",
          gap_status: "OPEN",
          gap_generated_by_run_stage_id: "stage-gap-current"
        },
        {
          id: "gap-old",
          research_gap: null,
          gap_status: "NONE",
          gap_generated_by_run_stage_id: null
        }
      ]);
      const blockers = await client.query<{ count: number }>(
        `SELECT COUNT(*)::integer AS count FROM qa_findings
         WHERE is_current = TRUE AND severity = 'BLOCKER' AND resolution_status <> 'RESOLVED'`
      );
      expect(blockers.rows[0].count).toBe(0);

      await client.query(
        `INSERT INTO evidence (id, source_id, summary, verification_status)
         VALUES ('ai-evidence-orphan-1', 'upgrade-source', 'Orphan', 'PENDING')`
      );
      await client.query(
        "DELETE FROM schema_migrations WHERE name = '020_reconcile_current_generation_domain_effects.sql'"
      );
    });
    await expect(run()).rejects.toMatchObject({
      stderr: expect.stringContaining("AI evidence remains without run-stage provenance")
    });
    await withClient(async (client) => {
      await client.query(`SET search_path TO "${schema}"`);
      await client.query("DELETE FROM evidence WHERE id = 'ai-evidence-orphan-1'");
    });
    await expect(run()).resolves.toBeDefined();
    await expect(run()).resolves.toBeDefined();
  }, 90_000);
});
