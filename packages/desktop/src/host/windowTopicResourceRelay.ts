import { IZCodeAgentService, type IBotsService, type ServiceCollection } from "@zcode/services";
import { createTopicResourceRelayChannel } from "@zcode/services/node";
import type { WindowHostAttachmentScope, ZCodeTopicResourceRelayRequest } from "@zcode/shared";

/**
 * 反向请求必须属于发起它的物理连接，并仍绑定当前 logical session，不能只比较文件路径。
 * Two pin modes: the fork pins the connection's ServiceCollection identity (getPeerServices); the Source
 * server connection, which only exposes its accessor, pins the agent service instead (getPeerAgentService).
 */
export function createWindowTopicResourceRelay(deps: {
  getPeerServices?(): ServiceCollection | undefined;
  getPeerAgentService?(): IZCodeAgentService | undefined;
  resolveServices(scope: WindowHostAttachmentScope): ServiceCollection;
  getBots(): IBotsService | undefined;
}) {
  const resolve = (
    request: Pick<
      ZCodeTopicResourceRelayRequest,
      "remoteSessionId" | "workspaceIdentity" | "workspacePath"
    >,
  ) => {
    const scopeServices = () =>
      deps.resolveServices({
        kind: "remote",
        remoteSessionId: request.remoteSessionId,
        workspaceIdentity: request.workspaceIdentity,
        workspacePath: request.workspacePath,
      });
    const matchesPeer = deps.getPeerAgentService
      ? (() => {
          const peerAgent = deps.getPeerAgentService!();
          return (
            peerAgent !== undefined && scopeServices().getOptional(IZCodeAgentService) === peerAgent
          );
        })()
      : (() => {
          const peer = deps.getPeerServices?.();
          return peer !== undefined && scopeServices() === peer;
        })();
    if (!matchesPeer) throw new Error("Topic resource source connection mismatch");
    const bots = deps.getBots();
    if (!bots?.readTopicResource || !bots.validateTopicResource)
      throw new Error("Desktop topic resource service unavailable");
    return bots;
  };
  return createTopicResourceRelayChannel({
    reply: (request) => {
      if (!request.remoteSessionId || !request.workspaceIdentity)
        throw new Error("Remote channel reply scope missing");
      const bots = resolve({
        ...request,
        remoteSessionId: request.remoteSessionId,
        workspaceIdentity: request.workspaceIdentity,
      });
      if (!bots.replyToChannel) throw new Error("Bot channel reply unavailable");
      return bots.replyToChannel(request);
    },
    validate: (request, signal) => resolve(request).validateTopicResource!({ ...request, signal }),
    read: (request, signal) => resolve(request).readTopicResource!({ ...request, signal }),
  });
}
