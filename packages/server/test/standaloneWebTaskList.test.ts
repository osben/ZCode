import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { Emitter } from "@zcode/rpc";
import { connectViaWebSocket } from "@zcode/client";
import {
  ServiceCollection,
  IZCodeTaskService,
  IZCodeAgentService,
  IWindowControllerService,
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
    subscribeSessionsIndexV4: vi.fn(async () => {
      const subscriptionId = `sessions-${++serial}`;
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
    unsubscribeSessionsIndexV4: vi.fn(async () => {}),
    resyncSessionsIndexV4: vi.fn(),
  } as unknown as IZCodeAgentService;
  return { taskService, agentService, lifecycle, events };
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
    const { client, url, agentService } = await connect();
    const second = await connectViaWebSocket(url, {
      onOpenSocket: (socket) => sockets.push(socket),
    });
    await client.windowControllerService!.listTaskList(query("timeline"));
    await second.windowControllerService!.listTaskList(query("timeline"));
    expect(agentService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
    sockets[0]!.close();
    await vi.waitFor(() =>
      expect(agentService.unsubscribeSessionsIndexV4).toHaveBeenCalledTimes(1),
    );
    expect((await second.windowControllerService!.listTaskList(query("pinned"))).total).toBe(1);
    expect(agentService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
  });
});
