import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, types as pgTypes, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { getConfig } from "@/lib/config";

// PostgreSQL DATE has no timezone. Preserve its YYYY-MM-DD representation instead of
// allowing node-postgres to convert it through the host timezone.
pgTypes.setTypeParser(1082, (value) => value);

const globalPool = globalThis as typeof globalThis & {
  researchWorkbenchPool?: Pool;
};

const transactionClient = new AsyncLocalStorage<PoolClient>();

export function getPool(): Pool {
  if (!globalPool.researchWorkbenchPool) {
    globalPool.researchWorkbenchPool = new Pool({
      connectionString: getConfig().databaseUrl,
      max: process.env.NODE_ENV === "test" ? 2 : getConfig().databasePoolSize,
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
  const client = transactionClient.getStore();
  return client
    ? client.query<T>(text, [...values])
    : getPool().query<T>(text, [...values]);
}

export async function withTransaction<T>(
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const existingClient = transactionClient.getStore();
  if (existingClient) {
    return operation(existingClient);
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await transactionClient.run(client, () => operation(client));
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
