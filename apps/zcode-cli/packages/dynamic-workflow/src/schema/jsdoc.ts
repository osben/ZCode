import ts from "typescript";
import type { JsonSchema, JsonValue } from "./types.js";

/**
 * JSDoc harvesting: extract documentation comments and supported constraint tags from symbols
 * (interface members, type aliases, and ask result types) as JSON Schema fragments.
 *
 * - Documentation body → `description`.
 * - Supported tag subset → constraint keywords: `@minimum @maximum @exclusiveMinimum @exclusiveMaximum
 *   @minLength @maxLength @pattern @format @minItems @maxItems @default`。
 *
 * Tags outside this subset are silently ignored (they are not errors).
 */

/** Numeric tags → corresponding numeric keyword names. */
const NUMERIC_TAGS: Record<string, keyof JsonSchema> = {
  exclusiveMaximum: "exclusiveMaximum",
  exclusiveMinimum: "exclusiveMinimum",
  maximum: "maximum",
  maxItems: "maxItems",
  maxLength: "maxLength",
  minimum: "minimum",
  minItems: "minItems",
  minLength: "minLength",
};

/** String tags → corresponding string keyword names. */
const STRING_TAGS: Record<string, keyof JsonSchema> = {
  format: "format",
  pattern: "pattern",
};

/**
 * Harvest the description and constraint tags from a symbol. Return a schema fragment containing
 * only relevant keywords for the synthesis side to merge into the schema for that symbol.
 */
export function harvestConstraints(symbol: ts.Symbol, checker: ts.TypeChecker): Partial<JsonSchema> {
  const out: Partial<JsonSchema> = {};

  const doc = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  if (doc.length > 0) out.description = doc;

  for (const tag of symbol.getJsDocTags(checker)) applyTag(out, tag);
  return out;
}

function applyTag(out: Partial<JsonSchema>, tag: ts.JSDocTagInfo): void {
  const raw = ts.displayPartsToString(tag.text).trim();

  const numericKey = NUMERIC_TAGS[tag.name];
  if (numericKey !== undefined) {
    const value = Number(raw);
    if (Number.isFinite(value)) (out as Record<string, unknown>)[numericKey] = value;
    return;
  }

  const stringKey = STRING_TAGS[tag.name];
  if (stringKey !== undefined) {
    if (raw.length > 0) (out as Record<string, unknown>)[stringKey] = raw;
    return;
  }

  if (tag.name === "default") {
    out.default = parseDefault(raw);
  }
  // Ignore tags outside the supported subset.
}

/** Parse `@default` as JSON first (number/boolean/object/array/quoted string); if parsing fails, treat it as a bare string. */
function parseDefault(raw: string): JsonValue {
  if (raw.length === 0) return "";
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return raw;
  }
}

/** Merge harvested fragments into an existing schema: add constraint keywords without overwriting an existing description. */
export function mergeConstraints(schema: JsonSchema, extra: Partial<JsonSchema>): JsonSchema {
  const merged: JsonSchema = { ...schema };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if (key === "description" && merged.description !== undefined) continue;
    (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}
