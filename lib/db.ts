import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { getConfig } from "@/lib/config";

const globalPool = globalThis as typeof globalThis & {
  researchWorkbenchPool?: Pool;
};

export function getPool(): Pool {
  if (!globalPool.researchWorkbenchPool) {
    globalPool.researchWorkbenchPool = new Pool({
      connectionString: getConfig().databaseUrl,
      max: process.env.NODE_ENV === "test" ? 2 : 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: "ai-research-workbench"
    });
  }
  return globalPool.researchWorkbenchPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = []
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, [...values]);
}

export async function withTransaction<T>(
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (globalPool.researchWorkbenchPool) {
    await globalPool.researchWorkbenchPool.end();
    globalPool.researchWorkbenchPool = undefined;
  }
}
