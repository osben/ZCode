import { ChannelClient, ChannelServer, Emitter, createQueuePair } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import {
  IBroadcastService,
  IQuickPromptService,
  ServiceCollection,
  type BroadcastMessage,
  type IServiceAccessor,
} from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { REMOTE_WORKSPACE_RPC_CHANNELS } from "../src/host/remoteWorkspaceRpcContract.js";
import { createServerRemoteWorkspaceServiceCollection } from "../src/host/remoteWorkspaceServiceCollection.js";
import {
  exposeWindowHostAttachmentServices,
  resolveWindowHostServiceExposurePolicy,
} from "../src/host/windowHostAttachmentRpcPolicy.js";

// Spec: specs/composer-quick-prompts.md (Mobile remote control, Storage and ownership).
// Mobile gets a read-only scope of the controller's quick prompt service; the controller broadcast
// `state:quick-prompts` is routed from the controller, never from the remote Source.

function fakeQuickPromptService() {
  return {
    read: vi.fn(async () => ({ project: null, globals: [], projectPrompts: [] })),
    readProjects: vi.fn(async () => []),
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    delete: vi.fn(async () => undefined),
    duplicate: vi.fn(async () => ({})),
    setPinned: vi.fn(async () => undefined),
    setHidden: vi.fn(async () => undefined),
    reorder: vi.fn(async () => undefined),
  };
}

function connect(
  services: ServiceCollection,
  options: Omit<Parameters<typeof exposeWindowHostAttachmentServices>[0], "server" | "services">,
) {
  const [serverProtocol, clientProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "host", 20);
  const client = new ChannelClient(clientProtocol);
  exposeWindowHostAttachmentServices({ server, services, ...options });
  const channel = client.getChannel(IQuickPromptService.channelName);
  return {
    channel,
    dispose: () => {
      client.dispose();
      server.dispose();
    },
  };
}

describe("quick prompts on window Host attachments", () => {
  it("allowlists the quick prompts channel for mobile", () => {
    expect(
      resolveWindowHostServiceExposurePolicy("web-remote-replayable")?.allowedChannels.has(
        ServiceChannels.QuickPrompts,
      ),
    ).toBe(true);
  });

  it("serves reads to mobile and rejects every mutation with the read-only code", async () => {
    const service = fakeQuickPromptService();
    const services = new ServiceCollection().register(IQuickPromptService, service as never);
    const { channel, dispose } = connect(services, { clientMode: "web-remote-replayable" });
    try {
      await expect(channel.call("read", [{ project: null }])).resolves.toEqual({
        project: null,
        globals: [],
        projectPrompts: [],
      });
      await expect(channel.call("readProjects", [])).resolves.toEqual([]);
      const mutations: Array<[string, unknown[]]> = [
        [
          "create",
          [
            {
              scope: "global",
              project: null,
              name: "x",
              body: { markdown: "", nodes: "[]" },
              pinned: true,
            },
          ],
        ],
        ["update", [{ promptId: "p" }]],
        ["delete", [{ promptId: "p" }]],
        ["duplicate", [{ promptId: "p", scope: "global", project: null }]],
        ["setPinned", [{ promptId: "p", pinned: true }]],
        ["setHidden", [{ promptId: "p", project: { hostId: "h", projectId: "j" }, hidden: true }]],
        ["reorder", [{ scope: "global", project: null, orderedIds: [] }]],
      ];
      for (const [method, args] of mutations) {
        await expect(channel.call(method, args)).rejects.toThrow("quick-prompt.read-only");
      }
      for (const method of [
        "create",
        "update",
        "delete",
        "duplicate",
        "setPinned",
        "setHidden",
        "reorder",
      ]) {
        expect(service[method as keyof typeof service]).not.toHaveBeenCalled();
      }
    } finally {
      dispose();
    }
  });

  it("applies the same read-only scope to a mobile local-scope attachment", async () => {
    const service = fakeQuickPromptService();
    const services = new ServiceCollection().register(IQuickPromptService, service as never);
    const { channel, dispose } = connect(services, {
      clientMode: "web-remote-replayable",
      attachmentScope: { kind: "local" },
    });
    try {
      await expect(channel.call("create", [{}])).rejects.toThrow("quick-prompt.read-only");
      expect(service.create).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("uses an explicit controller override for mobile reads, still read-only", async () => {
    const registered = fakeQuickPromptService();
    const controller = fakeQuickPromptService();
    controller.read.mockResolvedValue({
      project: null,
      globals: [{ promptId: "c" } as never],
      projectPrompts: [],
    });
    const services = new ServiceCollection().register(IQuickPromptService, registered as never);
    const { channel, dispose } = connect(services, {
      clientMode: "web-remote-replayable",
      overrides: new Map([[IQuickPromptService.channelName, controller]]),
    });
    try {
      await expect(channel.call("read", [{ project: null }])).resolves.toMatchObject({
        globals: [{ promptId: "c" }],
      });
      await expect(channel.call("delete", [{ promptId: "c" }])).rejects.toThrow(
        "quick-prompt.read-only",
      );
      expect(controller.delete).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("keeps the full service surface for desktop attachments", async () => {
    const service = fakeQuickPromptService();
    const services = new ServiceCollection().register(IQuickPromptService, service as never);
    const { channel, dispose } = connect(services, { clientMode: "desktop-continuous" });
    try {
      await expect(channel.call("delete", [{ promptId: "p" }])).resolves.toBeUndefined();
      expect(service.delete).toHaveBeenCalledWith({ promptId: "p" });
    } finally {
      dispose();
    }
  });
});

describe("quick prompts broadcast split on remote workspace collections", () => {
  function broadcast(events: Emitter<BroadcastMessage>) {
    return {
      send: vi.fn(async (message: BroadcastMessage) => events.fire(message)),
      onMessage: events.event,
      acquireClaim: vi.fn(async () => ({ status: "unavailable" as const })),
      commitClaim: vi.fn(async () => {}),
      releaseClaim: vi.fn(async () => {}),
      tryClaim: vi.fn(async () => false),
    };
  }

  it("registers the controller quick prompt service and routes state:quick-prompts to the controller", async () => {
    const controllerEvents = new Emitter<BroadcastMessage>();
    const sourceEvents = new Emitter<BroadcastMessage>();
    const controllerBroadcast = broadcast(controllerEvents);
    const sourceBroadcast = broadcast(sourceEvents);
    const quickPrompts = fakeQuickPromptService();
    const connectionServices = {
      ...Object.fromEntries(
        REMOTE_WORKSPACE_RPC_CHANNELS.map((channel) => [channel, { remote: channel }]),
      ),
      systemService: { info: vi.fn(async () => ({ platform: "linux", homedir: "/home/remote" })) },
      broadcastService: sourceBroadcast,
    } as unknown as IServiceAccessor;

    const services = createServerRemoteWorkspaceServiceCollection({
      clientConfigService: { getSnapshot: vi.fn(async () => ({ pluginStoreOrder: null })) },
      targetKind: "ssh",
      connectionServices,
      sourceServices: new ServiceCollection()
        .register(IQuickPromptService, quickPrompts as never)
        .register(IBroadcastService, controllerBroadcast as never),
    } as never);

    expect(services.get(IQuickPromptService)).toBe(quickPrompts);
    await services.get(IBroadcastService).send({ channel: "state:quick-prompts", payload: {} });
    expect(controllerBroadcast.send).toHaveBeenCalledWith({
      channel: "state:quick-prompts",
      payload: {},
    });
    expect(sourceBroadcast.send).not.toHaveBeenCalled();

    const listener = vi.fn();
    const subscription = services.get(IBroadcastService).onMessage(listener);
    controllerEvents.fire({ channel: "state:quick-prompts", payload: {} });
    sourceEvents.fire({ channel: "state:quick-prompts", payload: {} });
    sourceEvents.fire({ channel: "state:projects", payload: {} });
    expect(listener.mock.calls.map(([event]) => event.channel)).toEqual([
      "state:quick-prompts",
      "state:projects",
    ]);
    subscription.dispose();
    controllerEvents.dispose();
    sourceEvents.dispose();
  });
});
