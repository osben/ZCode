import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IZCodeTaskService, ZCodeTaskEraseResult } from "@zcode/services";
import { eraseHiddenRows } from "@/session-manager/sessionManagerErase.js";
import type { SessionManagerRow } from "@/session-manager/sessionManagerModel.js";

// specs/session-deletion-cascade.md §4: file-cleanup failures are reported even when no session stays retained.

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast.js", () => ({ toast }));
vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

beforeEach(() => toast.mockClear());

const row = (taskId: string): SessionManagerRow =>
  ({
    task: { taskId, workspacePath: "/project" },
    taskKey: taskId,
    workspaceKey: "/project",
  }) as unknown as SessionManagerRow;

const result = (patch: Partial<ZCodeTaskEraseResult>): ZCodeTaskEraseResult => ({
  erasedTaskIds: [],
  skippedTaskIds: [],
  blockedRunningTaskIds: [],
  failedTaskIds: [],
  fileFailureCount: 0,
  filesRetainedCount: 0,
  ...patch,
});

function run(eraseResult: ZCodeTaskEraseResult | null) {
  const service = { eraseTasks: vi.fn(async () => eraseResult) } as unknown as IZCodeTaskService;
  return eraseHiddenRows([row("a"), row("b")], {
    resolveRowServices: () => service,
    reportError: vi.fn(),
    formatMessage: (id, values) => (values ? `${id}:${Object.values(values).join("|")}` : id),
  });
}

describe("eraseHiddenRows", () => {
  it("stays quiet when everything was erased cleanly", async () => {
    await run(result({ erasedTaskIds: ["a", "b"] }));
    expect(toast).not.toHaveBeenCalled();
  });

  it("warns about file failures and reports the sessions that stay hidden", async () => {
    await run(result({ erasedTaskIds: ["a"], failedTaskIds: ["b"], fileFailureCount: 2 }));
    expect(toast.mock.calls.map(([message]) => message)).toEqual([
      "sessionManager.erase.result:1|1",
      "sessionManager.erase.filesFailed",
    ]);
  });

  it("explains an unsupported workspace instead of failing silently", async () => {
    await run(null);
    expect(toast).toHaveBeenCalledWith("sessionManager.erase.unsupported");
  });
});
