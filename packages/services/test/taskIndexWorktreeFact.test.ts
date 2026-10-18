// BUG-GWT-010 (docs/testing/git-worktree-qa/bugs/BUG-GWT-010.md): the execution-worktree fact of a
// session is merged into listTaskList only from the live sessions-index overlay held in Host memory
// (windowHostControllerService.ts sessionOverlay / windowHostControllerProjection.ts buildSourceRows).
// Nothing ever persists the fact into tasks-index meta_json, so after an app restart every session of
// a still-closed workspace loses the sidebar worktree marker and the Settings -> Sessions Environment
// classification until the workspace is opened again. Services-level repro with a real TaskIndexRepo
// (temp sqlite): the live phase delivers the fact through a sessions-index snapshot frame (today the
// only channel that carries it to the Host), the cold phase reopens the same tasks-index through a
// fresh controller runtime with no agent service for that workspace (closed workspace, no live host).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  V4_WIRE_PROTOCOL_VERSION,
  type SessionsIndexTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type { IZCodeTaskService } from "#src/session/zcodeTaskService.js";
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import { createWindowHostControllerRuntime } from "#src/window-controller/windowHostControllerService.js";

const WORKSPACE = "/work/demo-worktree";
const WORKTREE = {
  path: `${WORKSPACE}/.worktrees/zcode-brave-otter`,
  branchName: "zcode/brave-otter",
};
const TASK_ID = "wt-task-1";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-worktree-fact-"));
  setDataBaseDir(tempDir);
  repo = new TaskIndexRepo();
});

afterEach(async () => {
  repo.close();
  setDataBaseDir(null);
  if (process.platform === "win32") {
    // Windows needs to wait for SQLite to release the file handle, avoiding EPERM during temp dir cleanup.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  rmSync(tempDir, { recursive: true, force: true });
});

// The controller runtime reads sources through these four task-service methods; back them with the
// real tasks-index sqlite so the cold phase exercises the actual rowToMeta/meta_json read path.
function makeTaskService(target: TaskIndexRepo): IZCodeTaskService {
  return {
    listTasks: (params: { workspacePath: string; workspaceIdentity?: string }) =>
      target.listTaskMetas({ ...params, archived: false }),
    listPinnedTasks: (params: { workspacePath: string; workspaceIdentity?: string }) =>
      target.listTaskMetas({ ...params, pinned: true, archived: false }),
    listArchivedTasks: (params: { workspacePath: string; workspaceIdentity?: string }) =>
      target.listTaskMetas({ ...params, archived: true }),
    listTaskList: (params: Parameters<TaskIndexRepo["queryTaskList"]>[0]) =>
      target.queryTaskList(params),
  } as unknown as IZCodeTaskService;
}

// Live agent service: the CLI's sessions-index snapshot frame is the only channel that carries the
// execution-worktree fact to the Host. The frame is staged before the subscribe ACK resolves and
// replayed synchronously after it, mirroring the real initial-snapshot delivery.
function makeLiveAgentService(): IZCodeAgentService {
  const frames = new Emitter<SessionsIndexTopicWireCandidate>();
  const topic = `sessions-index/${WORKSPACE}`;
  const subscriptionId = "sessions-sub-1";
  const agentService = {
    onDynamicSessionsIndexFrame: () => frames.event,
    onAgentRuntimeRestarted: () => ({ dispose: () => {} }),
    subscribeSessionsIndexV4: async () => {
      frames.fire({
        wireVersion: V4_WIRE_PROTOCOL_VERSION,
        kind: "complete",
        deliveryKind: "initial",
        logicalFrameId: "initial-1",
        logicalFrameOrdinal: 1,
        topic,
        subscriptionId,
        frame: {
          topic,
          subscriptionId,
          fromSeq: 0,
          toSeq: 1,
          sentAt: 1,
          payload: {
            kind: "snapshot",
            snapshot: {
              protocolVersion: 1,
              workspaceId: WORKSPACE,
              logEpoch: "sessions-epoch-1",
              sessions: [
                {
                  sessionId: TASK_ID,
                  workspaceId: WORKSPACE,
                  title: "Worktree feature",
                  titleSource: "default",
                  phase: "completedSuccess",
                  sessionEnded: true,
                  hasBackgroundWork: false,
                  executionWorktree: WORKTREE,
                  lastActivityAt: 30,
                  createdAt: 10,
                },
              ],
            },
          },
        },
      });
      return { ack: { subscriptionId, mode: "snapshot" as const, logEpoch: "sessions-epoch-1" } };
    },
    resyncSessionsIndexV4: async () => undefined,
    unsubscribeSessionsIndexV4: async () => undefined,
  };
  return agentService as unknown as IZCodeAgentService;
}

describe("task index executionWorktree fact across restart (BUG-GWT-010)", () => {
  it("BUG-GWT-010: cold listTaskList after a restart keeps the worktree session fact", async () => {
    // Phase 1 - the worktree session exists while its workspace host runs: the row is persisted the
    // way today's desktop write path persists it (no worktree fact: the session state snapshot and
    // buildMetaFromSnapshot carry none), and the live sessions-index overlay supplies the fact.
    await repo.syncTaskMeta({
      meta: {
        taskId: TASK_ID,
        traceId: `trace-${TASK_ID}`,
        title: "Worktree feature",
        workspacePath: WORKSPACE,
        createdAt: 10,
        updatedAt: 20,
        mode: "default",
        provider: "glm",
        status: "completed",
      } satisfies ZCodeTaskMeta,
    });

    const liveRuntime = createWindowHostControllerRuntime({
      createId: () => "live-id",
      resolveSource: (scope) => ({
        scope: { kind: "local" as const, ...scope },
        taskService: makeTaskService(repo),
        agentService: makeLiveAgentService(),
        sourceAvailability: "online" as const,
      }),
    });

    const live = await liveRuntime.service.listTaskList({
      kind: "active",
      workspaceScopes: [{ workspacePath: WORKSPACE }],
      sortBy: "updated",
    });
    liveRuntime.dispose();

    // Sanity: while the host is live the fact reaches the list (this part is green today).
    expect(live.items).toHaveLength(1);
    expect(live.items[0]!.executionWorktree).toEqual(WORKTREE);

    // Phase 2 - app restart: the workspace stays closed, so no agent service / live overlay exists
    // for it; the list must be served from the persisted tasks-index alone.
    repo.close();
    repo = new TaskIndexRepo();
    const coldRuntime = createWindowHostControllerRuntime({
      createId: () => "cold-id",
      resolveSource: (scope) => ({
        scope: { kind: "local" as const, ...scope },
        taskService: makeTaskService(repo),
        sourceAvailability: "online" as const,
      }),
    });

    const cold = await coldRuntime.service.listTaskList({
      kind: "active",
      workspaceScopes: [{ workspacePath: WORKSPACE }],
      sortBy: "updated",
    });
    coldRuntime.dispose();

    expect(cold.items).toHaveLength(1);
    expect(cold.items[0]!.taskId).toBe(TASK_ID);
    // BUG-GWT-010: the persisted fact must survive the restart; today the cold read returns none and
    // the sidebar marker / Sessions Environment classification silently degrade to "Local".
    expect(cold.items[0]!.executionWorktree).toEqual(WORKTREE);
  });
});
