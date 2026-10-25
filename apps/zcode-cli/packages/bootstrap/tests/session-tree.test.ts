// session/treeCounts and session/eraseTree handlers (specs/session-deletion-cascade.md §4-§6):
// running guard, resident-runtime close ordering, and exact-name directory removal.
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionId, SessionStorePort } from "@zcode/contracts";

const closeSessionMock = vi.hoisted(() => vi.fn(async () => ({ closed: true })));
// Lets one test make a directory removal fail; every other call is the real rm.
const rmControl = vi.hoisted(() => ({ failNext: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (rmControl.failNext) {
        rmControl.failNext = false;
        throw new Error("EBUSY");
      }
      return actual.rm(...args);
    },
  };
});
vi.mock("../src/zcode-protocol/server-operations.js", () => ({
  closeSession: closeSessionMock,
}));

import {
  countSessionTrees,
  eraseSessionTrees,
} from "../src/zcode-protocol/session-tree.js";
import {
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "../src/zcode-protocol/server-types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  closeSessionMock.mockClear();
  while (tempRoots.length > 0) {
    await rm(tempRoots.pop()!, { force: true, recursive: true });
  }
});

function liveRecord(busy: boolean) {
  return {
    activeAbortController: busy ? ({ abort: () => {} } as AbortController) : undefined,
    app: { runtime: { hasResidencyBlockingWork: () => busy } },
  };
}

function createContext(options: {
  treeIds: string[];
  sessions?: Record<string, ReturnType<typeof liveRecord>>;
  detached?: Array<{ sessionId: string; running: boolean }>;
  storageRoot?: string;
  store?: Partial<SessionStorePort> | null;
}) {
  const store =
    options.store === null
      ? undefined
      : ({
          countSessionTree: vi.fn(async () => ({
            total: options.treeIds.length,
            sideChats: 1,
            subagents: 1,
            workflowSessions: 0,
            workflowRuns: 0,
          })),
          listSessionTreeIds: vi.fn(async () => options.treeIds as SessionId[]),
          listSessionTreeIdsWithSurvivingChildren: vi.fn(async () => [] as SessionId[]),
          deleteSessionTree: vi.fn(async () => ({ erasedIds: options.treeIds as SessionId[] })),
          ...options.store,
        } as unknown as SessionStorePort);
  const context = {
    deps: { sessionStore: store, storageRoot: options.storageRoot },
    sessions: new Map(Object.entries(options.sessions ?? {})),
    v4Gateway: {
      getDetachedChildSessionFacts: () =>
        (options.detached ?? []).map((child) => ({ ...child, parentSessionId: "root" })),
    },
    logger: undefined,
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, store };
}

describe("session tree protocol handlers", () => {
  it("answers -32601 when the store has no tree support", async () => {
    const { context } = createContext({ treeIds: [], store: null });
    await expect(countSessionTrees(context, { sessionIds: ["a"] })).rejects.toMatchObject({
      code: -32601,
    });
    await expect(eraseSessionTrees(context, { sessionIds: ["a"] })).rejects.toBeInstanceOf(
      ProtocolRequestError,
    );
  });

  it("rejects params that are not a strict non-empty id list", async () => {
    const { context } = createContext({ treeIds: [] });
    await expect(countSessionTrees(context, { sessionIds: [] })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(eraseSessionTrees(context, { sessionIds: ["a"], extra: 1 })).rejects.toMatchObject(
      { code: -32602 },
    );
  });

  it("adds the live running count to the store counts", async () => {
    const { context } = createContext({
      treeIds: ["root", "busy-child", "idle-child", "detached-child"],
      sessions: { "busy-child": liveRecord(true), "idle-child": liveRecord(false) },
      detached: [{ sessionId: "detached-child", running: true }],
    });
    await expect(countSessionTrees(context, { sessionIds: ["root"] })).resolves.toMatchObject({
      total: 4,
      running: 2,
    });
  });

  it("does not erase anything while a session in the tree is running", async () => {
    const { context, store } = createContext({
      treeIds: ["root", "busy-child"],
      sessions: { "busy-child": liveRecord(true) },
    });
    await expect(eraseSessionTrees(context, { sessionIds: ["root"] })).resolves.toEqual({
      erasedSessionIds: [],
      blockedRunningSessionIds: ["busy-child"],
      fileFailureCount: 0,
      filesRetainedCount: 0,
    });
    expect(store!.deleteSessionTree).not.toHaveBeenCalled();
    expect(closeSessionMock).not.toHaveBeenCalled();
  });

  it("also blocks on a running detached subagent", async () => {
    const { context, store } = createContext({
      treeIds: ["root", "detached-child"],
      detached: [{ sessionId: "detached-child", running: true }],
    });
    const result = await eraseSessionTrees(context, { sessionIds: ["root"] });
    expect(result.blockedRunningSessionIds).toEqual(["detached-child"]);
    expect(store!.deleteSessionTree).not.toHaveBeenCalled();
  });

  it("closes idle resident runtimes, removes exact-name directories, then deletes the rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-tree-files-"));
    tempRoots.push(root);
    for (const directory of ["artifacts", "image-cache", "pdf-cache", "video-cache", "sessions"]) {
      await mkdir(join(root, "cli", directory, "sess_a"), { recursive: true });
      await writeFile(join(root, "cli", directory, "sess_a", "file.txt"), "x");
      await mkdir(join(root, "cli", directory, "sess_a-sibling"), { recursive: true });
      await mkdir(join(root, "cli", directory, "sess_keep"), { recursive: true });
    }
    const order: string[] = [];
    closeSessionMock.mockImplementation(async () => {
      order.push("close");
      return { closed: true };
    });
    let directoryGoneAtDelete = false;
    const { context, store } = createContext({
      treeIds: ["sess_a"],
      sessions: { sess_a: liveRecord(false) },
      storageRoot: root,
      store: {
        deleteSessionTree: vi.fn(async () => {
          order.push("delete");
          directoryGoneAtDelete = !(await readdir(join(root, "cli", "artifacts"))).includes("sess_a");
          return { erasedIds: ["sess_a" as SessionId] };
        }),
      },
    });

    await expect(eraseSessionTrees(context, { sessionIds: ["sess_a"] })).resolves.toEqual({
      erasedSessionIds: ["sess_a"],
      blockedRunningSessionIds: [],
      fileFailureCount: 0,
      filesRetainedCount: 0,
    });
    expect(order).toEqual(["close", "delete"]);
    // Files are removed before the rows so a failed or interrupted cleanup can be retried from the rows.
    expect(directoryGoneAtDelete).toBe(true);
    expect(store!.deleteSessionTree).toHaveBeenCalledWith({ rootIds: ["sess_a"] });
    for (const directory of ["artifacts", "image-cache", "pdf-cache", "video-cache", "sessions"]) {
      expect((await readdir(join(root, "cli", directory))).sort()).toEqual(["sess_a-sibling", "sess_keep"]);
    }
  });

  it("keeps the rows and reports a failure when a directory cannot be removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-tree-files-"));
    tempRoots.push(root);
    await mkdir(join(root, "cli", "artifacts", "sess_a"), { recursive: true });
    const { context, store } = createContext({ treeIds: ["sess_a"], storageRoot: root });
    rmControl.failNext = true;
    await expect(eraseSessionTrees(context, { sessionIds: ["sess_a"] })).resolves.toEqual({
      erasedSessionIds: [],
      blockedRunningSessionIds: [],
      fileFailureCount: 1,
      filesRetainedCount: 0,
    });
    // The rows stay, so retrying finds the same tree and finishes the cleanup.
    expect(store!.deleteSessionTree).not.toHaveBeenCalled();
    const retry = await eraseSessionTrees(context, { sessionIds: ["sess_a"] });
    expect(retry).toMatchObject({ erasedSessionIds: ["sess_a"], fileFailureCount: 0 });
    expect(await readdir(join(root, "cli", "artifacts"))).toEqual([]);
  });

  it("keeps directories that a surviving fork still references", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-tree-files-"));
    tempRoots.push(root);
    await mkdir(join(root, "cli", "artifacts", "sess_parent"), { recursive: true });
    await mkdir(join(root, "cli", "artifacts", "sess_child"), { recursive: true });
    const { context, store } = createContext({
      treeIds: ["sess_parent", "sess_child"],
      storageRoot: root,
      store: {
        listSessionTreeIdsWithSurvivingChildren: vi.fn(async () => ["sess_parent" as SessionId]),
        deleteSessionTree: vi.fn(async () => ({
          erasedIds: ["sess_parent", "sess_child"] as SessionId[],
        })),
      },
    });
    const result = await eraseSessionTrees(context, { sessionIds: ["sess_parent"] });
    expect(result).toMatchObject({
      erasedSessionIds: ["sess_parent", "sess_child"],
      fileFailureCount: 0,
      filesRetainedCount: 1,
    });
    expect(store!.deleteSessionTree).toHaveBeenCalled();
    expect(await readdir(join(root, "cli", "artifacts"))).toEqual(["sess_parent"]);
  });

  it("never builds a path from an id that is not a plain segment", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-tree-files-"));
    tempRoots.push(root);
    await mkdir(join(root, "cli", "artifacts"), { recursive: true });
    await mkdir(join(root, "cli", "keep"), { recursive: true });
    const { context } = createContext({
      treeIds: ["../keep", ".."],
      storageRoot: root,
    });
    const result = await eraseSessionTrees(context, { sessionIds: ["../keep"] });
    // Such ids cannot be located safely: their files are left alone and reported as retained.
    expect(result).toMatchObject({
      erasedSessionIds: ["../keep", ".."],
      fileFailureCount: 0,
      filesRetainedCount: 2,
    });
    expect(await readdir(join(root, "cli"))).toEqual(expect.arrayContaining(["artifacts", "keep"]));
  });

  it("erases the rows without touching the filesystem when no storage root is known", async () => {
    const { context } = createContext({ treeIds: ["sess_a"] });
    const result = await eraseSessionTrees(context, { sessionIds: ["sess_a"] });
    expect(result).toMatchObject({ erasedSessionIds: ["sess_a"], fileFailureCount: 0 });
  });
});
