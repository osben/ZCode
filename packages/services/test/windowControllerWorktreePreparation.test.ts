// Controller row projection carries the Host worktree preparation as an optional typed field
// (specs/composer-worktree-setup-steps.md "Command Center worktree deletion treats a prepared,
// not-yet-cancelled session as using its target path and branch"). The wire schema keeps runtime
// validation authoritative; deletion-guard behavior is covered by the ui worktreeProtection tests.
import { describe, expect, it } from "vitest";
import {
  windowHostControllerTaskRowSchema,
  type WindowHostControllerTaskRow,
} from "@zcode/shared/zcode-protocol-v4";

function row(overrides: Partial<WindowHostControllerTaskRow> = {}): WindowHostControllerTaskRow {
  return windowHostControllerTaskRowSchema.parse({
    address: {
      workspacePath: "/repo",
      taskId: "task-1",
    },
    meta: {
      taskId: "task-1",
      workspacePath: "/repo",
      title: "Worktree feature",
      traceId: "trace-1",
      mode: "default",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    },
    membership: { pinned: false, archived: false, active: false },
    sourceAvailability: "online",
    liveStatus: "idle",
    ...overrides,
  });
}

describe("windowHostControllerTaskRow worktreePreparation", () => {
  it("accepts a prepared session's worktree fact as an optional field", () => {
    const parsed = row({
      worktreePreparation: {
        status: "preparing",
        branchName: "feature",
        targetPath: "/repo/worktrees/feature",
        attemptId: "attempt-1",
      },
    });
    expect(parsed.worktreePreparation).toMatchObject({
      status: "preparing",
      branchName: "feature",
      targetPath: "/repo/worktrees/feature",
    });
    // Older rows without the field stay valid.
    expect(row().worktreePreparation).toBeUndefined();
  });

  it("rejects an invalid preparation status", () => {
    expect(() =>
      row({
        worktreePreparation: {
          status: "active",
          branchName: "feature",
          targetPath: "/repo/worktrees/feature",
        } as never,
      }),
    ).toThrow();
  });
});
