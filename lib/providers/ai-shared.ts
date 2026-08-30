import { createHash } from "node:crypto";
import { aiStageOutputSchemas, type AIStage, type AIStageOutputMap } from "./types";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function inputHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function sourceIdsIn(value: unknown): readonly string[] {
  const found: string[] = [];
  const visit = (item: unknown, parentKey?: string): void => {
    if (
      typeof item === "string" &&
      (parentKey === "markdown" || parentKey === "revisedText")
    ) {
      for (const match of item.matchAll(/\[(?:source:|@)([^\]\s]+)\]/gi)) {
        found.push(match[1]);
      }
      return;
    }
    if (Array.isArray(item)) {
      if (parentKey === "sourceIds" || parentKey === "citationSourceIds") {
        for (const sourceId of item) {
          if (typeof sourceId === "string") {
            found.push(sourceId);
          }
        }
        return;
      }
      item.forEach((value) => visit(value));
      return;
    }
    if (!item || typeof item !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (key === "sourceId" && typeof child === "string") {
        found.push(child);
      } else {
        visit(child, key);
      }
    }
  };
  visit(value);
  return found;
}

export function unknownSourceIds(
  value: unknown,
  allowedSourceIds: readonly string[]
): readonly string[] {
  const allowed = new Set(allowedSourceIds);
  return [...new Set(sourceIdsIn(value).filter((sourceId) => !allowed.has(sourceId)))];
}

export function validateAllowedSourceIds(allowedSourceIds: readonly string[]): void {
  const normalized = allowedSourceIds.map((sourceId) => sourceId.trim());
  if (
    normalized.some((sourceId) => !sourceId) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new Error("allowedSourceIds must contain unique, non-blank IDs");
  }
}

export function parseStageOutput<Stage extends AIStage>(
  stage: Stage,
  value: unknown
): AIStageOutputMap[Stage] {
  return aiStageOutputSchemas[stage].parse(value) as AIStageOutputMap[Stage];
}
