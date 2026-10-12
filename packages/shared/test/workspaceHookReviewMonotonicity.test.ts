import { describe, expect, it } from "vitest";
// Bugfix(2026-08-07): D16 single-source-of-truth requires importing the monotonicity module directly; this
// re-export through the discovery barrel once broke the packages/ui Desktop build chain (app failed to reopen after restart), so it was removed.
import {
  verdictWorkspaceHookReviewRequest,
  type WorkspaceHookReviewIdentity,
} from "../src/workspace-hook-review-monotonicity.js";

const current: WorkspaceHookReviewIdentity = {
  reviewFlowId: "flow-a",
  generation: 2,
  interactionId: "interaction-2",
};

describe("workspace Hook review 单调性裁决（D16 单一来源）", () => {
  it("无当前权威时任何 candidate 都可接管", () => {
    expect(
      verdictWorkspaceHookReviewRequest(undefined, {
        reviewFlowId: "flow-a",
        generation: 1,
        interactionId: "interaction-1",
      }),
    ).toBe("no_current");
  });

  it("同 flow 更高 generation 接受（supersede）", () => {
    expect(
      verdictWorkspaceHookReviewRequest(current, {
        reviewFlowId: "flow-a",
        generation: 3,
        interactionId: "interaction-3",
      }),
    ).toBe("same_flow_advance");
  });

  it("同 flow 更低 generation 拒收（迟到事件）", () => {
    expect(
      verdictWorkspaceHookReviewRequest(current, {
        reviewFlowId: "flow-a",
        generation: 1,
        interactionId: "interaction-1",
      }),
    ).toBe("same_flow_stale");
  });

  it("同 generation 同 interactionId 是幂等 replay", () => {
    expect(
      verdictWorkspaceHookReviewRequest(current, {
        reviewFlowId: "flow-a",
        generation: 2,
        interactionId: "interaction-2",
      }),
    ).toBe("same_flow_replay");
  });

  it("同 generation 换 interactionId 违反 controller 单调性", () => {
    expect(
      verdictWorkspaceHookReviewRequest(current, {
        reviewFlowId: "flow-a",
        generation: 2,
        interactionId: "interaction-other",
      }),
    ).toBe("same_flow_conflict");
  });

  it("跨 flow 一律 cross_flow，即便 generation 更高或更低", () => {
    // After a Runtime generation change, generation restarts at 1, so generations across flows are not comparable;
    // whether to admit is decided by the caller based on own-epoch evidence (SessionResumed etc.).
    expect(
      verdictWorkspaceHookReviewRequest(current, {
        reviewFlowId: "flow-b",
        generation: 1,
        interactionId: "interaction-1",
      }),
    ).toBe("cross_flow");
    expect(
      verdictWorkspaceHookReviewRequest(current, {
        reviewFlowId: "flow-b",
        generation: 9,
        interactionId: "interaction-9",
      }),
    ).toBe("cross_flow");
  });
});
