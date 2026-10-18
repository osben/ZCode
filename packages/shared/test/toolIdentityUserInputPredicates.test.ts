import { describe, expect, it } from "vitest";
import {
  isZCodeAskUserQuestionToolName,
  isZCodeExitPlanModeToolName,
  isZCodeUserInputBackedPermissionToolName,
} from "../src/tool-identity.js";

describe("user-input tool name predicates", () => {
  it("matches the exact wire names", () => {
    expect(isZCodeAskUserQuestionToolName("AskUserQuestion")).toBe(true);
    expect(isZCodeExitPlanModeToolName("ExitPlanMode")).toBe(true);
    expect(isZCodeUserInputBackedPermissionToolName("AskUserQuestion")).toBe(true);
    expect(isZCodeUserInputBackedPermissionToolName("ExitPlanMode")).toBe(true);
  });

  it("does not normalize case, whitespace or other tools", () => {
    for (const value of [
      "askuserquestion",
      " AskUserQuestion",
      "exitplanmode",
      "Bash",
      "",
      null,
      undefined,
    ]) {
      expect(isZCodeAskUserQuestionToolName(value)).toBe(false);
      expect(isZCodeExitPlanModeToolName(value)).toBe(false);
      expect(isZCodeUserInputBackedPermissionToolName(value)).toBe(false);
    }
  });
});
