import { ChannelClient, ChannelServer, createQueuePair } from "@zcode/rpc";
import {
  DEFINITION_PREVIEW_CHANNEL,
  IQuickPromptService,
  ISettingService,
  ITerminalService,
  ServiceCollection,
  type QuickPromptSnapshot,
} from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { ServiceChannels } from "@zcode/shared";
import {
  exposeWindowHostAttachmentServices,
  resolveWindowHostServiceExposurePolicy,
} from "../src/host/windowHostAttachmentRpcPolicy.js";

describe("Window Host attachment RPC policy", () => {
  it("allows only the reviewed channel contract for mobile attachments", () => {
    const policy = resolveWindowHostServiceExposurePolicy("web-remote-replayable");

    expect(policy?.allowedChannels.has(ServiceChannels.Setting)).toBe(true);
    expect(policy?.allowedChannels.has(ServiceChannels.ZCodeTask)).toBe(true);
    expect(policy?.allowedChannels.has(ServiceChannels.Terminal)).toBe(false);
    expect(policy?.allowedChannels.has(ServiceChannels.SourceServerManagement)).toBe(false);
    expect(policy?.allowedChannels.has(ServiceChannels.ProviderProvisioningTarget)).toBe(false);
    expect(policy?.allowedChannels.has(ServiceChannels.ProviderSettings)).toBe(true);
    expect(policy?.allowedChannels.has(ServiceChannels.ModelSelection)).toBe(true);
    expect(policy?.allowedChannels.has(ServiceChannels.MediaPreview)).toBe(true);
    // 手机重建远程 Root 后会读引导记录；漏放行时调用超时，UI 回退 settings 判定而误弹引导。
    expect(policy?.allowedChannels.has(ServiceChannels.OnboardingRecord)).toBe(true);
    expect(policy?.allowedChannels.has("future-unreviewed-channel")).toBe(false);
    expect(policy?.allowedChannels.has(ServiceChannels.Project)).toBe(true);
    expect(policy?.allowedChannels.has(ServiceChannels.TaskGroups)).toBe(true);
    expect(policy?.allowedChannels.has(ServiceChannels.RemoteProjects)).toBe(true);
    expect(policy?.allowedChannels.has("repo-wiki")).toBe(false);
    // Fork channels use literal descriptors (as gen-ui does) so the upstream table stays untouched;
    // each one is reviewed and listed here explicitly.
    expect(policy?.allowedChannels.has(DEFINITION_PREVIEW_CHANNEL)).toBe(true);
    const registeredChannels = new Set<string>([
      ...Object.values(ServiceChannels),
      DEFINITION_PREVIEW_CHANNEL,
    ]);
    expect([...policy!.allowedChannels].every((channel) => registeredChannels.has(channel))).toBe(
      true,
    );
    expect(policy?.allowedChannels.has(ServiceChannels.QuickPrompts)).toBe(true);
    expect(policy?.allowedChannels.size).toBe(48);
  });

  it("keeps the complete service surface for desktop attachments", () => {
    expect(resolveWindowHostServiceExposurePolicy("desktop-continuous")).toBeUndefined();
  });

  it("rejects Terminal RPC before the mobile call reaches the registered service", async () => {
    const terminalCreate = vi.fn(async () => ({ id: "terminal-1" }));
    const services = new ServiceCollection()
      .register(ISettingService, { get: async () => ({ locale: "zh-CN" }) } as never)
      .register(ITerminalService, { create: terminalCreate } as never);
    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "host", 20);
    const client = new ChannelClient(clientProtocol);

    try {
      exposeWindowHostAttachmentServices({
        server,
        services,
        clientMode: "web-remote-replayable",
      });

      await expect(client.getChannel(ISettingService.channelName).call("get", [])).resolves.toEqual(
        {
          locale: "zh-CN",
        },
      );
      await expect(
        client
          .getChannel(ITerminalService.channelName)
          .call("create", [{ cols: 80, rows: 24, cwd: "/repo" }]),
      ).rejects.toThrow("Channel name 'terminal' timed out");
      expect(terminalCreate).not.toHaveBeenCalled();
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  it("exposes the controller's quick prompts to mobile read-only and to desktop with mutations", async () => {
    const snapshot: QuickPromptSnapshot = { project: null, globals: [], projectPrompts: [] };
    const quickPromptCreate = vi.fn(async () => {
      throw new Error("desktop create reached the service");
    });
    const quickPromptService = {
      read: vi.fn(async () => snapshot),
      readProjects: vi.fn(async () => []),
      create: quickPromptCreate,
    };
    const services = new ServiceCollection().register(
      IQuickPromptService,
      quickPromptService as never,
    );
    const runScenario = async (
      clientMode: "web-remote-replayable" | "desktop-continuous",
    ): Promise<{ read: unknown; create: unknown }> => {
      const [serverProtocol, clientProtocol] = createQueuePair();
      const server = new ChannelServer(serverProtocol, "host", 20);
      const client = new ChannelClient(clientProtocol);
      try {
        exposeWindowHostAttachmentServices({ server, services, clientMode });
        const channel = client.getChannel(IQuickPromptService.channelName);
        const read = await channel.call("read", [{ project: null }]).then(
          () => "ok",
          (error: Error) => error.message,
        );
        const create = await channel
          .call("create", [{ scope: "global", project: null, name: "x" }])
          .then(
            () => "ok",
            (error: Error) => error.message,
          );
        return { read, create };
      } finally {
        client.dispose();
        server.dispose();
      }
    };

    await expect(runScenario("web-remote-replayable")).resolves.toEqual({
      read: "ok",
      create: "quick-prompt.read-only",
    });
    expect(quickPromptCreate).not.toHaveBeenCalled();

    // Desktop keeps the full surface: the same create reaches the registered service.
    await expect(runScenario("desktop-continuous")).resolves.toEqual({
      read: "ok",
      create: "desktop create reached the service",
    });
    expect(quickPromptCreate).toHaveBeenCalledOnce();
  });

  it("keeps Terminal RPC available to desktop attachments", async () => {
    const terminalCreate = vi.fn(async () => ({ id: "terminal-1" }));
    const services = new ServiceCollection().register(ITerminalService, {
      create: terminalCreate,
    } as never);
    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "host", 20);
    const client = new ChannelClient(clientProtocol);

    try {
      exposeWindowHostAttachmentServices({
        server,
        services,
        clientMode: "desktop-continuous",
      });

      await expect(
        client
          .getChannel(ITerminalService.channelName)
          .call("create", [{ cols: 80, rows: 24, cwd: "/repo" }]),
      ).resolves.toEqual({ id: "terminal-1" });
      expect(terminalCreate).toHaveBeenCalledOnce();
    } finally {
      client.dispose();
      server.dispose();
    }
  });
});
