/**
 * Shape validation for preset artifact specs.
 *
 * ⚠ Terminology: artifact means a **user-facing output** (a dashboard published by a script), not
 * the top-level return value `RunSettlement.artifact`.
 *
 * Why validation belongs in the **engine core** instead of the driver: preset declarations never
 * pass through the driver (they have no executable effect), and an invalidly shaped spec must be
 * rejected before it reaches the journal. Journal records are the single source of truth for
 * projections and cold restore; an unrenderable spec stored there would fail again on every read
 * surface.
 *
 * Why handwritten validation instead of zod: this package has no runtime dependencies (facade,
 * compiler, and engine rely only on TypeScript), and the spec fits on one screen. Adding a schema
 * library to validate four objects would change the dependency premise for the entire pure package.
 *
 * Return a **human-readable sentence** rather than a boolean: this message is stored in the run's
 * failure_json through `ArtifactSpecInvalid`, and a reader (model or author) needs it to revise the
 * script; “invalid spec” is not useful.
 */

import { ARTIFACT_CAPS } from "../facade/artifact-caps.js";
import type { ArtifactPresetOp } from "../facade/registry.js";
import { canonicalJson } from "./hash.js";

/** Reason an entry is invalid; `undefined` means it passes. */
type ArtifactSpecProblem = string | undefined;

/**
 * Validate a preset spec. `op` determines required fields; common checks (title/description
 * lengths) apply to all four kinds.
 * A passing spec is a plain object with all required fields of the correct shape and no more than
 * 8 KB after normalization.
 */
export function validateArtifactSpec(op: ArtifactPresetOp, spec: unknown): ArtifactSpecProblem {
  if (!isPlainObject(spec)) return `${op} spec must be an object literal, got ${describe(spec)}`;

  const common = checkOptions(spec);
  if (common !== undefined) return common;

  const shape = checkShape(op, spec);
  if (shape !== undefined) return shape;

  // Check the size limit last: report specific shape errors before size. If a spec is both malformed
  // and oversized, the author should first learn what is malformed.
  const bytes = utf8ByteLength(canonicalJson(spec));
  if (bytes > ARTIFACT_CAPS.maxSpecSerializedBytes) {
    return `${op} spec is ${bytes} bytes serialized, over the ${ARTIFACT_CAPS.maxSpecSerializedBytes}-byte limit`;
  }
  return undefined;
}

function checkShape(op: ArtifactPresetOp, spec: Record<string, unknown>): ArtifactSpecProblem {
  if (op === "chart") {
    const x = checkField(spec.x, "x");
    if (x !== undefined) return x;
    const y = spec.y;
    if (Array.isArray(y)) {
      if (y.length === 0) return "chart spec y is an empty array; give it at least one series";
      for (const [index, entry] of y.entries()) {
        const problem = checkField(entry, `y[${index}]`);
        if (problem !== undefined) return problem;
      }
    } else {
      const problem = checkField(y, "y");
      if (problem !== undefined) return problem;
    }
    if (spec.type !== undefined && !["line", "bar", "scatter"].includes(String(spec.type))) {
      return `chart spec type must be "line", "bar" or "scatter", got ${describe(spec.type)}`;
    }
    if (spec.scale !== undefined && !["linear", "log"].includes(String(spec.scale))) {
      return `chart spec scale must be "linear" or "log", got ${describe(spec.scale)}`;
    }
    if (spec.baseline !== undefined) return checkField(spec.baseline, "baseline");
    return undefined;
  }
  if (op === "table") {
    const columns = checkFieldList(spec.columns, "columns");
    if (columns !== undefined) return columns;
    if (spec.key !== undefined && !isNonEmptyString(spec.key)) {
      return "table spec key must be a non-empty string (the field that identifies a row)";
    }
    return undefined;
  }
  if (op === "metrics") return checkFieldList(spec.metrics, "metrics");
  // board
  if (!isNonEmptyString(spec.key)) return "board spec key must be a non-empty string (the field that identifies a card)";
  if (!isNonEmptyString(spec.status)) {
    return "board spec status must be a non-empty string (the field that picks a card's column)";
  }
  if (!Array.isArray(spec.columns) || spec.columns.length === 0) {
    return "board spec columns must be a non-empty array of strings (the column order)";
  }
  for (const [index, column] of spec.columns.entries()) {
    if (!isNonEmptyString(column)) return `board spec columns[${index}] must be a non-empty string`;
  }
  // cardTitle is a **field name** (which field serves as the card title), distinct from
  // ArtifactOptions.title (the dashboard's own title). They previously collided under one key; the
  // rename lets a board specify both.
  if (spec.cardTitle !== undefined && !isNonEmptyString(spec.cardTitle)) {
    return "board spec cardTitle must be a non-empty string (the field used as the card title)";
  }
  if (spec.detail !== undefined) return checkFieldList(spec.detail, "detail");
  return undefined;
}

/** Shared display metadata (`ArtifactOptions`): types and lengths. */
function checkOptions(spec: Record<string, unknown>): ArtifactSpecProblem {
  if (spec.title !== undefined) {
    if (typeof spec.title !== "string") return `spec title must be a string, got ${describe(spec.title)}`;
    if (spec.title.length > ARTIFACT_CAPS.maxTitleLength) {
      return `spec title is ${spec.title.length} characters, over the ${ARTIFACT_CAPS.maxTitleLength} limit`;
    }
  }
  if (spec.description !== undefined) {
    if (typeof spec.description !== "string") {
      return `spec description must be a string, got ${describe(spec.description)}`;
    }
    if (spec.description.length > ARTIFACT_CAPS.maxDescriptionLength) {
      return `spec description is ${spec.description.length} characters, over the ` +
      `${ARTIFACT_CAPS.maxDescriptionLength} limit`;
    }
  }
  if (spec.primary !== undefined && typeof spec.primary !== "boolean") {
    return `spec primary must be a boolean, got ${describe(spec.primary)}`;
  }
  return undefined;
}

/** A non-empty list of `ArtifactField`s. */
function checkFieldList(value: unknown, where: string): ArtifactSpecProblem {
  if (!Array.isArray(value) || value.length === 0) {
    return `spec ${where} must be a non-empty array of fields ({ field: "…" })`;
  }
  for (const [index, entry] of value.entries()) {
    const problem = checkField(entry, `${where}[${index}]`);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** An `ArtifactField`: `field` must be a non-empty string (dot path); label / unit are optional. */
function checkField(value: unknown, where: string): ArtifactSpecProblem {
  if (!isPlainObject(value)) return `spec ${where} must be { field: "…" }, got ${describe(value)}`;
  if (!isNonEmptyString(value.field)) {
    return `spec ${where}.field must be a non-empty string (a dot path into the item, e.g. "timing.after")`;
  }
  for (const key of ["label", "unit"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      return `spec ${where}.${key} must be a string, got ${describe(value[key])}`;
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Describe the actual value in an error message (do not print the whole object; an 8 KB spec would fill failure_json). */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array (${value.length} items)`;
  if (typeof value === "object") return "object";
  if (typeof value === "string") return JSON.stringify(value.slice(0, 40));
  return String(value);
}

/** UTF-8 byte length (same measurement as the report limit). */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
