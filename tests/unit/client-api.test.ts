import { afterEach, describe, expect, it, vi } from "vitest";

import { authRequest } from "@/components/auth/auth-client";
import { apiRequest } from "@/components/features/client-api";
import { uploadMutationFingerprint } from "@/components/features/upload-idempotency";

function jsonResponse(status: number): Response {
  return new Response(
    JSON.stringify(status >= 400 ? { error: { message: "Synthetic failure." } } : { data: { ok: true } }),
    { status, headers: { "content-type": "application/json" } }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser mutation idempotency keys", () => {
  it("retains a generated key across failure and rotates it after success", async () => {
    vi.stubGlobal("document", { cookie: "arw_csrf=fixture-csrf" });
    const requests: RequestInit[] = [];
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (_endpoint: string, init: RequestInit) => {
      requests.push(init);
      attempt += 1;
      if (attempt === 1) throw new TypeError("Synthetic response loss.");
      return jsonResponse(200);
    }));
    const endpoint = `/api/projects/client-key-${crypto.randomUUID()}`;
    const input = { scope: "stable input" };

    await expect(
      apiRequest(endpoint, { method: "PATCH", body: JSON.stringify(input) })
    ).rejects.toThrow("Synthetic response loss.");
    await expect(
      apiRequest(endpoint, { method: "PATCH", body: JSON.stringify(input) })
    ).resolves.toEqual({ ok: true });
    await expect(
      apiRequest(endpoint, { method: "PATCH", body: JSON.stringify(input) })
    ).resolves.toEqual({ ok: true });

    const keys = requests.map((init) => new Headers(init.headers).get("idempotency-key"));
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
    expect(new Headers(requests[0].headers).get("x-csrf-token")).toBe("fixture-csrf");
  });

  it("rotates a failed generated key when the mutation input changes", async () => {
    vi.stubGlobal("document", { cookie: "arw_csrf=fixture-csrf" });
    const keys: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (_endpoint: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get("idempotency-key"));
      throw new TypeError("Synthetic response loss.");
    }));
    const endpoint = `/api/projects/client-drift-${crypto.randomUUID()}`;

    await expect(
      apiRequest(endpoint, { method: "PUT", body: JSON.stringify({ title: "before" }) })
    ).rejects.toThrow();
    await expect(
      apiRequest(endpoint, { method: "PUT", body: JSON.stringify({ title: "after" }) })
    ).rejects.toThrow();

    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("retains independent keys for overlapping inputs after response loss", async () => {
    vi.stubGlobal("document", { cookie: "arw_csrf=fixture-csrf" });
    const requests: Array<{ body: string; key: string | null }> = [];
    let rejectFirst: ((reason: Error) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_endpoint: string, init: RequestInit) => {
      const body = String(init.body);
      requests.push({
        body,
        key: new Headers(init.headers).get("idempotency-key")
      });
      if (body.includes('"title":"first"') && requests.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      if (body.includes('"title":"second"')) {
        throw new TypeError("Synthetic second response loss.");
      }
      return jsonResponse(200);
    }));
    const endpoint = `/api/projects/client-overlap-${crypto.randomUUID()}`;
    const firstBody = JSON.stringify({ title: "first" });
    const secondBody = JSON.stringify({ title: "second" });
    const firstResult = apiRequest(endpoint, { method: "PATCH", body: firstBody }).catch(
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(rejectFirst).toBeTypeOf("function"));

    await expect(
      apiRequest(endpoint, { method: "PATCH", body: secondBody })
    ).rejects.toThrow("Synthetic second response loss.");
    rejectFirst!(new TypeError("Synthetic first response loss."));
    await expect(firstResult).resolves.toBeInstanceOf(TypeError);
    await expect(
      apiRequest(endpoint, { method: "PATCH", body: firstBody })
    ).resolves.toEqual({ ok: true });

    const firstKeys = requests
      .filter((request) => request.body === firstBody)
      .map((request) => request.key);
    const secondKey = requests.find((request) => request.body === secondBody)?.key;
    expect(firstKeys).toHaveLength(2);
    expect(firstKeys[1]).toBe(firstKeys[0]);
    expect(secondKey).not.toBe(firstKeys[0]);
  });

  it("retains one key when any overlapping identical attempt loses its response", async () => {
    vi.stubGlobal("document", { cookie: "arw_csrf=fixture-csrf" });
    const keys: Array<string | null> = [];
    let resolveResponse: ((response: Response) => void) | undefined;
    let rejectResponse: ((reason: Error) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_endpoint: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get("idempotency-key"));
      if (keys.length === 1) {
        return new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        });
      }
      if (keys.length === 2) {
        return new Promise<Response>((_resolve, reject) => {
          rejectResponse = reject;
        });
      }
      return jsonResponse(200);
    }));
    const endpoint = `/api/projects/client-identical-overlap-${crypto.randomUUID()}`;
    const body = JSON.stringify({ title: "same" });

    const received = apiRequest(endpoint, { method: "PATCH", body });
    const lost = apiRequest(endpoint, { method: "PATCH", body });
    await vi.waitFor(() => {
      expect(resolveResponse).toBeTypeOf("function");
      expect(rejectResponse).toBeTypeOf("function");
    });
    resolveResponse!(jsonResponse(200));
    rejectResponse!(new TypeError("Synthetic overlapping response loss."));

    await expect(received).resolves.toEqual({ ok: true });
    await expect(lost).rejects.toThrow("Synthetic overlapping response loss.");
    await expect(apiRequest(endpoint, { method: "PATCH", body })).resolves.toEqual({ ok: true });
    await expect(apiRequest(endpoint, { method: "PATCH", body })).resolves.toEqual({ ok: true });

    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[2]);
  });

  it("retains the key when a successful response body is truncated", async () => {
    vi.stubGlobal("document", { cookie: "arw_csrf=fixture-csrf" });
    const keys: Array<string | null> = [];
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (_endpoint: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get("idempotency-key"));
      attempt += 1;
      if (attempt === 1) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":'));
            controller.error(new TypeError("Synthetic truncated response."));
          }
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return jsonResponse(200);
    }));
    const endpoint = `/api/projects/client-truncated-${crypto.randomUUID()}`;
    const body = JSON.stringify({ title: "stable" });

    await expect(apiRequest(endpoint, { method: "PATCH", body })).rejects.toThrow(
      "Synthetic truncated response."
    );
    await expect(apiRequest(endpoint, { method: "PATCH", body })).resolves.toEqual({ ok: true });

    expect(keys[1]).toBe(keys[0]);
  });

  it("preserves an explicit key", async () => {
    vi.stubGlobal("document", { cookie: "arw_csrf=fixture-csrf" });
    let received: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_endpoint: string, init: RequestInit) => {
      received = new Headers(init.headers).get("idempotency-key");
      return jsonResponse(200);
    }));

    await apiRequest("/api/runs/run-fixture/cancel", {
      method: "POST",
      headers: { "Idempotency-Key": "caller-provided-key" },
      body: JSON.stringify({ projectId: "project-fixture" })
    });

    expect(received).toBe("caller-provided-key");
  });

  it("changes multipart fingerprints when equal-metadata files contain different bytes", async () => {
    const form = (bytes: string) => {
      const value = new FormData();
      value.set(
        "file",
        new File([bytes], "same-name.txt", {
          type: "text/plain",
          lastModified: 1_700_000_000_000
        })
      );
      value.set("title", "Same title");
      return value;
    };

    const first = await uploadMutationFingerprint("project-fixture", form("first"));
    const replay = await uploadMutationFingerprint("project-fixture", form("first"));
    const drift = await uploadMutationFingerprint("project-fixture", form("other"));
    expect(replay).toBe(first);
    expect(drift).not.toBe(first);
  });

  it("retains and rotates auth mutation keys across network failure, input drift, and success", async () => {
    vi.stubGlobal("document", { cookie: "arw_csrf=fixture-csrf" });
    const keys: Array<string | null> = [];
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (_endpoint: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get("idempotency-key"));
      attempt += 1;
      if (attempt === 1) throw new TypeError("Synthetic network loss.");
      return jsonResponse(200);
    }));
    const endpoint = `/api/auth/password?fixture=${crypto.randomUUID()}`;
    const initialBody = JSON.stringify({ currentPassword: "before", newPassword: "after-one" });
    const changedBody = JSON.stringify({ currentPassword: "before", newPassword: "after-two" });

    await expect(
      authRequest(endpoint, { method: "PATCH", body: initialBody }, true)
    ).rejects.toThrow("Synthetic network loss.");
    await expect(
      authRequest(endpoint, { method: "PATCH", body: initialBody }, true)
    ).resolves.toEqual({ ok: true });
    await expect(
      authRequest(endpoint, { method: "PATCH", body: initialBody }, true)
    ).resolves.toEqual({ ok: true });
    await expect(
      authRequest(endpoint, { method: "PATCH", body: changedBody }, true)
    ).resolves.toEqual({ ok: true });

    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
    expect(keys[3]).not.toBe(keys[2]);
  });

  it("rotates an auth mutation key after a received rate-limit response", async () => {
    vi.stubGlobal("document", { cookie: "arw_csrf=fixture-csrf" });
    const keys: Array<string | null> = [];
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (_endpoint: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get("idempotency-key"));
      attempt += 1;
      return jsonResponse(attempt === 1 ? 429 : 200);
    }));
    const endpoint = `/api/auth/login?fixture=${crypto.randomUUID()}`;
    const body = JSON.stringify({ username: "fixture", password: "fixture password" });

    await expect(authRequest(endpoint, { method: "POST", body })).rejects.toThrow(
      "Synthetic failure."
    );
    await expect(authRequest(endpoint, { method: "POST", body })).resolves.toEqual({ ok: true });

    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).not.toBe(keys[0]);
  });
});
