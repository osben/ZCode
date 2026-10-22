// Sidebar incognito marker durability (specs/incognito-session.md "Sidebar marker durability"). The marker used to
// come only from the live sessions-index overlay, so a client without an observer (dev web) and every cold
// start lost it. These tests cover: the persisted marker surviving a cold start, convergence from the live
// overlay, the runtime snapshot sync not erasing it, and the repo never clearing it.
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
import type { DatabaseSync } from "node:sqlite";
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
const TASK_ID = "incognito-task-1";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-incognito-"));
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
    persistIncognitoMarkers: (params: Parameters<TaskIndexRepo["persistIncognitoMarkers"]>[0]) =>
      target.persistIncognitoMarkers(params),
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
                  title: "Incognito feature",
                  titleSource: "default",
                  phase: "completedSuccess",
                  sessionEnded: true,
                  hasBackgroundWork: false,
                  incognito: true,
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

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 100 && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  return value;
}

describe("sidebar incognito marker durability (specs/incognito-session.md)", () => {
  it("cold listTaskList after a restart keeps the incognito marker learned from the live overlay", async () => {
    await repo.syncTaskMeta({
      meta: {
        taskId: TASK_ID,
        traceId: `trace-${TASK_ID}`,
        title: "Incognito feature",
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
    expect(live.items[0]!.incognito).toBe(true);

    // Convergence is fire-and-forget after the overlay publish; wait until meta_json carries the marker.
    const persisted = await waitFor(
      () => repo.listTaskMetas({ workspacePath: WORKSPACE, archived: false }),
      (tasks) => tasks[0]?.incognito === true,
    );
    expect(persisted[0]!.incognito).toBe(true);

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
    expect(cold.items[0]!.incognito).toBe(true);
  });

  it("a runtime snapshot sync without the marker never erases a stored incognito marker", async () => {
    const base = {
      taskId: TASK_ID,
      traceId: `trace-${TASK_ID}`,
      title: "Incognito feature",
      workspacePath: WORKSPACE,
      createdAt: 10,
      updatedAt: 20,
      mode: "default",
      provider: "glm",
      status: "completed",
    } satisfies ZCodeTaskMeta;
    await repo.syncTaskMeta({ meta: base });
    expect(
      await repo.persistIncognitoMarkers({ workspacePath: WORKSPACE, taskIds: [TASK_ID] }),
    ).toEqual([TASK_ID]);
    await repo.syncTaskMeta({ meta: { ...base, updatedAt: 30 } });
    const [after] = await repo.listTaskMetas({ workspacePath: WORKSPACE, archived: false });
    expect(after!.incognito).toBe(true);
  });

  it("incognito convergence never clears a stored marker and ignores absent rows", async () => {
    await repo.syncTaskMeta({
      meta: {
        taskId: TASK_ID,
        traceId: `trace-${TASK_ID}`,
        title: "Plain",
        workspacePath: WORKSPACE,
        createdAt: 10,
        updatedAt: 20,
        mode: "default",
        provider: "glm",
        status: "completed",
      } satisfies ZCodeTaskMeta,
    });
    // Absent row: not confirmed, no throw.
    expect(
      await repo.persistIncognitoMarkers({ workspacePath: WORKSPACE, taskIds: ["missing-task"] }),
    ).toEqual([]);
    const [plain] = await repo.listTaskMetas({ workspacePath: WORKSPACE, archived: false });
    expect(plain!.incognito).toBeUndefined();
  });

  it("acknowledges pinned and archived rows, which the list read excludes", async () => {
    const base = {
      taskId: TASK_ID,
      traceId: `trace-${TASK_ID}`,
      title: "Archived incognito",
      workspacePath: WORKSPACE,
      createdAt: 10,
      updatedAt: 20,
      mode: "default",
      provider: "glm",
      status: "completed",
    } satisfies ZCodeTaskMeta;
    await repo.syncTaskMeta({ meta: base });
    // updatedAt 20 is long past the cutoff; the row is completed and unread-free, so it archives.
    await repo.archiveStaleTasks({ workspacePath: WORKSPACE, olderThanDays: 1 });
    expect(
      await repo.persistIncognitoMarkers({ workspacePath: WORKSPACE, taskIds: [TASK_ID] }),
    ).toEqual([TASK_ID]);
    const [archived] = await repo.listTaskMetas({ workspacePath: WORKSPACE, archived: true });
    expect(archived!.incognito).toBe(true);
  });
});

// A sessions-index stream that stays open after the snapshot, so a test can publish a later frame the way a
// CLI event does. The snapshot is staged before the subscribe ACK, as in makeLiveAgentService.
function makeStreamingAgentService(): {
  agentService: IZCodeAgentService;
  publishDelta: (lastActivityAt: number) => void;
} {
  const frames = new Emitter<SessionsIndexTopicWireCandidate>();
  const topic = `sessions-index/${WORKSPACE}`;
  const subscriptionId = "sessions-sub-stream";
  const summary = (lastActivityAt: number) => ({
    sessionId: TASK_ID,
    workspaceId: WORKSPACE,
    title: "Incognito feature",
    titleSource: "default" as const,
    phase: "completedSuccess" as const,
    sessionEnded: true,
    hasBackgroundWork: false,
    incognito: true,
    lastActivityAt,
    createdAt: 10,
  });
  const wire = (
    deliveryKind: "initial" | "online",
    fromSeq: number,
    toSeq: number,
    payload: Record<string, unknown>,
  ): SessionsIndexTopicWireCandidate =>
    ({
      wireVersion: V4_WIRE_PROTOCOL_VERSION,
      kind: "complete",
      deliveryKind,
      logicalFrameId: `${deliveryKind}-${toSeq}`,
      logicalFrameOrdinal: toSeq,
      topic,
      subscriptionId,
      frame: { topic, subscriptionId, fromSeq, toSeq, sentAt: toSeq, payload },
    }) as unknown as SessionsIndexTopicWireCandidate;
  const agentService = {
    onDynamicSessionsIndexFrame: () => frames.event,
    onAgentRuntimeRestarted: () => ({ dispose: () => {} }),
    subscribeSessionsIndexV4: async () => {
      frames.fire(
        wire("initial", 0, 1, {
          kind: "snapshot",
          snapshot: {
            protocolVersion: 1,
            workspaceId: WORKSPACE,
            logEpoch: "sessions-epoch-stream",
            sessions: [summary(20)],
          },
        }),
      );
      return {
        ack: { subscriptionId, mode: "snapshot" as const, logEpoch: "sessions-epoch-stream" },
      };
    },
    resyncSessionsIndexV4: async () => undefined,
    unsubscribeSessionsIndexV4: async () => undefined,
  };
  return {
    agentService: agentService as unknown as IZCodeAgentService,
    publishDelta: (lastActivityAt) =>
      frames.fire(
        wire("online", 1, 2, {
          kind: "deltas",
          deltas: [{ op: "session.upserted", session: summary(lastActivityAt) }],
        }),
      ),
  };
}

describe("reservation placeholder and incognito convergence (specs/incognito-session.md, Sidebar marker durability)", () => {
  it("never writes the marker into a reservation placeholder, and the admitted row gets it on the next publish", async () => {
    // Same row prepareSessionCreation leaves before the CLI admits the prepared session:
    // created_at 0, no CLI facts, meta_json '{}' (RESERVATION_PLACEHOLDER_SQL).
    const projects = await repo.getProjectRepository();
    projects.reserveCreatedTask({
      task: { workspacePath: WORKSPACE, taskId: TASK_ID },
      projectId: null,
    });
    const database = (repo as unknown as { getDatabase(): DatabaseSync }).getDatabase();
    const readMetaJson = () =>
      (
        database.prepare("SELECT meta_json FROM tasks WHERE task_id = ?").get(TASK_ID) as
          | { meta_json: string }
          | undefined
      )?.meta_json;

    // One task-service instance, as in production: the convergence ack is bound to it.
    const taskService = makeTaskService(repo);
    const stream = makeStreamingAgentService();
    const runtime = createWindowHostControllerRuntime({
      createId: () => "placeholder-live-id",
      resolveSource: (scope) => ({
        scope: { kind: "local" as const, ...scope },
        taskService,
        agentService: stream.agentService,
        sourceAvailability: "online" as const,
      }),
    });
    await runtime.service.listTaskList({
      kind: "active",
      workspaceScopes: [{ workspacePath: WORKSPACE }],
      sortBy: "updated",
    });
    // Convergence runs fire-and-forget after the overlay publish; give it a few turns to settle.
    for (let turn = 0; turn < 10; turn += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readMetaJson()).toBe("{}");

    // The syncer admits the prepared session with the CLI baseline meta, which carries no incognito key.
    await repo.applyCliFacts({
      meta: {
        taskId: TASK_ID,
        traceId: `trace-${TASK_ID}`,
        title: "Incognito feature",
        workspacePath: WORKSPACE,
        createdAt: 10,
        updatedAt: 20,
        mode: "default",
        provider: "glm",
      } satisfies ZCodeTaskMeta,
      titleSource: "default",
    });

    // The next sessions-index publish still reports the incognito summary and must persist the marker.
    stream.publishDelta(31);
    const [persisted] = await waitFor(
      () => repo.listTaskMetas({ workspacePath: WORKSPACE, archived: false }),
      (tasks) => tasks[0]?.incognito === true,
    );
    runtime.dispose();
    expect(persisted!.incognito).toBe(true);
  });
});
