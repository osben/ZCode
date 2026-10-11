import { z } from "zod";

/** Keep auto as an internal permission; accept plan only at the legacy-format read boundary. */
export const executionPermissionModeSchema = z.enum(["build", "edit", "yolo", "guarded", "auto"]);
export const executionStateSchema = z.object({
  mode: executionPermissionModeSchema,
  planEnabled: z.boolean(),
});
export type ExecutionState = z.infer<typeof executionStateSchema>;

/** Fix legacy request semantics at the admission boundary; do not reinterpret them using current configuration when consuming the queue. */
export function resolveExecutionState(
  input: { mode?: string; planEnabled?: boolean },
  current: ExecutionState = { mode: "build", planEnabled: false },
): ExecutionState {
  const mode = executionPermissionModeSchema.safeParse(input.mode);
  return {
    mode: mode.success ? mode.data : current.mode,
    planEnabled:
      input.planEnabled ??
      (input.mode === "plan" ? true : mode.success ? false : current.planEnabled),
  };
}
