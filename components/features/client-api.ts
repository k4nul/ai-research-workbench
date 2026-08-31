import { browserCsrfToken } from "@/components/auth/auth-client";
import { AUTH_CSRF_HEADER } from "@/lib/auth/constants";

export interface MutationMessage {
  tone: "success" | "error";
  text: string;
}

interface ApiErrorPayload {
  error?: {
    message?: string;
    fields?: Record<string, string[]>;
    details?: unknown;
  };
  data?: unknown;
}

type PendingMutation = {
  idempotencyKey: string;
  inFlight: number;
  unknownOutcome: boolean;
};

const pendingMutations = new Map<string, PendingMutation>();

function mutationBodyFingerprint(body: BodyInit | null | undefined): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error("JSON mutations must provide a string body or an explicit Idempotency-Key.");
}

export async function apiRequest(
  endpoint: string,
  init: RequestInit,
): Promise<unknown> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  let generated: PendingMutation | undefined;
  let generatedScope: string | undefined;
  if (mutation) {
    headers.set(AUTH_CSRF_HEADER, browserCsrfToken());
    if (!headers.has("Idempotency-Key") && !(init.body instanceof FormData)) {
      const bodyFingerprint = mutationBodyFingerprint(init.body);
      generatedScope = JSON.stringify([method, endpoint, bodyFingerprint]);
      generated = pendingMutations.get(generatedScope) ?? {
        idempotencyKey: crypto.randomUUID(),
        inFlight: 0,
        unknownOutcome: false
      };
      if (generated.inFlight === 0) generated.unknownOutcome = false;
      generated.inFlight += 1;
      pendingMutations.set(generatedScope, generated);
      headers.set("Idempotency-Key", generated.idempotencyKey);
    }
  }
  let completeResponse = false;
  try {
    const response = await fetch(endpoint, {
      ...init,
      credentials: "same-origin",
      headers,
    });
    const responseText = await response.text();
    let payload: ApiErrorPayload = {};
    if (responseText) {
      try {
        payload = JSON.parse(responseText) as ApiErrorPayload;
      } catch {
        throw new Error("The server response was not valid JSON.");
      }
    }
    completeResponse = true;
    if (!response.ok) {
      const fieldMessage = payload.error?.fields
        ? Object.values(payload.error.fields).flat()[0]
        : undefined;
      throw new Error(
        fieldMessage ?? payload.error?.message ?? `Request failed (${response.status}).`,
      );
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
        pendingMutations.get(generatedScope) === generated
      ) {
        pendingMutations.delete(generatedScope);
      }
    }
  }
}
