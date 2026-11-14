import type { GoalStatus } from "@zcode/contracts";

/**
 * The only automatic-promotion gate for the regular queue. Do not add a fail-open bypass here:
 * verifier still persists the target as complete first, then shares this check with explicit pass.
 */
export function shouldAutoDrainV4QueueHead(input: {
  autoDrain: boolean;
  dispatchState: "queued" | "reserved" | "promoting";
  /** 队首正被 composer 编辑态冻结：续跑停在这里，后面的项保持顺序等待。 */
  editLocked?: boolean;
  sessionBusy: boolean;
  targetStatus: GoalStatus | null;
}): boolean {
  return (
    input.autoDrain &&
    input.dispatchState === "queued" &&
    input.editLocked !== true &&
    !input.sessionBusy &&
    (input.targetStatus === null || input.targetStatus === "complete")
  );
}
