import type { PoolClient } from "pg";
import type { AIStage } from "@/lib/providers";

export async function markGeneratedDomainEffectsNonCurrent(
  client: PoolClient,
  runStageIds: readonly string[]
): Promise<void> {
  if (runStageIds.length === 0) {
    return;
  }
  for (const table of ["evidence", "claims", "findings", "qa_findings"] as const) {
    await client.query(
      `UPDATE ${table}
       SET is_current = FALSE, updated_at = NOW()
       WHERE generated_by_run_stage_id = ANY($1::text[])
         AND is_current = TRUE`,
      [runStageIds]
    );
  }
  await client.query(
    `UPDATE research_questions
     SET research_gap = NULL, gap_status = 'NONE',
         gap_generated_by_run_stage_id = NULL, updated_at = NOW()
     WHERE gap_generated_by_run_stage_id = ANY($1::text[])
       AND gap_status = 'OPEN'`,
    [runStageIds]
  );
}

export async function supersedeCurrentGeneratedDomainEffects(input: {
  client: PoolClient;
  projectId: string;
  stage: AIStage;
  currentRunStageId: string;
}): Promise<void> {
  const prior = await input.client.query<{ id: string }>(
    `SELECT rrs.id
     FROM research_run_stages rrs
     JOIN research_runs rr ON rr.id = rrs.run_id
     WHERE rr.project_id = $1 AND rrs.stage_id = $2 AND rrs.id <> $3`,
    [input.projectId, input.stage, input.currentRunStageId]
  );
  await markGeneratedDomainEffectsNonCurrent(
    input.client,
    prior.rows.map((stage) => stage.id)
  );
}
