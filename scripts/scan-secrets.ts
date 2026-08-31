import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const forbiddenPaths = [
  /^\.env$/,
  /^\.env\.(?!example$)/,
  /^\.data(?:\/|$)/,
  /^uploads(?:\/|$)/,
  /^exports(?:\/|$)/,
  /^quarantine(?:\/|$)/
];

const secretPatterns: readonly { name: string; pattern: RegExp }[] = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "OpenAI credential", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "GitHub credential", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack credential", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ }
];

function looksLikePlaceholder(value: string): boolean {
  return (
    value === "" ||
    value.includes("${") ||
    /(?:example|fixture|test|local|change|replace|redacted|not[_-]?configured|process\.env|^z\.|^parsed\.)/i.test(
      value
    )
  );
}

function literalSecretFindings(text: string): string[] {
  const findings: string[] = [];
  const assignment =
    /\b(OPENAI_API_KEY|BRAVE_SEARCH_API_KEY|S3_SECRET_ACCESS_KEY|AUTH_SESSION_SECRET|MINIO_ROOT_PASSWORD)\b[ \t]*[:=][ \t]*["']?([^\s,"'}]*)/g;
  for (const match of text.matchAll(assignment)) {
    const value = match[2] ?? "";
    if (value.length >= 16 && !looksLikePlaceholder(value)) {
      findings.push(`${match[1]} has a literal non-placeholder value`);
    }
  }
  return findings;
}

async function main(): Promise<void> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
    cwd: process.cwd(),
    encoding: "buffer",
    maxBuffer: 20 * 1024 * 1024
    }
  );
  const files = stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const findings: string[] = [];
  for (const file of files) {
    if (forbiddenPaths.some((pattern) => pattern.test(file))) {
      findings.push(`${file}: forbidden private/runtime path is tracked`);
      continue;
    }
    const bytes = await readFile(file);
    if (bytes.byteLength > 5_000_000 || bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    for (const candidate of secretPatterns) {
      if (candidate.pattern.test(text)) findings.push(`${file}: possible ${candidate.name}`);
    }
    if (/\.(?:env|ya?ml|json|toml)$/i.test(file) || file === ".env.example") {
      for (const finding of literalSecretFindings(text)) findings.push(`${file}: ${finding}`);
    }
  }
  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`FAIL ${finding}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `PASSED: ${files.length} tracked/untracked candidate files scanned; no secret pattern found.\n`
  );
}

await main();
