import { z } from "zod";

export const worktreePreparationCreateSessionFields = {
  /** Reserve the conversation identity without materializing an AgentRuntime. */
  worktreePreparation: z
    .object({
      branchName: z.string().min(1),
      targetPath: z.string().min(1),
      baseBranch: z.string().optional(),
    })
    .optional(),
  /** Activate a Host-prepared identity after the requested worktree exists. */
  preparedSessionId: z.string().min(1).optional(),
};

export const updateWorktreePreparationPayloadSchema = z.object({
  status: z.enum(["preparing", "failed", "cancelled"]),
  failureMessage: z.string().optional(),
  worktreePreparation: z
    .object({
      branchName: z.string().min(1),
      targetPath: z.string().min(1),
      baseBranch: z.string().optional(),
    })
    .optional(),
});

export const worktreePreparationUpdatedResultSchema = z.object({
  type: z.literal("worktreePreparationUpdated"),
  status: z.enum(["preparing", "failed", "cancelled"]),
});
