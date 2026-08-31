import { z } from "zod";

const booleanValue = z.enum(["true", "false"]);

export type AuthRuntime = {
  authEnabled: boolean;
  demoAuthBypass: boolean;
  cookieSecure: boolean;
  sessionTtlSeconds: number;
  warning?: string;
};

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Authentication duration must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function validateAuthRuntime(
  environment: NodeJS.ProcessEnv = process.env
): AuthRuntime {
  const production = environment.NODE_ENV === "production";
  const authEnabled = booleanValue.parse(environment.AUTH_ENABLED ?? "true") === "true";
  const demoMode = booleanValue.parse(environment.DEMO_MODE ?? "true") === "true";
  const demoAuthBypass =
    booleanValue.parse(environment.AUTH_DEMO_BYPASS ?? "false") === "true";
  const cookieSecure =
    booleanValue.parse(
      environment.AUTH_COOKIE_SECURE ?? (production ? "true" : "false")
    ) === "true";
  const appUrl = new URL(environment.APP_URL ?? "http://localhost:3100");
  const bindHost = environment.APP_BIND_HOST ?? "127.0.0.1";

  if (production && !authEnabled) {
    throw new Error("AUTH_ENABLED must be true in production.");
  }
  if (production && !cookieSecure) {
    throw new Error("AUTH_COOKIE_SECURE must be true in production.");
  }
  if (
    production &&
    (!environment.AUTH_SESSION_SECRET || environment.AUTH_SESSION_SECRET.trim().length < 32)
  ) {
    throw new Error("AUTH_SESSION_SECRET must contain at least 32 characters in production.");
  }
  if (demoAuthBypass && !demoMode) {
    throw new Error("AUTH_DEMO_BYPASS requires DEMO_MODE=true.");
  }
  if (demoAuthBypass && production) {
    throw new Error("Authentication bypass is forbidden in production.");
  }
  if (demoAuthBypass && !isLoopbackHost(appUrl.hostname)) {
    throw new Error("Authentication bypass is allowed only on a loopback APP_URL.");
  }
  if (demoAuthBypass && !isLoopbackHost(bindHost)) {
    throw new Error("Authentication bypass is allowed only on a loopback bind host.");
  }

  return {
    authEnabled,
    demoAuthBypass,
    cookieSecure,
    sessionTtlSeconds: positiveInteger(
      environment.AUTH_SESSION_TTL_SECONDS,
      43_200,
      300,
      2_592_000
    ),
    warning: demoAuthBypass
      ? "Authentication is bypassed for this loopback demo runtime."
      : undefined
  };
}
