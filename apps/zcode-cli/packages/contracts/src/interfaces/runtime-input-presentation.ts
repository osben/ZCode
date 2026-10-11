import { z } from "zod";

/** Single marker for the source and actual consumption form; do not retroactively convert older history where it is missing. */
export const RuntimeInputPresentationSchema = z.enum([
  "user_steer",
  "coordinator_steer",
  "coordinator_input",
  "subagent_reply_steer",
  "subagent_reply",
  "task_notification_steer",
  "task_notification",
]);
export type RuntimeInputPresentation = z.infer<typeof RuntimeInputPresentationSchema>;

export function parseRuntimeInputPresentation(
  value: unknown,
): RuntimeInputPresentation | undefined {
  const result = RuntimeInputPresentationSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
