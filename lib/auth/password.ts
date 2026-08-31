import argon2 from "argon2";
import { z } from "zod";

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1
} as const;

const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,p=1,t=2$R/7d4QaklF8XnUs4zzlLNA$WQ9R9FWVgf4/ZBU1M1ZnX9j3NrRkmUwcQyfhexhfYjE";

export const operatorUsernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, {
    message: "Use letters, numbers, dots, underscores, or hyphens."
  });

export const operatorPasswordSchema = z
  .string()
  .min(12, { message: "Password must contain at least 12 characters." })
  .max(1_024, { message: "Password must contain at most 1024 characters." });

export function normalizeOperatorUsername(username: string): string {
  return operatorUsernameSchema.parse(username).toLowerCase();
}

export async function hashOperatorPassword(password: string): Promise<string> {
  const parsed = operatorPasswordSchema.parse(password);
  return argon2.hash(parsed, ARGON2_OPTIONS);
}

export async function verifyOperatorPassword(
  passwordHash: string | undefined,
  password: string
): Promise<boolean> {
  const hash = passwordHash ?? DUMMY_PASSWORD_HASH;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function operatorPasswordNeedsRehash(passwordHash: string): boolean {
  return argon2.needsRehash(passwordHash, ARGON2_OPTIONS);
}
