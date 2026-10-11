/* Official MCP identity-header port on the Agent side.
   The Agent process is not authoritative for identity: it requests headers from the host through
   interaction/requestOfficialMcpAuthHeaders. The host resolves the current Coding Plan credential
   and returns the identity headers for this request. Credentials are not written to runtime config,
   persisted, or logged. */
import {
  zcodeOfficialMcpAuthHeadersResponseSchema,
  zcodeProtocolMethods,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { OfficialMcpAuthHeadersPort } from "@zcode/contracts";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

let requestSequence = 0;

/** The port only needs the ability to send a reverse request, not the entire server context. */
export type OfficialMcpAuthRequestContext = Pick<
  ZCodeProtocolAgentServerContext,
  "requestClient"
>;

/**
 * Build a port that retrieves identity headers through a reverse protocol request.
 *
 * `resolveContext` is lazy: the MCP connection pool is constructed before ZCodeProtocolAgentServer
 * and returns undefined until the server is ready. Treat this as unavailable (do not fall back to
 * an anonymous request).
 *
 * All failures are returned (`ok:false` plus an enumerable reason), not thrown:
 * transport exceptions are normalized to official_auth_unavailable, and the MCP adapter marks that
 * server as failed.
 *
 * Workspace purpose and known gap:
 * - The host does **not** use it to route responses. A response returns to the originating stdio
 *   connection through `client.respond(request.id, ...)`, so the connection determines routing.
 *   This field is only for request context/auditing.
 * - Still follow the repository convention `workspaceKey = workspaceIdentity?.trim() || workspacePath`,
 *   or remote workspaces with the same path but different identities cannot be distinguished in
 *   audit context.
 * - **Remaining gap**: the CLI agent process currently has no source for workspaceIdentity
 *   (`RunZCodeProtocolAgentOptions` has only cwd/env/…, with no corresponding environment variable),
 *   so this field falls back to workspacePath. This guarantees correct forwarding when an identity
 *   is available; it does not guarantee that an identity exists. If future auditing requires the
 *   actual remote identity, it must be passed to the Agent at spawn time or through the protocol,
 *   which is outside this phase.
 */
export function createOfficialMcpAuthHeadersPort(input: {
  resolveContext: () => OfficialMcpAuthRequestContext | undefined;
  resolveWorkspace: (input: {
    workspaceIdentity?: string;
    workspacePath?: string;
  }) => ZCodeWorkspaceRef | undefined;
}): OfficialMcpAuthHeadersPort {
  return {
    async resolveHeaders(request) {
      const context = input.resolveContext();
      const workspace = input.resolveWorkspace({
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
        ...(request.workspacePath ? { workspacePath: request.workspacePath } : {}),
      });
      if (!context || !workspace) {
        return { ok: false, reason: "official_auth_unavailable" };
      }
      requestSequence += 1;
      try {
        return await context.requestClient(
          zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders,
          {
            mcpKey: request.mcpKey,
            pluginId: request.pluginId,
            requestId: `official-mcp-auth:${requestSequence}`,
            targetOrigin: request.targetOrigin,
            workspace,
          },
          zcodeOfficialMcpAuthHeadersResponseSchema,
          request.signal ? { signal: request.signal } : {},
        );
      } catch {
        // Treat an unreachable host or protocol error as unavailable. Do not expose error details
        // (they may contain request context); the host has already logged a categorized message
        // without secrets.
        return { ok: false, reason: "official_auth_unavailable" };
      }
    },
  };
}
