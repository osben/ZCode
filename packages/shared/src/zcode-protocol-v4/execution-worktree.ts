// Leaf module: the execution worktree schema is imported by sessions-index and controller while zcode-protocol/index
// is still evaluating (cycle), so it must not depend on that barrel at module-evaluation time.
import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

/**
 * Execution worktree for sessions whose agent runs in a linked git worktree while the session
 * stays listed under the parent workspace. `path` is the absolute worktree directory used as the
 * session execution cwd; `branchName` is the checked-out branch, persisted for display only.
 */
export const zcodeExecutionWorktreeSchema = z
  .object({
    path: nonEmptyString,
    // Optional: cold sessions-index seeds read the persisted row where the branch may be absent.
    branchName: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeExecutionWorktree = z.infer<typeof zcodeExecutionWorktreeSchema>;
