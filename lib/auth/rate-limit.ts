export type LoginRateLimitConfig = {
  maximumAttempts: number;
  windowSeconds: number;
  blockSeconds: number;
};

export type LoginRateLimitState = {
  attemptCount: number;
  windowStartedAt: Date;
  blockedUntil: Date | null;
};

function boundedEnvironmentInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Login rate-limit value must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function getLoginRateLimitConfig(
  environment: NodeJS.ProcessEnv = process.env
): LoginRateLimitConfig {
  return {
    maximumAttempts: boundedEnvironmentInteger(
      environment.AUTH_LOGIN_MAX_ATTEMPTS,
      5,
      2,
      100
    ),
    windowSeconds: boundedEnvironmentInteger(
      environment.AUTH_LOGIN_WINDOW_SECONDS,
      900,
      60,
      86_400
    ),
    blockSeconds: boundedEnvironmentInteger(
      environment.AUTH_LOGIN_BLOCK_SECONDS,
      900,
      60,
      86_400
    )
  };
}

export function normalizeLoginRateLimitState(
  state: LoginRateLimitState,
  now: Date,
  config: LoginRateLimitConfig
): LoginRateLimitState {
  if (now.getTime() - state.windowStartedAt.getTime() >= config.windowSeconds * 1_000) {
    return { attemptCount: 0, windowStartedAt: now, blockedUntil: null };
  }
  return state;
}

export function loginRetryAfterSeconds(
  state: LoginRateLimitState,
  now: Date
): number | null {
  if (!state.blockedUntil || state.blockedUntil <= now) return null;
  return Math.max(1, Math.ceil((state.blockedUntil.getTime() - now.getTime()) / 1_000));
}

export function registerLoginFailure(
  state: LoginRateLimitState,
  now: Date,
  config: LoginRateLimitConfig
): LoginRateLimitState {
  const normalized = normalizeLoginRateLimitState(state, now, config);
  const attemptCount = normalized.attemptCount + 1;
  return {
    attemptCount,
    windowStartedAt: normalized.windowStartedAt,
    blockedUntil:
      attemptCount >= config.maximumAttempts
        ? new Date(now.getTime() + config.blockSeconds * 1_000)
        : null
  };
}
