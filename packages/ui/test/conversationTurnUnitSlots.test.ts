// The worktree setup/created row must stay the SECOND timeline item: attached to the first
// render unit after its user inputs, or its own timeline-only unit while no transcript row
// exists yet (specs/composer-worktree-setup-steps.md, Timeline presentation).
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { withAfterFirstUserInputSlot } from "@/v4/conversationTurnUnitSlots.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnitTypes.js";
import { formatWorktreeAddCommand } from "@/v4/worktreeCommandText.js";

const SLOT = createElement("div", { "data-worktree-slot": "true" });

function unit(key: string): ConversationTurnRenderUnit {
  return {
    key,
    turnId: key,
    visibleUserInputs: [],
    assistantWorkRows: [],
    assistantHistoryRows: [],
    assistantFollowingRows: [],
    assistantTailRows: [],
    browserTurnEndRows: [],
    hookInvocations: [],
    assistantTextRows: [],
    leadingBoundaryRows: [],
    flowItems: [],
    renderRows: [],
    isLastTurn: false,
    isRunning: false,
    assistantHistoryDefaultOpen: false,
    timelineOnly: false,
  };
}

describe("withAfterFirstUserInputSlot", () => {
  it("attaches the slot to the first unit only", () => {
    const units = withAfterFirstUserInputSlot([unit("a"), unit("b")], SLOT);
    expect(units).toHaveLength(2);
    expect(units[0]!.afterFirstUserInputSlot).toBe(SLOT);
    expect(units[1]!.afterFirstUserInputSlot).toBeUndefined();
    // Original units are not mutated.
    expect(units[1]!.key).toBe("b");
  });

  it("becomes its own timeline-only unit while no transcript rows exist", () => {
    const units = withAfterFirstUserInputSlot([], SLOT);
    expect(units).toHaveLength(1);
    expect(units[0]!.timelineOnly).toBe(true);
    expect(units[0]!.afterFirstUserInputSlot).toBe(SLOT);
    expect(units[0]!.isLastTurn).toBe(true);
  });

  it("passes units through untouched without a slot", () => {
    const units = [unit("a")];
    expect(withAfterFirstUserInputSlot(units, null)).toBe(units);
  });
});

describe("formatWorktreeAddCommand", () => {
  it("names the base branch when known", () => {
    expect(
      formatWorktreeAddCommand({
        branchName: "zcode/sleepy-capybara",
        targetPath: "/dev/wt/capy",
        baseBranch: "main",
      }),
    ).toBe("git worktree add -b zcode/sleepy-capybara -- /dev/wt/capy main");
  });

  it("falls back to literal HEAD for the HEAD-default flow and omits the base otherwise", () => {
    expect(
      formatWorktreeAddCommand({
        branchName: "b",
        targetPath: "/dev/wt",
        baseFromHeadDefault: true,
      }),
    ).toBe("git worktree add -b b -- /dev/wt HEAD");
    expect(formatWorktreeAddCommand({ branchName: "b", targetPath: "/dev/wt" })).toBe(
      "git worktree add -b b -- /dev/wt",
    );
  });
});
