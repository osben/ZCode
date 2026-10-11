import type { z } from "zod";

/** Preserve each field's original schema, deriving only the defaults/nullability needed for overrides; callers derive nested structures explicitly. */
export function sparseShape<T extends Record<string, z.ZodType>>(shape: T) {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [key, schema.nullable().optional()]),
  ) as { [K in keyof T]: z.ZodOptional<z.ZodNullable<T[K]>> };
}
