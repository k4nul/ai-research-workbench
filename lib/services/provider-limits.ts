import { randomUUID } from "node:crypto";
import { withTransaction } from "@/lib/db";

export interface ProviderLimitPolicy {
  requestLimit: number;
  windowSeconds: number;
  concurrencyLimit: number;
  permitTtlMs: number;
}

export type ProviderPermitDecision =
  | { allowed: true; permitId: string }
  | {
      allowed: false;
      reason: "REQUEST_WINDOW" | "CONCURRENCY";
      retryAfterMs: number;
    };

function validatePolicy(policy: ProviderLimitPolicy): void {
  for (const [label, value, maximum] of [
    ["requestLimit", policy.requestLimit, 1_000_000],
    ["windowSeconds", policy.windowSeconds, 86_400],
    ["concurrencyLimit", policy.concurrencyLimit, 10_000],
    ["permitTtlMs", policy.permitTtlMs, 3_600_000]
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${label} must be an integer between 1 and ${maximum}`);
    }
  }
}

export async function acquireProviderPermit(input: {
  provider: string;
  operation: string;
  ownerId: string;
  jobId?: string;
  policy: ProviderLimitPolicy;
}): Promise<ProviderPermitDecision> {
  validatePolicy(input.policy);
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO provider_rate_windows (
         provider, operation, window_started_at, window_seconds, request_limit,
         concurrency_limit, request_count, in_flight
       ) VALUES ($1, $2, NOW(), $3, $4, $5, 0, 0)
       ON CONFLICT (provider, operation) DO NOTHING`,
      [
        input.provider,
        input.operation,
        input.policy.windowSeconds,
        input.policy.requestLimit,
        input.policy.concurrencyLimit
      ]
    );
    const locked = await client.query<{
      request_count: number;
      window_started_at: Date;
      window_expired: boolean;
      retry_after_ms: number;
    }>(
      `SELECT request_count, window_started_at,
              window_started_at + ($3 * INTERVAL '1 second') <= NOW() AS window_expired,
              GREATEST(0, CEIL(EXTRACT(EPOCH FROM (
                window_started_at + ($3 * INTERVAL '1 second') - NOW()
              )) * 1000))::INTEGER AS retry_after_ms
       FROM provider_rate_windows
       WHERE provider = $1 AND operation = $2
       FOR UPDATE`,
      [input.provider, input.operation, input.policy.windowSeconds]
    );
    const window = locked.rows[0];
    if (!window) {
      throw new Error("Provider rate window could not be locked");
    }
    if (window.window_expired) {
      window.request_count = 0;
      await client.query(
        `UPDATE provider_rate_windows
         SET window_started_at = NOW(), request_count = 0,
             window_seconds = $3, request_limit = $4, concurrency_limit = $5,
             updated_at = NOW()
         WHERE provider = $1 AND operation = $2`,
        [
          input.provider,
          input.operation,
          input.policy.windowSeconds,
          input.policy.requestLimit,
          input.policy.concurrencyLimit
        ]
      );
    }
    await client.query(
      `UPDATE provider_permits
       SET released_at = NOW()
       WHERE provider = $1 AND operation = $2
         AND released_at IS NULL AND expires_at <= NOW()`,
      [input.provider, input.operation]
    );
    const active = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM provider_permits
       WHERE provider = $1 AND operation = $2
         AND released_at IS NULL AND expires_at > NOW()`,
      [input.provider, input.operation]
    );
    const inFlight = Number(active.rows[0]?.count ?? 0);
    if (inFlight >= input.policy.concurrencyLimit) {
      await client.query(
        `UPDATE provider_rate_windows SET in_flight = $3, updated_at = NOW()
         WHERE provider = $1 AND operation = $2`,
        [input.provider, input.operation, inFlight]
      );
      return { allowed: false, reason: "CONCURRENCY", retryAfterMs: 250 };
    }
    if (window.request_count >= input.policy.requestLimit) {
      return {
        allowed: false,
        reason: "REQUEST_WINDOW",
        retryAfterMs: window.window_expired
          ? input.policy.windowSeconds * 1_000
          : window.retry_after_ms
      };
    }
    const permitId = randomUUID();
    await client.query(
      `INSERT INTO provider_permits (
         id, provider, operation, owner_id, job_id, expires_at
       ) VALUES ($1, $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 millisecond'))`,
      [
        permitId,
        input.provider,
        input.operation,
        input.ownerId,
        input.jobId ?? null,
        input.policy.permitTtlMs
      ]
    );
    await client.query(
      `UPDATE provider_rate_windows
       SET request_count = request_count + 1, in_flight = $3, updated_at = NOW(),
           window_seconds = $4, request_limit = $5, concurrency_limit = $6
       WHERE provider = $1 AND operation = $2`,
      [
        input.provider,
        input.operation,
        inFlight + 1,
        input.policy.windowSeconds,
        input.policy.requestLimit,
        input.policy.concurrencyLimit
      ]
    );
    return { allowed: true, permitId };
  });
}

export async function extendProviderPermit(input: {
  permitId: string;
  ownerId: string;
  ttlMs: number;
}): Promise<boolean> {
  if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > 3_600_000) {
    throw new Error("ttlMs must be an integer between 1 and 3600000");
  }
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE provider_permits
       SET expires_at = NOW() + ($3 * INTERVAL '1 millisecond')
       WHERE id = $1 AND owner_id = $2 AND released_at IS NULL AND expires_at > NOW()`,
      [input.permitId, input.ownerId, input.ttlMs]
    );
    return result.rowCount === 1;
  });
}

export async function releaseProviderPermit(input: {
  permitId: string;
  ownerId: string;
}): Promise<boolean> {
  return withTransaction(async (client) => {
    const released = await client.query<{ provider: string; operation: string }>(
      `UPDATE provider_permits SET released_at = NOW()
       WHERE id = $1 AND owner_id = $2 AND released_at IS NULL
       RETURNING provider, operation`,
      [input.permitId, input.ownerId]
    );
    const permit = released.rows[0];
    if (!permit) {
      return false;
    }
    await client.query(
      `UPDATE provider_rate_windows
       SET in_flight = (
         SELECT COUNT(*) FROM provider_permits
         WHERE provider = $1 AND operation = $2
           AND released_at IS NULL AND expires_at > NOW()
       ), updated_at = NOW()
       WHERE provider = $1 AND operation = $2`,
      [permit.provider, permit.operation]
    );
    return true;
  });
}
