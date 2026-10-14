import { describe, expect, it, vi } from "vitest";
import * as f from "./botsService.fixtures.js";

const actor = {
  provider: "webhook" as const,
  botId: "webhook-1",
  providerUserId: "user-1",
  chatType: "private" as const,
};

type MintWebRemoteLink = (target: {
  workspacePath: string;
  workspaceIdentity?: string;
}) => Promise<unknown>;

function createRemoteLinkService(mintWebRemoteLink: MintWebRemoteLink) {
  const repo = f.createMemoryRepo(f.baseConfig);
  const service = f.createBotsService({
    credentialService: f.createCredentialService({ "secret-1": "secret" }),
    legacyTaskService: f.createLegacyTaskService(),
    repo: repo as never,
    remoteWorkspaceService: {
      isConnected: vi.fn(async () => true),
      ensureConnected: vi.fn(async () => ({ ok: true })),
      mintWebRemoteLink,
    },
  });
  return service;
}

describe("botsService /remote link command", () => {
  it("replies with the minted web-remote link URL for the bound workspace", async () => {
    const mintWebRemoteLink = vi.fn(async () => ({
      ok: true,
      url: "https://relay.example/remote/v4?sid=web-1&hash=h&t=1",
      sessionId: "web-1",
    }));
    const service = createRemoteLinkService(mintWebRemoteLink);

    const code = await service.createBindCode({ botId: "webhook-1" });
    await service.handleInboundMessage({ botId: "webhook-1", text: `/bind ${code.code}`, actor });
    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/remote",
      actor,
    });

    expect(replies[0]?.text).toContain("https://relay.example/remote/v4?sid=web-1&hash=h&t=1");
    expect(mintWebRemoteLink).toHaveBeenCalledWith({
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "ssh://host/tmp/workspace",
    });
    service.disposeAll();
  });

  it("maps the workspace-not-open reason to a localized reply", async () => {
    const service = createRemoteLinkService(
      vi.fn(async () => ({ ok: false, reason: "workspace-not-open" })),
    );

    const code = await service.createBindCode({ botId: "webhook-1" });
    await service.handleInboundMessage({ botId: "webhook-1", text: `/bind ${code.code}`, actor });
    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/远程",
      actor,
    });

    expect(replies[0]?.text).toContain("未在桌面端打开");
    service.disposeAll();
  });

  it("reports a generic failure with the underlying error text", async () => {
    const service = createRemoteLinkService(
      vi.fn(async () => ({ ok: false, error: "relay unreachable" })),
    );

    const code = await service.createBindCode({ botId: "webhook-1" });
    await service.handleInboundMessage({ botId: "webhook-1", text: `/bind ${code.code}`, actor });
    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/remote",
      actor,
    });

    expect(replies[0]?.text).toContain("relay unreachable");
    service.disposeAll();
  });

  it("rejects the command for an unbound chat before minting", async () => {
    const mintWebRemoteLink = vi.fn(async () => ({ ok: true, url: "https://relay.example/x" }));
    const service = createRemoteLinkService(mintWebRemoteLink);

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/remote",
      actor,
    });

    // An unbound webhook chat does not even match the authorized bot, so the denial arrives
    // before any mint attempt.
    expect(replies[0]?.text).toContain("未启用");
    expect(mintWebRemoteLink).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("rejects the command when the bot policy disables remote", async () => {
    const mintWebRemoteLink = vi.fn(async () => ({ ok: true, url: "https://relay.example/x" }));
    const repo = f.createMemoryRepo({
      ...f.baseConfig,
      bots: [
        {
          ...f.baseConfig.bots[0]!,
          allowedCommands: { ...f.baseConfig.bots[0]!.allowedCommands, remote: false },
        },
      ],
    });
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
      remoteWorkspaceService: {
        isConnected: vi.fn(async () => true),
        ensureConnected: vi.fn(async () => ({ ok: true })),
        mintWebRemoteLink,
      },
    });

    const code = await service.createBindCode({ botId: "webhook-1" });
    await service.handleInboundMessage({ botId: "webhook-1", text: `/bind ${code.code}`, actor });
    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/remote",
      actor,
    });

    expect(replies[0]?.text).toContain("未启用这个命令");
    expect(mintWebRemoteLink).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("replies unavailable when the host does not support link minting", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
    });

    const code = await service.createBindCode({ botId: "webhook-1" });
    await service.handleInboundMessage({ botId: "webhook-1", text: `/bind ${code.code}`, actor });
    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/remote",
      actor,
    });

    expect(replies[0]?.text).toContain("不支持生成");
    service.disposeAll();
  });
});
