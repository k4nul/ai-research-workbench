import { projectIntakeSchema, type ProjectIntake } from "@/lib/validation";

const markdownFields: Record<string, keyof ProjectIntake> = {
  "client": "clientName",
  "core question": "coreQuestion",
  "background": "background",
  "purpose": "purpose",
  "audience": "audience",
  "scope": "scope",
  "exclusions": "exclusions",
  "jurisdiction": "jurisdiction",
  "research date": "researchDate",
  "deadline": "deadline",
  "special requirements": "specialRequirements"
};

export function parseIntakeImport(
  format: "json" | "markdown",
  content: string,
  today = new Date().toISOString().slice(0, 10)
): ProjectIntake {
  if (format === "json") {
    const parsed: unknown = JSON.parse(content);
    return projectIntakeSchema.parse(parsed);
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const title = lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "").trim();
  const raw: Record<string, unknown> = {
    mode: "detailed",
    name: title,
    researchDate: today,
    sourceMaxAgeDays: 365,
    deliverableFormats: ["MARKDOWN", "HTML", "PDF", "DOCX", "ZIP"]
  };
  let currentField: keyof ProjectIntake | undefined;
  const values: Partial<Record<keyof ProjectIntake, string[]>> = {};

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      currentField = markdownFields[heading[1].trim().toLowerCase()];
      continue;
    }
    if (!currentField || !line.trim()) {
      continue;
    }
    values[currentField] ??= [];
    values[currentField]?.push(line.trim());
  }
  for (const [field, parts] of Object.entries(values)) {
    raw[field] = parts?.join("\n");
  }
  return projectIntakeSchema.parse(raw);
}
