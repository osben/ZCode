import { randomUUID } from "node:crypto";
import {
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  zcodeProviderRuntimeHeadersResponseSchema,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeAppOptions } from "../app/types.js";
import {
  ProtocolRequestError,
  protocolTraceFromTraceContext,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

// The UI SDK timeout does not start when there is no responder; the port's total deadline covers both queueing and credential resolution.
const PROVIDER_RUNTIME_HEADERS_TIMEOUT_MS = 180_000;
const CLIENT_REQUEST_TIMEOUT_CODE = -32022;

export function createProviderRuntimeHeadersPort(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
): NonNullable<ZCodeAppOptions["providerRuntimeHeadersPort"]> {
  return {
    shouldRefreshBeforeModelRequest() {
      // Whether an Account request requires authentication is determined by the bound Model; do not
      // restrict all accounts to the old Start ID. Regular API requests do not use this port;
      // Team/Individual continue to use the request-level authentication contract.
      return true;
    },
    async refreshBeforeModelRequest(input) {
      const requestId = `${input.sessionId}:provider-runtime-headers:${randomUUID()}`;
      let result;
      try {
        result = await context.requestClient(
          zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders,
          {
            // Concurrent requests in the same millisecond cannot share a correlation key, or pending
            // responses may overwrite or be used for the wrong request.
            requestId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            workspace,
            modelSelection: { providerId: input.providerId, modelId: input.modelId },
            providerId: input.providerId,
            ...(input.accountAccess ? { accountAccess: input.accountAccess } : {}),
            reason: input.reason,
          },
          zcodeProviderRuntimeHeadersResponseSchema,
          {
            signal: input.abortSignal,
            trace: protocolTraceFromTraceContext(input.traceContext),
            timeoutMs: PROVIDER_RUNTIME_HEADERS_TIMEOUT_MS,
          },
        );
      } catch (error) {
        // requestClient abort only clears the CLI wait; the Host would otherwise keep the credential
        // resolution queue occupied until timeout. Send cancellation only for this port and do not
        // change the lifecycle of other reverse RPCs.
        const timedOut =
          error instanceof ProtocolRequestError && error.code === CLIENT_REQUEST_TIMEOUT_CODE;
        // Both the total deadline and explicit stop must release the Host; otherwise the CLI has
        // failed while the old request continues to occupy the queue.
        if (input.abortSignal?.aborted || timedOut) {
          context.notify({
            method: zcodeProtocolNotifications.providerRuntimeHeadersCancelled,
            trace: protocolTraceFromTraceContext(input.traceContext),
            params: { workspace, sessionId: input.sessionId, requestId },
          });
        }
        if (timedOut) {
          const timeoutError = new ProtocolRequestError(
            CLIENT_REQUEST_TIMEOUT_CODE,
            "Provider runtime headers request timed out. Please send your message again.",
            error.data,
          );
          timeoutError.cause = error;
          throw timeoutError;
        }
        throw error;
      }
      if (!result.headersApplied) {
        // Runtime header refresh can fail because configuration could not be read or credentials are
        // missing. Do not rewrite both as one failure message; it would hide the cause and mislead retry policy.
        throw new ProtocolRequestError(
          -32031,
          result.errorMessage ??
            "Provider runtime headers were not applied before model request attempt.",
          {
            providerId: input.providerId,
            reason: input.reason,
            workspaceKey: workspace.workspaceKey,
          },
        );
      }
      // zcode-plan account credentials are runtime configuration refreshed for each request, while
      // the provider registry revision is workspace-wide. A concurrent later refresh advances the
      // global revision, so a revision mismatch cannot be used to infer that this request's headers
      // were not applied.
      return result;
    },
  };
}
