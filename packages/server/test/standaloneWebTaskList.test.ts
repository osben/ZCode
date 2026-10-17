import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { Emitter } from "@zcode/rpc";
import { connectViaWebSocket } from "@zcode/client";
import {
  ServiceCollection,
  IZCodeTaskService,
  IZCodeAgentService,
  IWindowControllerService,
  readTrustedZCodeAgentV4Connection,
  type ZCodeTaskListQuery,
} from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { SessionsIndexTopicWireCandidate } from "@zcode/shared/zcode-protocol-v4";
import { createHttpServer } from "../src/http.js";

const scope = { workspacePath: "/fixture/web", workspaceIdentity: "web-fixture" };
const row = (taskId: string, createdAt: number): ZCodeTaskMeta => ({
  ...scope,
  taskId,
  traceId: taskId,
  title: taskId,
  mode: "default",
  createdAt,
  updatedAt: taskId === "older" ? 20 : createdAt,
});
const query = (kind: ZCodeTaskListQuery["kind"]): ZCodeTaskListQuery => ({
  kind,
  workspaceScopes: [scope],
  sortBy: "created",
});

function fixture() {
  const events = new Emitter<import("@zcode/shared").ZCodeWorkspaceEvent>();
  const frames = new Emitter<SessionsIndexTopicWireCandidate>();
  const lifecycle = new Emitter<any>();
  let serial = 0;
  const routes = new Map<string, string>();
  const publishActivity = (phase: "running" | "completedSuccess") => {
    for (const subscriptionId of routes.values()) {
      frames.fire({
        wireVersion: 3,
        kind: "complete",
        deliveryKind: "online",
        logicalFrameId: `${subscriptionId}-update`,
        logicalFrameOrdinal: 2,
        topic: "sessions-index/web-fixture",
        subscriptionId,
        frame: {
          topic: "sessions-index/web-fixture",
          subscriptionId,
          fromSeq: 1,
          toSeq: 2,
          sentAt: 2,
          payload: {
            kind: "snapshot",
            snapshot: {
              protocolVersion: 1,
              workspaceId: "web-fixture",
              logEpoch: subscriptionId,
              sessions: [
                {
                  sessionId: "running",
                  workspaceId: "web-fixture",
                  title: "running",
                  phase,
                  sessionEnded: phase !== "running",
                  hasBackgroundWork: false,
                  createdAt: 3,
                  lastActivityAt: 10,
                },
              ],
            },
          },
        },
      });
    }
  };
  const taskService = {
    listTasks: vi.fn(async () => [row("older", 1), row("running", 3)]),
    listPinnedTasks: vi.fn(async () => [row("pinned", 2)]),
    listArchivedTasks: vi.fn(async () => [row("archived", 4)]),
    listTaskList: vi.fn(async () => ({
      items: [{ ...row("older", 1), searchSnippets: ["matching body content"] }],
      total: 1,
      hasMore: false,
    })),
    onDynamicWorkspaceEvent: vi.fn(() => events.event),
  } as unknown as IZCodeTaskService;
  const agentService = {
    onDynamicSessionsIndexFrame: vi.fn(() => frames.event),
    onAgentRuntimeRestarted: new Emitter<any>().event,
    onAgentRuntimeLifecycle: lifecycle.event,
    subscribeSessionsIndexV4: vi.fn(async (params) => {
      const subscriptionId = `sessions-${++serial}`;
      const connectionId =
        readTrustedZCodeAgentV4Connection(params)?.connectionId ?? "raw-controller";
      routes.set(
        `${params.workspaceIdentity ?? params.workspacePath}:${connectionId}`,
        subscriptionId,
      );
      frames.fire({
        wireVersion: 3,
        kind: "complete",
        deliveryKind: "initial",
        logicalFrameId: subscriptionId,
        logicalFrameOrdinal: 1,
        topic: "sessions-index/web-fixture",
        subscriptionId,
        frame: {
          topic: "sessions-index/web-fixture",
          subscriptionId,
          fromSeq: 0,
          toSeq: 1,
          sentAt: 1,
          payload: {
            kind: "snapshot",
            snapshot: {
              protocolVersion: 1,
              workspaceId: "web-fixture",
              logEpoch: subscriptionId,
              sessions: [
                {
                  sessionId: "running",
                  workspaceId: "web-fixture",
                  title: "running",
                  phase: "running",
                  sessionEnded: false,
                  hasBackgroundWork: false,
                  createdAt: 3,
                  lastActivityAt: 10,
                },
              ],
            },
          },
        },
      });
      return { ack: { subscriptionId, mode: "snapshot", logEpoch: subscriptionId } };
    }),
    unsubscribeSessionsIndexV4: vi.fn(async ({ subscriptionId }) => {
      for (const [key, id] of routes) if (id === subscriptionId) routes.delete(key);
    }),
    setConnectionFlowStateV4: vi.fn(async () => {}),
    resyncSessionsIndexV4: vi.fn(),
  } as unknown as IZCodeAgentService;
  return { taskService, agentService, lifecycle, events, routes, publishActivity };
}

describe("standalone Web /ws task lists", () => {
  const sockets: WebSocket[] = [];
  const servers: ReturnType<typeof createHttpServer>[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  async function connect(data = fixture()) {
    const services = new ServiceCollection()
      .register(IZCodeTaskService, data.taskService)
      .register(IZCodeAgentService, data.agentService);
    const server = createHttpServer(services, 0);
    servers.push(server);
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    const client = await connectViaWebSocket(url, {
      onOpenSocket: (socket) => sockets.push(socket),
    });
    return { ...data, client, url };
  }

  it("exposes existing regular, pinned, archived tasks and preserves sorting/pagination", async () => {
    const { client } = await connect();
    expect(await client.zcodeTaskService.listTasks(scope)).toHaveLength(2);
    const controller = client.windowControllerService!;
    const result = await Promise.race([
      controller.listTaskList({ ...query("timeline"), limit: 1 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("standalone Controller channel did not reply")), 2000),
      ),
    ]);
    expect(result.items.map((item) => item.taskId)).toEqual(["running"]);
    expect(result).toMatchObject({ total: 2, hasMore: true });
    expect(
      (await controller.listTaskList(query("pinned"))).items.map((item) => item.taskId),
    ).toEqual(["pinned"]);
    expect(
      (await controller.listTaskList(query("archived"))).items.map((item) => item.taskId),
    ).toEqual(["archived"]);
    expect(
      (await controller.listTaskList(query("timeline"))).items.map((item) => item.taskId),
    ).toEqual(["running", "older"]);
    expect(
      (await controller.listTaskList({ ...query("timeline"), sortBy: "updated" })).items.map(
        (item) => item.taskId,
      ),
    ).toEqual(["older", "running"]);
  });

  it("isolates equal workspace paths by identity over the RPC boundary", async () => {
    const data = fixture();
    vi.mocked(data.taskService.listTasks).mockImplementation(async (params) => [
      {
        ...row("identity-row", 1),
        workspaceIdentity: params.workspaceIdentity,
        title: params.workspaceIdentity ?? "local",
      },
    ]);
    const { client } = await connect(data);
    const result = await client.windowControllerService!.listTaskList({
      ...query("timeline"),
      workspaceScopes: [scope, { ...scope, workspaceIdentity: "another-identity" }],
    });
    expect(result.items.map((item) => item.title).sort()).toEqual([
      "another-identity",
      "web-fixture",
    ]);
    expect(result.total).toBe(2);
  });

  it("retains a Controller explicitly supplied by the server owner", async () => {
    const supplied = {
      listTaskList: vi.fn(async () => ({ items: [], total: 42, hasMore: false })),
    };
    const server = createHttpServer(
      new ServiceCollection()
        .register(IZCodeTaskService, fixture().taskService)
        .register(IWindowControllerService, supplied as unknown as IWindowControllerService),
      0,
    );
    servers.push(server);
    const client = await connectViaWebSocket(
      `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`,
      {
        onOpenSocket: (socket) => sockets.push(socket),
      },
    );
    expect((await client.windowControllerService!.listTaskList(query("timeline"))).total).toBe(42);
    expect(supplied.listTaskList).toHaveBeenCalledOnce();
  });

  it("forwards full-text search and workspace identity and retains snippets", async () => {
    const { client, taskService } = await connect();
    const result = await client.windowControllerService!.listTaskList({
      ...query("timeline"),
      search: "body",
    });
    expect(taskService.listTaskList).toHaveBeenCalledWith({
      ...query("timeline"),
      search: "body",
      limit: undefined,
    });
    expect(result.items[0]).toMatchObject({
      taskId: "older",
      workspaceIdentity: "web-fixture",
      searchSnippets: ["matching body content"],
    });
  });

  it("joins existing running activity and removes it when runtime becomes unavailable", async () => {
    const { client, agentService, lifecycle } = await connect();
    const controller = client.windowControllerService!;
    expect((await controller.listTaskList(query("timeline"))).items[0]).toMatchObject({
      taskId: "running",
      liveStatus: "running",
      activity: { phase: "running" },
    });
    expect(agentService.subscribeSessionsIndexV4).toHaveBeenCalledWith(
      expect.objectContaining({ ...scope, runtimePolicy: "existing-only" }),
    );
    lifecycle.fire({
      ...scope,
      workspaceKey: "web-fixture",
      state: "unavailable",
      runtimeIdentity: { workspaceKey: "web-fixture", generation: 1 },
    });
    const result = await controller.listTaskList(query("timeline"));
    expect(result.items.find((item) => item.taskId === "running")?.liveStatus).toBe("idle");
  });

  it("releases only the closed connection's passive sessions observer", async () => {
    const { client, url, agentService, routes, publishActivity } = await connect();
    const second = await connectViaWebSocket(url, {
      onOpenSocket: (socket) => sockets.push(socket),
    });
    await client.windowControllerService!.listTaskList(query("timeline"));
    await second.windowControllerService!.listTaskList(query("timeline"));
    expect(agentService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
    const connectionIds = vi
      .mocked(agentService.subscribeSessionsIndexV4)
      .mock.calls.map(([params]) => readTrustedZCodeAgentV4Connection(params)?.connectionId);
    expect(connectionIds.every(Boolean)).toBe(true);
    expect(new Set(connectionIds).size).toBe(2);
    sockets[0]!.close();
    await vi.waitFor(() =>
      expect(agentService.unsubscribeSessionsIndexV4).toHaveBeenCalledTimes(1),
    );
    expect((await second.windowControllerService!.listTaskList(query("pinned"))).total).toBe(1);
    expect(agentService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
    expect(routes.size).toBe(1);
    publishActivity("completedSuccess");
    await vi.waitFor(async () => {
      const result = await second.windowControllerService!.listTaskList(query("timeline"));
      expect(result.items.find((item) => item.taskId === "running")?.liveStatus).toBe("completed");
    });
  });

  it("rejects a cold task-index failure and recovers on retry", async () => {
    const data = fixture();
    vi.mocked(data.taskService.listPinnedTasks).mockRejectedValueOnce(
      new Error("index unavailable"),
    );
    const { client } = await connect(data);
    await expect(client.windowControllerService!.listTaskList(query("timeline"))).rejects.toThrow(
      "index unavailable",
    );
    expect((await client.windowControllerService!.listTaskList(query("timeline"))).total).toBe(2);
  });

  it("returns persisted rows while sessions subscription is still pending", async () => {
    const data = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(data.agentService.subscribeSessionsIndexV4).mockImplementation(async () => {
      await pending;
      return { ack: { subscriptionId: "late-sub", mode: "snapshot", logEpoch: "late-epoch" } };
    });
    const { client } = await connect(data);
    const listing = client.windowControllerService!.listTaskList(query("timeline"));
    try {
      await vi.waitFor(() => expect(data.taskService.listTasks).toHaveBeenCalledOnce());
      expect((await listing).total).toBe(2);
    } finally {
      release();
      await listing;
    }
  });

  it("does not resurrect source observers after close with a queued workspace event", async () => {
    const data = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(data.taskService.listTasks).mockImplementation(async () => {
      await pending;
      return [row("older", 1)];
    });
    const { client } = await connect(data);
    client.windowControllerService!.listTaskList(query("timeline")).catch(() => undefined);
    await vi.waitFor(() => expect(data.taskService.listTasks).toHaveBeenCalledOnce());
    data.events.fire({
      type: "workspace_task_list_changed",
      workspacePath: scope.workspacePath,
    } as never);
    sockets[0]!.close();
    await vi.waitFor(() =>
      expect(data.agentService.unsubscribeSessionsIndexV4).toHaveBeenCalledOnce(),
    );
    release();
    // The socket is already closed, so the transport drops the server's rejection and the
    // client-side call stays pending forever; yield one event-loop turn instead so the
    // released read and the queued event callback both finish before asserting.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(data.taskService.onDynamicWorkspaceEvent).toHaveBeenCalledOnce();
    expect(data.agentService.subscribeSessionsIndexV4).toHaveBeenCalledOnce();
    expect(data.taskService.listTasks).toHaveBeenCalledOnce();
  });

  it("rejects oversized and cumulative scope admission before source IO", async () => {
    const { client, taskService } = await connect();
    const scopes = Array.from({ length: 65 }, (_, index) => ({
      workspacePath: scope.workspacePath,
      workspaceIdentity: `scope-${index}`,
    }));
    await expect(
      client.windowControllerService!.listTaskList({
        ...query("timeline"),
        workspaceScopes: scopes,
      }),
    ).rejects.toThrow("source limit");
    expect(taskService.listTasks).not.toHaveBeenCalled();
    expect(taskService.onDynamicWorkspaceEvent).not.toHaveBeenCalled();
    await client.windowControllerService!.listTaskList({
      ...query("timeline"),
      workspaceScopes: scopes.slice(0, 64),
    });
    expect(taskService.listTasks).toHaveBeenCalledTimes(64);
    await expect(
      client.windowControllerService!.listTaskList({
        ...query("timeline"),
        workspaceScopes: scopes.slice(64),
      }),
    ).rejects.toThrow("source limit");
    expect(taskService.listTasks).toHaveBeenCalledTimes(64);
  });

  it("limits source reads to four even across concurrent list requests", async () => {
    const data = fixture();
    const releases: Array<() => void> = [];
    vi.mocked(data.taskService.listTasks).mockImplementation(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return [];
    });
    const { client } = await connect(data);
    const scopes = Array.from({ length: 8 }, (_, index) => ({
      ...scope,
      workspaceIdentity: `scope-${index}`,
    }));
    const listings = [0, 4].map((offset) =>
      client.windowControllerService!.listTaskList({
        ...query("timeline"),
        workspaceScopes: scopes.slice(offset, offset + 4),
      }),
    );
    try {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThanOrEqual(4));
      expect(releases).toHaveLength(4);
      releases.slice().forEach((release) => release());
      await vi.waitFor(() => expect(releases).toHaveLength(8));
    } finally {
      releases.forEach((release) => release());
      await Promise.all(listings);
    }
  });
});
