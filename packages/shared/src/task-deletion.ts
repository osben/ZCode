import { z } from "zod";

const id = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
const count = z.number().int().nonnegative();
const cleanupItem = z.object({ targetPath: id, reason: id }).strict();

/** Host-owned Git outcomes; the CLI session/eraseTree response deliberately does not carry them. */
export const zcodeTaskWorktreeCleanupResultSchema = z
  .object({
    removed: z.array(id),
    retained: z.array(cleanupItem),
    failed: z.array(cleanupItem),
    removedCount: count,
    retainedCount: count,
    failedCount: count,
  })
  .strict()
  .refine(
    (value) =>
      value.removedCount === value.removed.length &&
      value.retainedCount === value.retained.length &&
      value.failedCount === value.failed.length,
    { message: "Worktree counts must match their outcome arrays" },
  );

export const zcodeTaskEraseResultSchema = z
  .object({
    erasedTaskIds: z.array(id),
    skippedTaskIds: z.array(id),
    blockedRunningTaskIds: z.array(id),
    failedTaskIds: z.array(id),
    fileFailureCount: count,
    filesRetainedCount: count,
    worktreeCleanup: zcodeTaskWorktreeCleanupResultSchema,
  })
  .strict();
