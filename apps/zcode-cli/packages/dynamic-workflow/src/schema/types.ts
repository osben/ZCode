/**
 * Shared vocabulary for the schema subsystem: the JSON Schema subset we emit and the violation
 * model produced by the validator. {@link JsonSchema} here is not a generic JSON Schema; it exactly
 * matches the keyword set produced by {@link synthesizeAskSchemas}, and the validator understands
 * only this subset.
 */

/** Any valid JSON value. Represents literals used in const/enum/default. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** JSON Schema primitive type labels we emit. The validator supports `integer`, but synthesis does not produce it. */
export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null"
  | "array"
  | "object";

/**
 * The JSON Schema subset we emit. Fields are a union of optional keywords; a specific schema uses
 * only the few relevant to its shape (for example, an object schema uses
 * properties/required/additionalProperties, while a union uses enum or anyOf). The validator only
 * handles keywords listed here.
 */
export interface JsonSchema {
  // Structure
  type?: JsonSchemaType | JsonSchemaType[];
  const?: JsonValue;
  enum?: JsonValue[];
  anyOf?: JsonSchema[];
  // object
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  // array / tuple
  items?: JsonSchema;
  prefixItems?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
  // String constraints
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  // Number constraints
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  // Annotations
  description?: string;
  default?: JsonValue;
  // Recursive types: reference and definition table
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
}

/**
 * One violation produced by the validator, designed to go directly into a repair tool_result: one
 * per line, containing the JSON path, expected value/shape, and actual value.
 */
export interface Violation {
  /** JSON path where the violation occurred, such as `$`, `$.foo`, `$.items[0]`. */
  path: string;
  /** Short description of the expected shape/value. */
  expected: string;
  /** Short description of the actual value. */
  got: string;
}

/** Synthesis-side diagnostic code. 9001 is used by the facade-siting rule (see analysis/sites.ts). */
export const SCHEMA_DIAGNOSTIC_CODE = 9002;

/**
 * Maximum number of union members. Exceeding it is treated as a “pathologically wide union” and
 * diagnosed at the ask site.
 *
 * Set to 100: enough for reasonable enums (common enums such as status or country codes are much
 * smaller), but still catches clearly runaway types. Applies to both literal-union (`→ enum`) and
 * general-union (`→ anyOf`) member counts.
 *
 * In practice, this is usually triggered not by a hand-written giant union but by a Cartesian
 * product after the checker expands template literal types—for example, `` `${Dir}-${Size}` ``
 * expands into a literal union of all combinations, and crossing a few dimensions can explode.
 */
export const MAX_UNION_MEMBERS = 100;
