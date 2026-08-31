import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { z } from "zod";

import { assertCsrfToken } from "@/lib/auth/csrf";
import {
  getLoginRateLimitConfig,
  loginRetryAfterSeconds,
  normalizeLoginRateLimitState,
  registerLoginFailure,
  type LoginRateLimitState
} from "@/lib/auth/rate-limit";
import {
  hashOperatorPassword,
  normalizeOperatorUsername,
  operatorPasswordNeedsRehash,
  operatorPasswordSchema,
  operatorUsernameSchema,
  verifyOperatorPassword
} from "@/lib/auth/password";
import { validateAuthRuntime } from "@/lib/auth/runtime";
import {
  createOpaqueToken,
  fingerprintClient,
  hashOpaqueToken,
  sanitizeClientLabel
} from "@/lib/auth/session";
import { query, withTransaction } from "@/lib/db";
import { writeAuditEvent } from "@/lib/services/audit";
import { AppError, conflict, notFound } from "@/lib/services/errors";

const displayNameSchema = z.string().trim().min(1).max(120);
const loginPasswordSchema = z.string().min(1).max(1_024);

type OperatorRow = QueryResultRow & {
  id: string;
  username: string;
  normalized_username: string;
  display_name: string;
  password_hash: string;
  password_version: number;
  is_active: boolean;
  last_login_at: Date | null;
  password_changed_at: Date;
  created_at: Date;
  updated_at: Date;
};

type SessionRow = QueryResultRow & {
  id: string;
  operator_id: string;
  token_hash: string;
  csrf_token_hash: string;
  client_label: string | null;
  client_fingerprint: string | null;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
  created_at: Date;
  username: string;
  display_name: string;
  password_version: number;
  password_changed_at: Date;
  last_login_at: Date | null;
};

type RateLimitRow = QueryResultRow & {
  attempt_count: number;
  window_started_at: Date;
  blocked_until: Date | null;
  database_now: Date;
};

export type OperatorView = {
  id: string;
  username: string;
  displayName: string;
  passwordChangedAt: string;
  lastLoginAt: string | null;
};

export type OperatorSessionView = {
  id: string;
  current: boolean;
  clientLabel: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

export type AuthenticatedOperatorSession = {
  sessionId: string;
  operator: OperatorView;
  csrfTokenHash: string;
  expiresAt: Date;
};

export type NewOperatorSession = {
  sessionId: string;
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
  operator: OperatorView;
};

type ClientContext = {
  userAgent?: string | null;
  clientAddress?: string | null;
};

function operatorView(row: Pick<
  OperatorRow,
  "id" | "username" | "display_name" | "password_changed_at" | "last_login_at"
>): OperatorView {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordChangedAt: row.password_changed_at.toISOString(),
    lastLoginAt: row.last_login_at?.toISOString() ?? null
  };
}

function sessionOperatorView(row: SessionRow): OperatorView {
  return {
    id: row.operator_id,
    username: row.username,
    displayName: row.display_name,
    passwordChangedAt: row.password_changed_at.toISOString(),
    lastLoginAt: row.last_login_at?.toISOString() ?? null
  };
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function loginRateLimitKey(normalizedUsername: string): string {
  return hashOpaqueToken(`operator-login\u0000${normalizedUsername}`);
}

function sanitizedClientContext(input: ClientContext): {
  label: string | null;
  fingerprint: string | null;
} {
  const label = sanitizeClientLabel(input.userAgent ?? null);
  const fingerprintSource = [input.clientAddress ?? "", label ?? ""].join("\u0000");
  return {
    label,
    fingerprint: fingerprintSource === "\u0000" ? null : fingerprintClient(fingerprintSource)
  };
}

async function lockRateLimit(
  client: PoolClient,
  keyHash: string
): Promise<{ state: LoginRateLimitState; now: Date }> {
  await client.query(
    "INSERT INTO operator_login_rate_limits (key_hash) VALUES ($1) ON CONFLICT DO NOTHING",
    [keyHash]
  );
  const result = await client.query<RateLimitRow>(
    "SELECT attempt_count, window_started_at, blocked_until, clock_timestamp() AS database_now FROM operator_login_rate_limits WHERE key_hash = $1 FOR UPDATE",
    [keyHash]
  );
  const row = result.rows[0];
  return {
    state: {
      attemptCount: row.attempt_count,
      windowStartedAt: row.window_started_at,
      blockedUntil: row.blocked_until
    },
    now: row.database_now
  };
}

async function saveRateLimit(
  client: PoolClient,
  keyHash: string,
  state: LoginRateLimitState
): Promise<void> {
  await client.query(
    "UPDATE operator_login_rate_limits SET attempt_count = $2, window_started_at = $3, blocked_until = $4, updated_at = clock_timestamp() WHERE key_hash = $1",
    [keyHash, state.attemptCount, state.windowStartedAt, state.blockedUntil]
  );
}

async function insertSession(
  client: PoolClient,
  operator: OperatorRow,
  context: ClientContext,
  tokens: { sessionToken?: string; csrfToken?: string } = {}
): Promise<NewOperatorSession> {
  const runtime = validateAuthRuntime();
  const sessionId = randomUUID();
  const sessionToken = tokens.sessionToken ?? createOpaqueToken();
  const csrfToken = tokens.csrfToken ?? createOpaqueToken();
  const clientContext = sanitizedClientContext(context);
  const inserted = await client.query<{ expires_at: Date }>(
    "INSERT INTO operator_sessions (id, operator_id, token_hash, csrf_token_hash, client_label, client_fingerprint, expires_at) VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp() + ($7 * INTERVAL '1 second')) RETURNING expires_at",
    [
      sessionId,
      operator.id,
      hashOpaqueToken(sessionToken),
      hashOpaqueToken(csrfToken),
      clientContext.label,
      clientContext.fingerprint,
      runtime.sessionTtlSeconds
    ]
  );
  return {
    sessionId,
    sessionToken,
    csrfToken,
    expiresAt: inserted.rows[0].expires_at,
    operator: operatorView(operator)
  };
}

async function loadSession(
  client: PoolClient,
  sessionToken: string,
  lock = false
): Promise<SessionRow | undefined> {
  const result = await client.query<SessionRow>(
    `SELECT s.*, o.username, o.display_name, o.password_version,
            o.password_changed_at, o.last_login_at
       FROM operator_sessions s
       JOIN operators o ON o.id = s.operator_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > clock_timestamp()
        AND o.is_active = TRUE
      ${lock ? "FOR UPDATE OF s" : ""}`,
    [hashOpaqueToken(sessionToken)]
  );
  return result.rows[0];
}

async function requireMutationSession(
  client: PoolClient,
  input: {
    sessionToken?: string;
    csrfCookie?: string;
    csrfHeader: string | null;
  }
): Promise<SessionRow> {
  if (!input.sessionToken) {
    throw new AppError(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  }
  const session = await loadSession(client, input.sessionToken, true);
  if (!session) {
    throw new AppError(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  }
  assertCsrfToken(session.csrf_token_hash, input.csrfCookie, input.csrfHeader);
  return session;
}

export async function createOperator(input: {
  username: string;
  displayName?: string;
  password: string;
}): Promise<OperatorView> {
  const username = operatorUsernameSchema.parse(input.username).trim();
  const normalizedUsername = normalizeOperatorUsername(username);
  const displayName = displayNameSchema.parse(input.displayName ?? username);
  const passwordHash = await hashOperatorPassword(input.password);
  try {
    return await withTransaction(async (client) => {
      const result = await client.query<OperatorRow>(
        "INSERT INTO operators (id, username, normalized_username, display_name, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING *",
        [randomUUID(), username, normalizedUsername, displayName, passwordHash]
      );
      const operator = result.rows[0];
      await writeAuditEvent(client, {
        actorType: "SYSTEM",
        actorLabel: "Operator bootstrap",
        action: "OPERATOR_CREATED",
        resourceType: "operator",
        resourceId: operator.id,
        afterState: { username: operator.username, displayName: operator.display_name }
      });
      return operatorView(operator);
    });
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      throw conflict("OPERATOR_EXISTS", "An operator with that username already exists.");
    }
    throw error;
  }
}

type AuthenticateOperatorInput = {
  username: string;
  password: string;
  replacementTokens?: { sessionToken: string; csrfToken: string };
} & ClientContext;

export type AuthenticateOperatorOutcome =
  | { kind: "invalid" }
  | { kind: "rate-limited"; retryAfterSeconds: number }
  | { kind: "authenticated"; session: NewOperatorSession };

export async function authenticateOperatorOutcome(
  input: AuthenticateOperatorInput
): Promise<AuthenticateOperatorOutcome> {
  const username = operatorUsernameSchema.parse(input.username).trim();
  const normalizedUsername = normalizeOperatorUsername(username);
  const password = loginPasswordSchema.parse(input.password);
  const rateLimitKey = loginRateLimitKey(normalizedUsername);
  const rateConfig = getLoginRateLimitConfig();

  const outcome = await withTransaction(async (client) => {
    const lockedRate = await lockRateLimit(client, rateLimitKey);
    const normalizedRate = normalizeLoginRateLimitState(
      lockedRate.state,
      lockedRate.now,
      rateConfig
    );
    const existingRetryAfter = loginRetryAfterSeconds(normalizedRate, lockedRate.now);
    if (existingRetryAfter) {
      await saveRateLimit(client, rateLimitKey, normalizedRate);
      await writeAuditEvent(client, {
        actorType: "SYSTEM",
        actorLabel: "Authentication service",
        action: "OPERATOR_LOGIN_RATE_LIMITED",
        resourceType: "operator_session",
        afterState: { retryAfterSeconds: existingRetryAfter }
      });
      return { kind: "rate-limited" as const, retryAfterSeconds: existingRetryAfter };
    }

    const operatorResult = await client.query<OperatorRow>(
      "SELECT * FROM operators WHERE normalized_username = $1 FOR UPDATE",
      [normalizedUsername]
    );
    const operator = operatorResult.rows[0];
    const passwordMatches = await verifyOperatorPassword(operator?.password_hash, password);
    if (!operator || !operator.is_active || !passwordMatches) {
      const failedRate = registerLoginFailure(normalizedRate, lockedRate.now, rateConfig);
      await saveRateLimit(client, rateLimitKey, failedRate);
      const retryAfterSeconds = loginRetryAfterSeconds(failedRate, lockedRate.now);
      await writeAuditEvent(client, {
        actorType: "SYSTEM",
        actorLabel: "Authentication service",
        action: retryAfterSeconds
          ? "OPERATOR_LOGIN_RATE_LIMITED"
          : "OPERATOR_LOGIN_FAILED",
        resourceType: "operator_session",
        afterState: { outcome: "DENIED", retryAfterSeconds }
      });
      return retryAfterSeconds
        ? { kind: "rate-limited" as const, retryAfterSeconds }
        : { kind: "invalid" as const };
    }

    if (operatorPasswordNeedsRehash(operator.password_hash)) {
      operator.password_hash = await hashOperatorPassword(password);
      await client.query(
        "UPDATE operators SET password_hash = $2, updated_at = clock_timestamp() WHERE id = $1",
        [operator.id, operator.password_hash]
      );
    }
    await client.query(
      "DELETE FROM operator_login_rate_limits WHERE key_hash = $1",
      [rateLimitKey]
    );
    const session = await insertSession(client, operator, input, input.replacementTokens);
    const loginTime = await client.query<{ last_login_at: Date }>(
      "UPDATE operators SET last_login_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1 RETURNING last_login_at",
      [operator.id]
    );
    session.operator.lastLoginAt = loginTime.rows[0].last_login_at.toISOString();
    await writeAuditEvent(client, {
      actorType: "USER",
      actorLabel: operator.display_name,
      action: "OPERATOR_LOGIN_SUCCEEDED",
      resourceType: "operator_session",
      resourceId: session.sessionId,
      afterState: { operatorId: operator.id, expiresAt: session.expiresAt.toISOString() }
    });
    return { kind: "authenticated" as const, session };
  });

  return outcome;
}

export async function authenticateOperator(
  input: AuthenticateOperatorInput
): Promise<NewOperatorSession> {
  const outcome = await authenticateOperatorOutcome(input);
  if (outcome.kind === "invalid") {
    throw new AppError(401, "INVALID_CREDENTIALS", "The username or password is invalid.");
  }
  if (outcome.kind === "rate-limited") {
    throw new AppError(
      429,
      "LOGIN_RATE_LIMITED",
      "Too many login attempts. Try again later.",
      { retryAfterSeconds: outcome.retryAfterSeconds }
    );
  }
  return outcome.session;
}

export async function getAuthenticatedOperatorSession(
  sessionToken: string | undefined
): Promise<AuthenticatedOperatorSession | null> {
  if (!sessionToken) return null;
  const tokenHash = hashOpaqueToken(sessionToken);
  const result = await query<SessionRow>(
    `SELECT s.*, o.username, o.display_name, o.password_version,
            o.password_changed_at, o.last_login_at
       FROM operator_sessions s
       JOIN operators o ON o.id = s.operator_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > clock_timestamp()
        AND o.is_active = TRUE`,
    [tokenHash]
  );
  const session = result.rows[0];
  if (!session) return null;
  await query(
    "UPDATE operator_sessions SET last_seen_at = clock_timestamp() WHERE id = $1 AND last_seen_at < clock_timestamp() - INTERVAL '5 minutes'",
    [session.id]
  );
  return {
    sessionId: session.id,
    operator: sessionOperatorView(session),
    csrfTokenHash: session.csrf_token_hash,
    expiresAt: session.expires_at
  };
}

export async function requireAuthenticatedOperatorSession(
  sessionToken: string | undefined
): Promise<AuthenticatedOperatorSession> {
  const session = await getAuthenticatedOperatorSession(sessionToken);
  if (!session) {
    throw new AppError(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  }
  return session;
}

export async function listOperatorSessions(
  sessionToken: string | undefined
): Promise<{ operator: OperatorView; sessions: OperatorSessionView[] }> {
  const current = await requireAuthenticatedOperatorSession(sessionToken);
  const result = await query<SessionRow>(
    `SELECT s.*, o.username, o.display_name, o.password_version,
            o.password_changed_at, o.last_login_at
       FROM operator_sessions s
       JOIN operators o ON o.id = s.operator_id
      WHERE s.operator_id = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > clock_timestamp()
      ORDER BY s.created_at DESC
      LIMIT 100`,
    [current.operator.id]
  );
  return {
    operator: current.operator,
    sessions: result.rows.map((row) => ({
      id: row.id,
      current: row.id === current.sessionId,
      clientLabel: row.client_label,
      createdAt: row.created_at.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      expiresAt: row.expires_at.toISOString()
    }))
  };
}

export async function requireAuthMutationContext(input: {
  sessionToken?: string;
  csrfCookie?: string;
  csrfHeader: string | null;
}): Promise<{ operatorId: string; sessionId: string }> {
  validateAuthRuntime();
  if (!input.sessionToken) {
    throw new AppError(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  }
  const result = await query<SessionRow>(
    `SELECT s.*, o.username, o.display_name, o.password_version,
            o.password_changed_at, o.last_login_at
       FROM operator_sessions s
       JOIN operators o ON o.id = s.operator_id
      WHERE s.token_hash = $1
        AND s.expires_at > clock_timestamp()
        AND o.is_active = TRUE`,
    [hashOpaqueToken(input.sessionToken)]
  );
  const session = result.rows[0];
  if (!session) {
    throw new AppError(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  }
  assertCsrfToken(session.csrf_token_hash, input.csrfCookie, input.csrfHeader);
  return { operatorId: session.operator_id, sessionId: session.id };
}

export async function logoutOperator(input: {
  sessionToken?: string;
  csrfCookie?: string;
  csrfHeader: string | null;
}): Promise<void> {
  await withTransaction(async (client) => {
    const session = await requireMutationSession(client, input);
    await client.query(
      "UPDATE operator_sessions SET revoked_at = clock_timestamp(), revoke_reason = 'LOGOUT' WHERE id = $1 AND revoked_at IS NULL",
      [session.id]
    );
    await writeAuditEvent(client, {
      actorType: "USER",
      actorLabel: session.display_name,
      action: "OPERATOR_LOGOUT",
      resourceType: "operator_session",
      resourceId: session.id,
      afterState: { revoked: true }
    });
  });
}

type ChangeOperatorPasswordInput = {
  sessionToken?: string;
  csrfCookie?: string;
  csrfHeader: string | null;
  currentPassword: string;
  newPassword: string;
  replacementTokens?: { sessionToken: string; csrfToken: string };
} & ClientContext;

export type ChangeOperatorPasswordOutcome =
  | { kind: "invalid-current" }
  | { kind: "reused" }
  | { kind: "changed"; replacement: NewOperatorSession };

export async function changeOperatorPasswordOutcome(
  input: ChangeOperatorPasswordInput
): Promise<ChangeOperatorPasswordOutcome> {
  const currentPassword = loginPasswordSchema.parse(input.currentPassword);
  const newPassword = operatorPasswordSchema.parse(input.newPassword);
  const outcome = await withTransaction(async (client) => {
    const session = await requireMutationSession(client, input);
    const operatorResult = await client.query<OperatorRow>(
      "SELECT * FROM operators WHERE id = $1 AND is_active = TRUE FOR UPDATE",
      [session.operator_id]
    );
    const operator = operatorResult.rows[0];
    if (!operator || !(await verifyOperatorPassword(operator.password_hash, currentPassword))) {
      await writeAuditEvent(client, {
        actorType: "USER",
        actorLabel: session.display_name,
        action: "OPERATOR_PASSWORD_CHANGE_DENIED",
        resourceType: "operator",
        resourceId: session.operator_id,
        afterState: { reason: "INVALID_CURRENT_PASSWORD" }
      });
      return { kind: "invalid-current" as const };
    }
    if (await verifyOperatorPassword(operator.password_hash, newPassword)) {
      return { kind: "reused" as const };
    }

    const passwordHash = await hashOperatorPassword(newPassword);
    const updatedOperator = await client.query<{ password_changed_at: Date }>(
      "UPDATE operators SET password_hash = $2, password_version = password_version + 1, password_changed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1 RETURNING password_changed_at",
      [operator.id, passwordHash]
    );
    operator.password_hash = passwordHash;
    operator.password_changed_at = updatedOperator.rows[0]?.password_changed_at ?? operator.password_changed_at;
    const revoked = await client.query<{ id: string }>(
      "UPDATE operator_sessions SET revoked_at = clock_timestamp(), revoke_reason = 'PASSWORD_CHANGED' WHERE operator_id = $1 AND revoked_at IS NULL RETURNING id",
      [operator.id]
    );
    const replacement = await insertSession(client, operator, input, input.replacementTokens);
    await writeAuditEvent(client, {
      actorType: "USER",
      actorLabel: operator.display_name,
      action: "OPERATOR_PASSWORD_CHANGED",
      resourceType: "operator",
      resourceId: operator.id,
      afterState: {
        replacementSessionId: replacement.sessionId,
        revokedSessionCount: revoked.rows.length
      }
    });
    return { kind: "changed" as const, replacement };
  });

  return outcome;
}

export async function changeOperatorPassword(
  input: ChangeOperatorPasswordInput
): Promise<NewOperatorSession> {
  const outcome = await changeOperatorPasswordOutcome(input);
  if (outcome.kind === "invalid-current") {
    throw new AppError(
      401,
      "INVALID_CURRENT_PASSWORD",
      "The current password is invalid."
    );
  }
  if (outcome.kind === "reused") {
    throw conflict("PASSWORD_REUSE", "The new password must be different.");
  }
  return outcome.replacement;
}

export async function revokeOperatorSession(input: {
  sessionToken?: string;
  csrfCookie?: string;
  csrfHeader: string | null;
  targetSessionId: string;
}): Promise<{ revokedCurrentSession: boolean }> {
  return withTransaction(async (client) => {
    const current = await requireMutationSession(client, input);
    const target = await client.query<{ id: string }>(
      "SELECT id FROM operator_sessions WHERE id = $1 AND operator_id = $2 AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE",
      [input.targetSessionId, current.operator_id]
    );
    if (!target.rowCount) {
      throw notFound("Session");
    }
    await client.query(
      "UPDATE operator_sessions SET revoked_at = clock_timestamp(), revoke_reason = 'OPERATOR_REQUEST' WHERE id = $1",
      [input.targetSessionId]
    );
    await writeAuditEvent(client, {
      actorType: "USER",
      actorLabel: current.display_name,
      action: "OPERATOR_SESSION_REVOKED",
      resourceType: "operator_session",
      resourceId: input.targetSessionId,
      afterState: { revokedCurrentSession: input.targetSessionId === current.id }
    });
    return { revokedCurrentSession: input.targetSessionId === current.id };
  });
}
