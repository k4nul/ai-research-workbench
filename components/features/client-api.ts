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

export async function apiRequest(
  endpoint: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetch(endpoint, {
    ...init,
    headers:
      init.body instanceof FormData
        ? init.headers
        : { "Content-Type": "application/json", ...init.headers },
  });
  const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload;
  if (!response.ok) {
    const fieldMessage = payload.error?.fields
      ? Object.values(payload.error.fields).flat()[0]
      : undefined;
    throw new Error(
      fieldMessage ?? payload.error?.message ?? `Request failed (${response.status}).`,
    );
  }
  return payload.data;
}
