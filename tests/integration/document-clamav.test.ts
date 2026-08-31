import { describe, expect, it } from "vitest";

import { ClamAvScanner } from "@/lib/documents";

const host = process.env.CLAMAV_TEST_HOST ?? "127.0.0.1";
const port = Number(process.env.CLAMAV_TEST_PORT ?? "53310");
const required = process.env.REQUIRE_CLAMAV_TEST === "true";

const EICAR_TEST_STRING =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

describe("ClamAV malware scanner contract", () => {
  it("reports version metadata, accepts clean bytes, and rejects the harmless EICAR fixture", async (context) => {
    const scanner = new ClamAvScanner({
      host,
      port,
      timeoutMs: 15_000,
      maxBytes: 1_000_000
    });
    const clean = await scanner.scan({
      bytes: new TextEncoder().encode("Synthetic clean document fixture.")
    });
    if (clean.status === "ERROR" || clean.status === "TIMEOUT") {
      if (required) {
        throw new Error(`Required ClamAV integration failed: ${clean.sanitizedError}`);
      }
      context.skip();
      return;
    }

    expect(clean).toMatchObject({
      status: "CLEAN",
      scanner: "clamav",
      byteSize: expect.any(Number),
      objectSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      scannerVersion: expect.any(String),
      signatureDatabaseVersion: expect.any(String)
    });

    const infected = await scanner.scan({
      bytes: new TextEncoder().encode(EICAR_TEST_STRING)
    });
    expect(infected.status).toBe("INFECTED");
    expect(infected.detectedName).toMatch(/Eicar|EICAR/u);
  });
});
