import { execFile, spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import {
  request as createBackendRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const loopbackHost = "127.0.0.1";
const defaultAppUrl = "https://127.0.0.1:3100";
const defaultBackendPort = 3101;
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

let backend: ChildProcess | undefined;
let proxyServer: ReturnType<typeof createHttpsServer> | undefined;
let temporaryDirectory: string | undefined;
let stopping = false;
let shutdownPromise: Promise<void> | undefined;

function parseAppUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`APP_URL must be an absolute URL, received ${JSON.stringify(value)}.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("The Playwright production server requires an HTTPS APP_URL.");
  }
  if (parsed.hostname !== loopbackHost) {
    throw new Error(`The Playwright production server must bind to ${loopbackHost}.`);
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("APP_URL must contain only the HTTPS loopback origin.");
  }
  return parsed;
}

function parsePort(value: string | undefined, fallback: number, name: string): number {
  const port = !value ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535.`);
  }
  return port;
}

function connectionHeaderNames(headers: IncomingHttpHeaders): string[] {
  const value = headers.connection;
  if (!value) return [];
  return value
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

function forwardedRequestHeaders(
  headers: IncomingHttpHeaders,
  publicHost: string,
  clientAddress: string | undefined
): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {};
  const connectionHeaders = new Set(connectionHeaderNames(headers));
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (
      value === undefined ||
      hopByHopHeaders.has(normalizedName) ||
      connectionHeaders.has(normalizedName) ||
      normalizedName === "forwarded" ||
      normalizedName.startsWith("x-forwarded-")
    ) {
      continue;
    }
    forwarded[name] = value;
  }
  forwarded.host = headers.host ?? publicHost;
  forwarded["x-forwarded-proto"] = "https";
  forwarded["x-forwarded-host"] = headers.host ?? publicHost;
  forwarded["x-forwarded-for"] = clientAddress ?? loopbackHost;
  return forwarded;
}

function forwardedResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {};
  const connectionHeaders = new Set(connectionHeaderNames(headers));
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (
      value === undefined ||
      hopByHopHeaders.has(normalizedName) ||
      connectionHeaders.has(normalizedName)
    ) {
      continue;
    }
    forwarded[name] = value;
  }
  return forwarded;
}

async function prepareStandaloneAssets(projectRoot: string): Promise<string> {
  const nextDirectory = path.join(projectRoot, ".next");
  const standaloneDirectory = path.join(nextDirectory, "standalone");
  const serverPath = path.join(standaloneDirectory, "server.js");
  const publicTarget = path.join(standaloneDirectory, "public");
  const staticTarget = path.join(standaloneDirectory, ".next", "static");

  await Promise.all([
    rm(publicTarget, { force: true, recursive: true }),
    rm(staticTarget, { force: true, recursive: true })
  ]);
  await mkdir(path.dirname(staticTarget), { recursive: true });
  await Promise.all([
    cp(path.join(projectRoot, "public"), publicTarget, { recursive: true }),
    cp(path.join(nextDirectory, "static"), staticTarget, { recursive: true })
  ]);
  await access(serverPath);
  return serverPath;
}

async function createCertificate(): Promise<{ certificate: Buffer; privateKey: Buffer }> {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "ai-research-workbench-e2e-"));
  if (stopping) {
    const directory = temporaryDirectory;
    temporaryDirectory = undefined;
    await rm(directory, { force: true, recursive: true });
    throw new Error("Playwright production server startup was interrupted.");
  }
  const certificatePath = path.join(temporaryDirectory, "certificate.pem");
  const privateKeyPath = path.join(temporaryDirectory, "private-key.pem");
  try {
    await execFileAsync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-keyout",
        privateKeyPath,
        "-out",
        certificatePath,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1"
      ],
      { maxBuffer: 1024 * 1024 }
    );
  } catch (error) {
    throw new Error(
      `Could not generate the ephemeral Playwright certificate with openssl: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  await chmod(privateKeyPath, 0o600);
  const [certificate, privateKey] = await Promise.all([
    readFile(certificatePath),
    readFile(privateKeyPath)
  ]);
  return { certificate, privateKey };
}

function createProxy(
  certificate: Buffer,
  privateKey: Buffer,
  backendPort: number,
  publicHost: string
): ReturnType<typeof createHttpsServer> {
  return createHttpsServer({ cert: certificate, key: privateKey }, (request, response) => {
    const upstream = createBackendRequest(
      {
        headers: forwardedRequestHeaders(
          request.headers,
          publicHost,
          request.socket.remoteAddress
        ),
        host: loopbackHost,
        method: request.method,
        path: request.url ?? "/",
        port: backendPort
      },
      (upstreamResponse) => {
        if (response.destroyed) {
          upstreamResponse.destroy();
          return;
        }
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          forwardedResponseHeaders(upstreamResponse.headers)
        );
        upstreamResponse.on("error", () => response.destroy());
        upstreamResponse.pipe(response);
      }
    );

    upstream.on("error", () => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(502, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8"
      });
      response.end("The Playwright production backend is unavailable.\n");
    });
    request.on("aborted", () => upstream.destroy());
    request.on("error", () => upstream.destroy());
    response.on("close", () => {
      if (!response.writableEnded) upstream.destroy();
    });
    request.pipe(upstream);
  });
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function closeProxy(): Promise<void> {
  const server = proxyServer;
  proxyServer = undefined;
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function stopBackend(signal: NodeJS.Signals): Promise<void> {
  const child = backend;
  backend = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForChildExit(child);
  child.kill(signal);
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 5_000);
  force.unref();
  await exited;
  clearTimeout(force);
}

function shutdown(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    await closeProxy();
    await stopBackend(signal);
    if (temporaryDirectory) {
      const directory = temporaryDirectory;
      temporaryDirectory = undefined;
      await rm(directory, { force: true, recursive: true });
    }
  })();
  return shutdownPromise;
}

function stopAfterFailure(message: string, exitCode = 1): void {
  if (stopping) return;
  process.stderr.write(`${message}\n`);
  process.exitCode = exitCode;
  void shutdown().catch((error: unknown) => {
    process.stderr.write(
      `Playwright production server cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
  });
}

async function listen(
  server: ReturnType<typeof createHttpsServer>,
  port: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => reject(error);
    server.once("error", handleError);
    server.listen(port, loopbackHost, () => {
      server.off("error", handleError);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const appUrl = parseAppUrl(process.env.APP_URL?.trim() || defaultAppUrl);
  const publicPort = parsePort(appUrl.port, 443, "APP_URL port");
  const backendPort = parsePort(
    process.env.E2E_BACKEND_PORT,
    defaultBackendPort,
    "E2E_BACKEND_PORT"
  );
  if (backendPort === publicPort) {
    throw new Error("E2E_BACKEND_PORT must differ from the public APP_URL port.");
  }

  const projectRoot = process.cwd();
  const serverPath = await prepareStandaloneAssets(projectRoot);
  if (stopping) return;
  const { certificate, privateKey } = await createCertificate();
  if (stopping) return;
  proxyServer = createProxy(certificate, privateKey, backendPort, appUrl.host);
  proxyServer.on("error", (error) => {
    stopAfterFailure(`Playwright HTTPS proxy failed: ${error.message}`);
  });
  await listen(proxyServer, publicPort);
  if (stopping) return;

  backend = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      HOSTNAME: loopbackHost,
      NODE_ENV: "production",
      PORT: String(backendPort)
    },
    stdio: "inherit"
  });
  backend.once("error", (error) => {
    stopAfterFailure(`Playwright production backend failed to start: ${error.message}`);
  });
  backend.once("exit", (code, signal) => {
    if (stopping) return;
    stopAfterFailure(
      `Playwright production backend exited unexpectedly (${signal ?? code ?? "unknown"}).`,
      code && code > 0 ? code : 1
    );
  });

  process.stdout.write(
    `Playwright production server listening at ${appUrl.origin}; backend http://${loopbackHost}:${backendPort}.\n`
  );
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    process.exitCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129;
    void shutdown(signal).catch((error: unknown) => {
      process.stderr.write(
        `Playwright production server cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
    });
  });
}

process.once("exit", () => {
  if (backend && backend.exitCode === null && backend.signalCode === null) {
    backend.kill("SIGKILL");
  }
  if (temporaryDirectory) rmSync(temporaryDirectory, { force: true, recursive: true });
});

void main().catch((error: unknown) => {
  stopAfterFailure(
    `Playwright production server failed: ${error instanceof Error ? error.message : String(error)}`
  );
});
