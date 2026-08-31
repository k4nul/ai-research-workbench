import { withTransaction } from "@/lib/db";
import { AppError } from "@/lib/services/errors";

const MAX_RECEIPT_RESPONSE_BYTES = 4 * 1_024 * 1_024;

type MutationReceiptRow = {
  request_hash: string;
  response_status: number | null;
  response_body: string | null;
};

export type MutationReceiptScope = {
  principalScope: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  requestPath: string;
  idempotencyKey: string;
  requestHash: string;
};

export type MutationReceiptResult = {
  responseStatus: number;
  responseBody: string;
  replayed: boolean;
};

export type MutationResponse = {
  responseStatus: number;
  responseBody: string;
};

function reusedKey(): AppError {
  return new AppError(
    409,
    "IDEMPOTENCY_KEY_REUSED",
    "The idempotency key was already used for different request input."
  );
}

function validateResponse(response: MutationResponse): void {
  if (
    !Number.isInteger(response.responseStatus) ||
    response.responseStatus < 200 ||
    response.responseStatus > 499
  ) {
    throw new AppError(
      500,
      "IDEMPOTENCY_RESPONSE_INVALID",
      "The mutation returned a response that cannot be stored safely."
    );
  }
  if (Buffer.byteLength(response.responseBody, "utf8") > MAX_RECEIPT_RESPONSE_BYTES) {
    throw new AppError(
      500,
      "IDEMPOTENCY_RESPONSE_TOO_LARGE",
      "The mutation response exceeds the idempotency receipt limit."
    );
  }
  try {
    JSON.parse(response.responseBody);
  } catch {
    throw new AppError(
      500,
      "IDEMPOTENCY_RESPONSE_INVALID",
      "The mutation returned a response that cannot be stored safely."
    );
  }
}

export async function executeIdempotentMutation(
  scope: MutationReceiptScope,
  responseStatus: number,
  operation: () => Promise<unknown>
): Promise<MutationReceiptResult> {
  return executeIdempotentResponse(scope, async () => ({
    responseStatus,
    responseBody: JSON.stringify({ data: await operation() })
  }));
}

export async function executeIdempotentResponse(
  scope: MutationReceiptScope,
  operation: () => Promise<MutationResponse>
): Promise<MutationReceiptResult> {
  return withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO mutation_receipts (
         principal_scope, method, request_path, idempotency_key, request_hash
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (principal_scope, method, request_path, idempotency_key) DO NOTHING
       RETURNING request_hash`,
      [
        scope.principalScope,
        scope.method,
        scope.requestPath,
        scope.idempotencyKey,
        scope.requestHash
      ]
    );

    if (!inserted.rowCount) {
      const existing = await client.query<MutationReceiptRow>(
        `SELECT request_hash, response_status, response_body
           FROM mutation_receipts
          WHERE principal_scope = $1
            AND method = $2
            AND request_path = $3
            AND idempotency_key = $4`,
        [scope.principalScope, scope.method, scope.requestPath, scope.idempotencyKey]
      );
      const receipt = existing.rows[0];
      if (!receipt || receipt.request_hash !== scope.requestHash) {
        throw reusedKey();
      }
      if (receipt.response_status === null || receipt.response_body === null) {
        throw new AppError(
          409,
          "IDEMPOTENCY_REQUEST_INCOMPLETE",
          "The original mutation has not completed. Retry after a short delay."
        );
      }
      return {
        responseStatus: receipt.response_status,
        responseBody: receipt.response_body,
        replayed: true
      };
    }

    const response = await operation();
    validateResponse(response);
    await client.query(
      `UPDATE mutation_receipts
          SET response_status = $5,
              response_body = $6,
              completed_at = NOW()
        WHERE principal_scope = $1
          AND method = $2
          AND request_path = $3
          AND idempotency_key = $4`,
      [
        scope.principalScope,
        scope.method,
        scope.requestPath,
        scope.idempotencyKey,
        response.responseStatus,
        response.responseBody
      ]
    );
    return { ...response, replayed: false };
  });
}
