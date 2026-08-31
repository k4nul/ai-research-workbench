import { spawn, type ChildProcess } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const children = new Set<ChildProcess>();
let stopping = false;

function start(script: "dev" | "worker"): ChildProcess {
  const child = spawn(npmCommand, ["run", script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function stopChildren(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
  const pending = [...children].map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", () => resolve());
      })
  );
  const force = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);
  force.unref();
  await Promise.allSettled(pending);
  clearTimeout(force);
}

const web = start("dev");
const worker = start("worker");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stopChildren(signal).finally(() => {
      process.exitCode = signal === "SIGINT" ? 130 : 143;
    });
  });
}

const firstExit = await Promise.race(
  [web, worker].map(
    (child) =>
      new Promise<number>((resolve) => {
        child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      })
  )
);
await stopChildren();
process.exitCode = firstExit;
