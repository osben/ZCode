import { logger } from "@/logger.js";

export type BranchSwitchGuard = (targetBranchName: string) => Promise<boolean>;

/**
 * Runs a branch switch after the optional guard allows it. A rejecting guard fails closed: the
 * switch does not run and the error is logged instead of surfacing as an unhandled rejection.
 */
export async function runAfterBranchSwitchGuard(
  guard: BranchSwitchGuard | undefined,
  targetBranchName: string,
  run: () => Promise<unknown>,
): Promise<void> {
  if (!guard) {
    await run();
    return;
  }
  let allowed: boolean;
  try {
    allowed = await guard(targetBranchName);
  } catch (error) {
    logger.warn("[GitBranchSwitcher] branch switch guard failed", error);
    return;
  }
  if (allowed) await run();
}
