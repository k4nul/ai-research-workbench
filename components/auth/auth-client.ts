import { AUTH_CSRF_COOKIE, AUTH_CSRF_HEADER } from "@/lib/auth/constants";

type ErrorPayload = {
  error?: { message?: string; fields?: Record<string, string[]> };
  data?: unknown;
};

type PendingAuthMutation = {
  idempotencyKey: string;
  inFlight: number;
  unknownOutcome: boolean;
};

const pendingAuthMutations = new Map<string, PendingAuthMutation>();

export function browserCsrfToken(): string {
  const prefix = `${encodeURIComponent(AUTH_CSRF_COOKIE)}=`;
  const entry = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
}

export async function authRequest(
  endpoint: string,
  init: RequestInit,
  csrf = false
): Promise<unknown> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  let generated: PendingAuthMutation | undefined;
  let generatedScope: string | undefined;
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    if (!headers.has("Idempotency-Key")) {
      const body = typeof init.body === "string" ? init.body : "";
      generatedScope = JSON.stringify([method, endpoint, body]);
      generated = pendingAuthMutations.get(generatedScope) ?? {
        idempotencyKey: crypto.randomUUID(),
        inFlight: 0,
        unknownOutcome: false
      };
      if (generated.inFlight === 0) generated.unknownOutcome = false;
      generated.inFlight += 1;
      pendingAuthMutations.set(generatedScope, generated);
      headers.set("Idempotency-Key", generated.idempotencyKey);
    }
  }
  if (csrf) headers.set(AUTH_CSRF_HEADER, browserCsrfToken());
  let completeResponse = false;
  try {
    const response = await fetch(endpoint, {
      ...init,
      credentials: "same-origin",
      headers
    });
    const responseText = await response.text();
    let payload: ErrorPayload = {};
    if (responseText) {
      try {
        payload = JSON.parse(responseText) as ErrorPayload;
      } catch {
        throw new Error("The server response was not valid JSON.");
      }
    }
    completeResponse = true;
    if (!response.ok) {
      const fieldError = payload.error?.fields
        ? Object.values(payload.error.fields).flat()[0]
        : undefined;
      throw new Error(fieldError ?? payload.error?.message ?? "The request failed.");
    }
    return payload.data;
  } catch (error) {
    if (generated && !completeResponse) generated.unknownOutcome = true;
    throw error;
  } finally {
    if (generated && generatedScope) {
      generated.inFlight -= 1;
      if (
        generated.inFlight === 0 &&
        !generated.unknownOutcome &&
        pendingAuthMutations.get(generatedScope) === generated
      ) {
        pendingAuthMutations.delete(generatedScope);
      }
    }
  }
}
