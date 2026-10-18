// session/treeCounts and session/eraseTree handlers (specs/session-deletion-cascade.md §4-§6):
// running guard, resident-runtime close ordering, and exact-name directory removal.
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionId, SessionStorePort } from "@zcode/contracts";

const closeSessionMock = vi.hoisted(() => vi.fn(async () => ({ closed: true })));
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

  it("closes idle resident runtimes before deleting, then removes only exact-name directories", async () => {
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
    const { context, store } = createContext({
      treeIds: ["sess_a"],
      sessions: { sess_a: liveRecord(false) },
      storageRoot: root,
      store: {
        deleteSessionTree: vi.fn(async () => {
          order.push("delete");
          return { erasedIds: ["sess_a" as SessionId] };
        }),
      },
    });

    await expect(eraseSessionTrees(context, { sessionIds: ["sess_a"] })).resolves.toEqual({
      erasedSessionIds: ["sess_a"],
      blockedRunningSessionIds: [],
      fileFailureCount: 0,
    });
    expect(order).toEqual(["close", "delete"]);
    expect(store!.deleteSessionTree).toHaveBeenCalledWith({ rootIds: ["sess_a"] });
    for (const directory of ["artifacts", "image-cache", "pdf-cache", "video-cache", "sessions"]) {
      expect((await readdir(join(root, "cli", directory))).sort()).toEqual(["sess_a-sibling", "sess_keep"]);
    }
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
    expect(result.erasedSessionIds).toEqual(["../keep", ".."]);
    expect(result.fileFailureCount).toBe(2);
    expect(await readdir(join(root, "cli"))).toEqual(expect.arrayContaining(["artifacts", "keep"]));
  });

  it("reports directories as not removed when the storage root is unknown", async () => {
    const { context } = createContext({ treeIds: ["sess_a"] });
    const result = await eraseSessionTrees(context, { sessionIds: ["sess_a"] });
    expect(result).toMatchObject({ erasedSessionIds: ["sess_a"], fileFailureCount: 1 });
  });
});
