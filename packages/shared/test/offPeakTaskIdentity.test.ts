import { describe, expect, it } from "vitest";
import { isOffPeakTask } from "../src/zcode-task-types.js";

// D48: moon identity for off-peak sessions/phantom rows relies solely on the persisted meta flag, no longer on the UI looking up the off-peak store.
describe("isOffPeakTask", () => {
  it("携带 offPeakTaskId 标记的 task 判定为闲时任务", () => {
    expect(isOffPeakTask({ offPeakTaskId: "offpeak-1" })).toBe(true);
  });

  it("无标记或空标记不判定为闲时任务", () => {
    expect(isOffPeakTask({})).toBe(false);
    expect(isOffPeakTask({ offPeakTaskId: undefined })).toBe(false);
  });

  it("与 cron 标记互不干扰（D45 兄弟实体各用各的标记）", () => {
    expect(isOffPeakTask({ cronAutomationId: "automation-1" } as never)).toBe(
      false,
    );
  });
});
