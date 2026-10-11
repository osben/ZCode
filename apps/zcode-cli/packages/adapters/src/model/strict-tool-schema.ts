// ============================================================
// Anthropic strict tool schema: eligibility checks + subset folding.
// ============================================================
// Anthropic `strict: true` uses constrained decoding to ensure tool_use.input exactly matches
// input_schema, but accepts only a subset of JSON Schema (API documentation: "JSON Schema Limitations"):
//   Supported: object/array/string/integer/number/boolean/null, enum/const/anyOf/allOf,
//              a set of string formats, and `additionalProperties: false` (all object fields required).
//   Unsupported: numeric constraints (minimum/maximum/multipleOf), string length constraints,
//                complex array constraints, recursive $ref, and `additionalProperties` values other than false.
// This module converts a regular schema into an equivalent schema in the strict subset: foldable
// constraints are **folded into descriptions** (the model can still read them and engine-side
// validators still enforce them); unrepresentable shapes return undefined (the caller sends the
// original schema without strict).
// The first consumer is the typed `submit_result` for dwf mono subagents.

import type { JsonSchema } from "@zcode/contracts";

/** String formats recognized by strict mode; fold other formats into the description. */
const STRICT_STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** Keywords folded into the description and their wording. */
const FOLDED_KEYWORDS: Record<string, (value: unknown) => string> = {
  minimum: (v) => `minimum ${String(v)}`,
  maximum: (v) => `maximum ${String(v)}`,
  exclusiveMinimum: (v) => `greater than ${String(v)}`,
  exclusiveMaximum: (v) => `less than ${String(v)}`,
  multipleOf: (v) => `multiple of ${String(v)}`,
  minLength: (v) => `at least ${String(v)} characters`,
  maxLength: (v) => `at most ${String(v)} characters`,
  pattern: (v) => `must match /${String(v)}/`,
  minItems: (v) => `at least ${String(v)} items`,
  maxItems: (v) => `at most ${String(v)} items`,
  default: (v) => `default ${JSON.stringify(v)}`,
};

/**
 * Check whether modelId is a direct first-party Anthropic model (bare `claude-` prefix;
 * gateway route IDs such as `anthropic/claude-…` do not qualify). Only first-party models use strict.
 * Compatible gateways may reject unknown tool fields, so eligibility checks must remain separate
 * from provider capability checks; when eligibility is uncertain, keep regular schema behavior.
 */
export function isAnthropicFirstPartyModelId(modelId: string | undefined): boolean {
  return typeof modelId === "string" && modelId.startsWith("claude-");
}

/**
 * Convert the schema into an equivalent form in the strict subset; return undefined for unrepresentable shapes.
 *
 * Unrepresentable: `$ref`/`$defs` (recursive), `additionalProperties` as a schema (`Record<string, T>`),
 * empty schema `{}` (`unknown`, with no type to constrain), and tuples (`prefixItems`). Foldable:
 * FOLDED_KEYWORDS and `format` values outside strict. Add `additionalProperties: false` when an
 * object omits it (the schema synthesizer already emits it).
 */
export function toStrictToolSchema(schema: JsonSchema): JsonSchema | undefined {
  const out = strictNode(schema);
  return out === INELIGIBLE ? undefined : out;
}

const INELIGIBLE = Symbol("ineligible");
type StrictNode = JsonSchema | typeof INELIGIBLE;

function strictNode(node: JsonSchema): StrictNode {
  if ("$ref" in node || "$defs" in node || "prefixItems" in node) return INELIGIBLE;

  const notes: string[] = [];
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    const fold = FOLDED_KEYWORDS[key];
    if (fold !== undefined) {
      notes.push(fold(value));
      continue;
    }
    if (key === "format" && typeof value === "string" && !STRICT_STRING_FORMATS.has(value)) {
      notes.push(`format ${value}`);
      continue;
    }
    out[key] = value;
  }

  // Recurse through properties / items / anyOf / allOf / additionalProperties.
  if (isRecord(out.properties)) {
    const properties: Record<string, JsonSchema> = {};
    for (const [name, child] of Object.entries(out.properties)) {
      if (!isRecord(child)) return INELIGIBLE;
      const strictChild = strictNode(child);
      if (strictChild === INELIGIBLE) return INELIGIBLE;
      properties[name] = strictChild;
    }
    out.properties = properties;
  }
  if (isRecord(out.items)) {
    const items = strictNode(out.items);
    if (items === INELIGIBLE) return INELIGIBLE;
    out.items = items;
  }
  for (const combinator of ["anyOf", "allOf"] as const) {
    const branches = out[combinator];
    if (!Array.isArray(branches)) continue;
    const strictBranches: JsonSchema[] = [];
    for (const branch of branches) {
      if (!isRecord(branch)) return INELIGIBLE;
      const strictBranch = strictNode(branch);
      if (strictBranch === INELIGIBLE) return INELIGIBLE;
      strictBranches.push(strictBranch);
    }
    out[combinator] = strictBranches;
  }

  const types = Array.isArray(out.type) ? out.type : out.type === undefined ? [] : [out.type];
  if (types.includes("object")) {
    // Record<string, T>: additionalProperties is a schema, which the strict subset cannot express.
    if (isRecord(out.additionalProperties)) return INELIGIBLE;
    if (out.additionalProperties !== false) out.additionalProperties = false;
    if (!isRecord(out.properties)) out.properties = {};
  }
  // Empty schema (unknown): there is nothing to constrain, and strict does not accept it.
  if (Object.keys(out).length === 0 && notes.length === 0) return INELIGIBLE;

  if (notes.length > 0) {
    const existing = typeof out.description === "string" ? out.description.trim() : "";
    const folded = notes.join("; ");
    out.description = existing.length > 0 ? `${existing} (${folded})` : folded;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
