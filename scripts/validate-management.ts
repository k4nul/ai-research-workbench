import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SCHEMA_VERSION = "2.0";
const REQUIRED_MANAGEMENT_FILES = [
  "docs/management/agent-instructions.json",
  "docs/management/ARCHITECTURE.json",
  "docs/management/AUTOMATION.json",
  "docs/management/INDEX.json"
] as const;
const INDEXED_MANAGEMENT_FILES = REQUIRED_MANAGEMENT_FILES.filter(
  (file) => !file.endsWith("/INDEX.json")
);
const ALLOWED_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);

type JsonObject = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(message);
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string.`);
  return value;
}

function exactKeys(value: JsonObject, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const missing = keys.filter((key) => !(key in value));
  const extra = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length || extra.length) {
    fail(
      `${label} keys differ from the schema; missing [${missing.join(", ")}], extra [${extra.join(", ")}].`
    );
  }
}

async function parseJson(relativePath: string): Promise<JsonObject> {
  const contents = await readFile(path.join(ROOT, relativePath), "utf8");
  try {
    return object(JSON.parse(contents), relativePath);
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function repoPath(relativePath: string, label: string): string {
  if (path.isAbsolute(relativePath) || relativePath.includes("\\")) {
    fail(`${label} must be a repository-relative POSIX path.`);
  }
  const absolute = path.resolve(ROOT, relativePath);
  if (absolute !== ROOT && !absolute.startsWith(`${ROOT}${path.sep}`)) {
    fail(`${label} escapes the repository root.`);
  }
  return absolute;
}

async function assertPath(relativePath: string, label: string): Promise<void> {
  const absolute = repoPath(relativePath, label);
  try {
    await stat(absolute);
  } catch {
    fail(`${label} does not exist: ${relativePath}`);
  }
}

function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(`${label} contains a duplicate: ${value}`);
    seen.add(value);
  }
}

function validateTopLevel(
  value: JsonObject,
  relativePath: string,
  kind: string,
  keys: readonly string[],
  packageVersion: string
): void {
  exactKeys(value, keys, relativePath);
  if (value.schemaVersion !== SCHEMA_VERSION) {
    fail(`${relativePath} schemaVersion must be ${SCHEMA_VERSION}.`);
  }
  if (value.kind !== kind) fail(`${relativePath} kind must be ${kind}.`);
  if (value.applicationVersion !== packageVersion) {
    fail(`${relativePath} applicationVersion must match package.json (${packageVersion}).`);
  }
  string(value.id, `${relativePath}.id`);
}

function validateObjectArray(
  value: unknown,
  label: string,
  keys: readonly string[]
): JsonObject[] {
  return array(value, label).map((raw, position) => {
    const entry = object(raw, `${label}[${position}]`);
    exactKeys(entry, keys, `${label}[${position}]`);
    string(entry.id, `${label}[${position}].id`);
    return entry;
  });
}

function validateAgentShape(agent: JsonObject): void {
  const scope = object(agent.scope, "agent-instructions.scope");
  exactKeys(scope, ["id", "root", "statement"], "agent-instructions.scope");
  string(scope.statement, "agent-instructions.scope.statement");
  validateObjectArray(
    agent.sourceOfTruth,
    "agent-instructions.sourceOfTruth",
    ["id", "priority", "paths", "statement"]
  ).forEach((entry, position) => {
    if (
      typeof entry.priority !== "number" ||
      !Number.isInteger(entry.priority) ||
      entry.priority < 1
    ) {
      fail(`agent-instructions.sourceOfTruth[${position}].priority must be a positive integer.`);
    }
    array(entry.paths, `agent-instructions.sourceOfTruth[${position}].paths`);
    string(entry.statement, `agent-instructions.sourceOfTruth[${position}].statement`);
  });
  validateObjectArray(agent.rules, "agent-instructions.rules", ["id", "statement"]);
  validateObjectArray(
    agent.securityInvariants,
    "agent-instructions.securityInvariants",
    ["id", "statement"]
  );
  validateObjectArray(
    agent.completionEvidence,
    "agent-instructions.completionEvidence",
    ["id", "statement"]
  );
  validateObjectArray(
    agent.commands,
    "agent-instructions.commands",
    ["id", "command", "purpose"]
  );
}

function validateArchitectureShape(architecture: JsonObject): void {
  const delivery = object(architecture.deliverySemantics, "ARCHITECTURE.deliverySemantics");
  exactKeys(
    delivery,
    ["id", "queue", "semantics", "exactlyOnceExecution", "requiredControl"],
    "ARCHITECTURE.deliverySemantics"
  );
  if (delivery.semantics !== "at-least-once" || delivery.exactlyOnceExecution !== false) {
    fail("ARCHITECTURE delivery semantics must explicitly be at-least-once and not exactly-once.");
  }
  validateObjectArray(
    architecture.components,
    "ARCHITECTURE.components",
    ["id", "sourcePath", "responsibility"]
  );
  validateObjectArray(
    architecture.dataStores,
    "ARCHITECTURE.dataStores",
    ["id", "sourcePath", "role"]
  );
  validateObjectArray(
    architecture.contracts,
    "ARCHITECTURE.contracts",
    ["id", "sourcePath", "statement"]
  );
}

function collectIds(value: unknown, source: string, ids: Map<string, string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectIds(item, source, ids));
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as JsonObject;
  if ("id" in record) {
    const id = string(record.id, `${source}.id`);
    if (!/^[a-z][a-z0-9.-]{2,127}$/.test(id)) {
      fail(`${source} has an invalid id: ${id}`);
    }
    const previous = ids.get(id);
    if (previous) fail(`Duplicate management id ${id} in ${previous} and ${source}.`);
    ids.set(id, source);
  }
  Object.values(record).forEach((item) => collectIds(item, source, ids));
}

async function validateDeclaredPaths(value: unknown, source: string): Promise<void> {
  if (Array.isArray(value)) {
    for (const item of value) await validateDeclaredPaths(item, source);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, raw] of Object.entries(value as JsonObject)) {
    if (["path", "sourcePath", "scriptPath", "workflowPath", "root"].includes(key)) {
      await assertPath(string(raw, `${source}.${key}`), `${source}.${key}`);
    } else if (key === "paths") {
      for (const item of array(raw, `${source}.paths`)) {
        await assertPath(string(item, `${source}.paths[]`), `${source}.paths[]`);
      }
    }
    await validateDeclaredPaths(raw, source);
  }
}

function validateDeclaredCommands(
  value: unknown,
  source: string,
  packageScripts: JsonObject
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => validateDeclaredCommands(item, source, packageScripts));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, raw] of Object.entries(value as JsonObject)) {
    if (key === "command") {
      const command = string(raw, `${source}.command`);
      const match = /^npm run ([a-z0-9:-]+)(?:\s+--(?:\s+.*)?)?$/u.exec(command);
      if (!match || !(match[1] in packageScripts)) {
        fail(`${source} declares an unknown or non-canonical command: ${command}`);
      }
    }
    validateDeclaredCommands(raw, source, packageScripts);
  }
}

function routeForSource(sourcePath: string): string {
  return sourcePath
    .replace(/^app/, "")
    .replace(/\/route\.ts$/, "")
    .replace(/\[([^\]]+)\]/g, ":$1");
}

async function validateRoutes(architecture: JsonObject): Promise<number> {
  const routes = array(architecture.routes, "ARCHITECTURE.routes");
  const identities: string[] = [];
  for (const [index, raw] of routes.entries()) {
    const route = object(raw, `ARCHITECTURE.routes[${index}]`);
    exactKeys(route, ["id", "method", "route", "sourcePath", "purpose"], `ARCHITECTURE.routes[${index}]`);
    const method = string(route.method, `ARCHITECTURE.routes[${index}].method`).toUpperCase();
    const declaredRoute = string(route.route, `ARCHITECTURE.routes[${index}].route`);
    const sourcePath = string(route.sourcePath, `ARCHITECTURE.routes[${index}].sourcePath`);
    if (!ALLOWED_METHODS.has(method)) fail(`Unsupported route method ${method}.`);
    if (!sourcePath.startsWith("app/api/") || !sourcePath.endsWith("/route.ts")) {
      fail(`Route source must be an app/api route.ts file: ${sourcePath}`);
    }
    if (declaredRoute !== routeForSource(sourcePath)) {
      fail(`Declared route ${declaredRoute} does not match ${sourcePath}.`);
    }
    const contents = await readFile(repoPath(sourcePath, "route source"), "utf8");
    if (!new RegExp(`export\\s+async\\s+function\\s+${method}\\b`).test(contents)) {
      fail(`${sourcePath} does not export ${method}.`);
    }
    identities.push(`${method} ${declaredRoute}`);
  }
  unique(identities, "ARCHITECTURE.routes");
  return routes.length;
}

async function recursiveFiles(directory: string, suffix: string): Promise<string[]> {
  const absolute = repoPath(directory, "directory");
  const result: string[] = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await recursiveFiles(relative, suffix)));
    else if (entry.isFile() && entry.name.endsWith(suffix)) result.push(relative);
  }
  return result.sort();
}

function markdownSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

function headingSlugs(markdown: string): Set<string> {
  const result = new Set<string>();
  const counts = new Map<string, number>();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gmu)) {
    const base = markdownSlug(match[1]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  return result;
}

async function validateMarkdownLinks(files: readonly string[]): Promise<number> {
  let checked = 0;
  const cache = new Map<string, { markdown: string; slugs: Set<string> }>();
  for (const file of files) {
    const markdown = await readFile(repoPath(file, "Markdown document"), "utf8");
    cache.set(file, { markdown, slugs: headingSlugs(markdown) });
    for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
      let target = match[1].trim().replace(/^<|>$/g, "");
      target = target.split(/\s+["']/u, 1)[0];
      if (/^(?:https?:|mailto:)/iu.test(target)) continue;
      const [rawPath, rawFragment] = target.split("#", 2);
      const decodedPath = decodeURIComponent(rawPath || file);
      const resolved = rawPath
        ? path.posix.normalize(path.posix.join(path.posix.dirname(file), decodedPath))
        : file;
      await assertPath(resolved, `${file} link ${target}`);
      checked += 1;
      if (rawFragment && resolved.endsWith(".md")) {
        const targetDocument = cache.get(resolved) ?? {
          markdown: await readFile(repoPath(resolved, "Markdown link target"), "utf8"),
          slugs: new Set<string>()
        };
        if (targetDocument.slugs.size === 0) {
          targetDocument.slugs = headingSlugs(targetDocument.markdown);
          cache.set(resolved, targetDocument);
        }
        const fragment = decodeURIComponent(rawFragment).toLowerCase();
        if (!targetDocument.slugs.has(fragment)) {
          fail(`${file} links to missing heading #${fragment} in ${resolved}.`);
        }
      }
    }
  }
  return checked;
}

async function main(): Promise<void> {
  const packageJson = await parseJson("package.json");
  const packageVersion = string(packageJson.version, "package.json.version");
  const packageScripts = object(packageJson.scripts, "package.json.scripts");

  const managementEntries = (await readdir(path.join(ROOT, "docs/management")))
    .filter((file) => file.endsWith(".json"))
    .map((file) => `docs/management/${file}`)
    .sort();
  const expectedEntries = [...REQUIRED_MANAGEMENT_FILES].sort();
  if (JSON.stringify(managementEntries) !== JSON.stringify(expectedEntries)) {
    fail(`docs/management must contain exactly: ${expectedEntries.join(", ")}.`);
  }

  const [agent, architecture, automation, index] = await Promise.all([
    parseJson(REQUIRED_MANAGEMENT_FILES[0]),
    parseJson(REQUIRED_MANAGEMENT_FILES[1]),
    parseJson(REQUIRED_MANAGEMENT_FILES[2]),
    parseJson(REQUIRED_MANAGEMENT_FILES[3])
  ]);

  validateTopLevel(
    agent,
    REQUIRED_MANAGEMENT_FILES[0],
    "agent-instructions",
    ["schemaVersion", "id", "kind", "applicationVersion", "scope", "sourceOfTruth", "rules", "securityInvariants", "completionEvidence", "commands"],
    packageVersion
  );
  validateAgentShape(agent);
  validateTopLevel(
    architecture,
    REQUIRED_MANAGEMENT_FILES[1],
    "architecture",
    ["schemaVersion", "id", "kind", "applicationVersion", "deliverySemantics", "components", "dataStores", "contracts", "routes"],
    packageVersion
  );
  validateArchitectureShape(architecture);
  validateTopLevel(
    automation,
    REQUIRED_MANAGEMENT_FILES[2],
    "automation",
    ["schemaVersion", "id", "kind", "applicationVersion", "commands", "entrypoints", "workflows", "testLanes"],
    packageVersion
  );
  validateTopLevel(
    index,
    REQUIRED_MANAGEMENT_FILES[3],
    "management-index",
    ["schemaVersion", "id", "kind", "applicationVersion", "files", "documents", "validator"],
    packageVersion
  );

  const ids = new Map<string, string>();
  for (const [source, value] of [
    [REQUIRED_MANAGEMENT_FILES[0], agent],
    [REQUIRED_MANAGEMENT_FILES[1], architecture],
    [REQUIRED_MANAGEMENT_FILES[2], automation],
    [REQUIRED_MANAGEMENT_FILES[3], index]
  ] as const) {
    collectIds(value, source, ids);
    await validateDeclaredPaths(value, source);
    validateDeclaredCommands(value, source, packageScripts);
  }

  const indexedFileKinds = new Map<string, string>();
  const indexedFiles = array(index.files, "INDEX.files").map((raw, indexPosition) => {
    const entry = object(raw, `INDEX.files[${indexPosition}]`);
    exactKeys(entry, ["id", "path", "kind", "schemaVersion"], `INDEX.files[${indexPosition}]`);
    if (entry.schemaVersion !== SCHEMA_VERSION) fail(`INDEX.files[${indexPosition}] has the wrong schemaVersion.`);
    const filePath = string(entry.path, `INDEX.files[${indexPosition}].path`);
    indexedFileKinds.set(filePath, string(entry.kind, `INDEX.files[${indexPosition}].kind`));
    return filePath;
  });
  unique(indexedFiles, "INDEX.files paths");
  if (JSON.stringify([...indexedFiles].sort()) !== JSON.stringify([...INDEXED_MANAGEMENT_FILES].sort())) {
    fail("INDEX.files must enumerate exactly the other three management files.");
  }
  for (const [filePath, expectedKind] of [
    [REQUIRED_MANAGEMENT_FILES[0], "agent-instructions"],
    [REQUIRED_MANAGEMENT_FILES[1], "architecture"],
    [REQUIRED_MANAGEMENT_FILES[2], "automation"]
  ] as const) {
    if (indexedFileKinds.get(filePath) !== expectedKind) {
      fail(`INDEX.files kind for ${filePath} must be ${expectedKind}.`);
    }
  }

  const documents = array(index.documents, "INDEX.documents").map((raw, position) => {
    const entry = object(raw, `INDEX.documents[${position}]`);
    exactKeys(entry, ["id", "path", "purpose"], `INDEX.documents[${position}]`);
    return string(entry.path, `INDEX.documents[${position}].path`);
  });
  unique(documents, "INDEX.documents paths");
  const actualDocuments = ["CHANGELOG.md", "README.md", ...(await recursiveFiles("docs", ".md"))].sort();
  if (JSON.stringify([...documents].sort()) !== JSON.stringify(actualDocuments)) {
    fail("INDEX.documents must enumerate README.md, CHANGELOG.md, and every docs/**/*.md file.");
  }

  const declaredCommands = array(automation.commands, "AUTOMATION.commands").map((raw, position) => {
    const entry = object(raw, `AUTOMATION.commands[${position}]`);
    exactKeys(entry, ["id", "name", "command", "purpose"], `AUTOMATION.commands[${position}]`);
    const name = string(entry.name, `AUTOMATION.commands[${position}].name`);
    if (entry.command !== `npm run ${name}`) fail(`AUTOMATION command ${name} must be written as npm run ${name}.`);
    if (!(name in packageScripts)) fail(`AUTOMATION declares missing package script ${name}.`);
    return name;
  });
  unique(declaredCommands, "AUTOMATION command names");
  if (JSON.stringify([...declaredCommands].sort()) !== JSON.stringify(Object.keys(packageScripts).sort())) {
    fail("AUTOMATION.commands must enumerate every package.json script exactly once.");
  }

  validateObjectArray(
    automation.entrypoints,
    "AUTOMATION.entrypoints",
    ["id", "scriptPath", "packageScript", "effect"]
  ).forEach((entry, position) => {
    const packageScript = string(entry.packageScript, `AUTOMATION.entrypoints[${position}].packageScript`);
    if (!(packageScript in packageScripts)) {
      fail(`AUTOMATION entrypoint refers to missing package script ${packageScript}.`);
    }
  });
  validateObjectArray(
    automation.testLanes,
    "AUTOMATION.testLanes",
    ["id", "command", "environment", "evidence"]
  );

  const workflows = array(automation.workflows, "AUTOMATION.workflows").map((raw, position) => {
    const entry = object(raw, `AUTOMATION.workflows[${position}]`);
    exactKeys(entry, ["id", "name", "workflowPath", "purpose"], `AUTOMATION.workflows[${position}]`);
    return string(entry.workflowPath, `AUTOMATION.workflows[${position}].workflowPath`);
  });
  unique(workflows, "AUTOMATION workflow paths");
  const actualWorkflows = (await readdir(path.join(ROOT, ".github/workflows")))
    .filter((file) => /\.ya?ml$/u.test(file))
    .map((file) => `.github/workflows/${file}`)
    .sort();
  if (JSON.stringify([...workflows].sort()) !== JSON.stringify(actualWorkflows)) {
    fail("AUTOMATION.workflows must enumerate every workflow file exactly once.");
  }

  const validator = object(index.validator, "INDEX.validator");
  exactKeys(validator, ["id", "path", "command", "checks"], "INDEX.validator");
  if (validator.path !== "scripts/validate-management.ts" || validator.command !== "npm run docs:validate") {
    fail("INDEX.validator must point to the canonical validator and package command.");
  }
  if (array(validator.checks, "INDEX.validator.checks").length === 0) {
    fail("INDEX.validator.checks must not be empty.");
  }

  const routeCount = await validateRoutes(architecture);
  const linkCount = await validateMarkdownLinks(actualDocuments);
  process.stdout.write(
    `PASSED: ${REQUIRED_MANAGEMENT_FILES.length} management files, ${ids.size} unique IDs, ` +
      `${declaredCommands.length} commands, ${workflows.length} workflows, ${routeCount} routes, ` +
      `${actualDocuments.length} documents, and ${linkCount} local links validated.\n`
  );
}

await main().catch((error: unknown) => {
  process.stderr.write(`Management validation failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
