import type { RequestVerificationReason } from "@zcode/shared";
import { traceContextToLogContext } from "../deps.js";
import type { ModelRequestAuth } from "@zcode/contracts";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import type { Model, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

export function createRefreshRuntimeHeadersBeforeModelAttempt(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    model: Model;
    traceContext: TraceContext;
  },
):
  | ((attemptInput: {
      accountAccess?: ZCodeProviderAccountAccess;
      expectedAccountScope?: string;
      rejectedProjectTokenFingerprint?: string;
      attempt: number;
      reason?: RequestVerificationReason;
      abortSignal?: AbortSignal;
    }) => Promise<{
      headersApplied: boolean;
      requestAuth?: ModelRequestAuth;
    }>)
  | undefined {
  const runtimeHeadersPort = runtime.providerRuntimeHeadersPort;
  if (
    !runtimeHeadersPort ||
    !(
      runtimeHeadersPort.shouldRefreshBeforeModelRequest?.({
        providerId: String(input.model.providerId),
        modelId: String(input.model.modelId),
      }) ?? true
    )
  ) {
    return undefined;
  }

  return async (attemptInput) => {
    // Start Plan account credentials refresh per request. Adapter-internal retries, WebSearch/native-tool
    // requests, and separate model requests for title/compact must all refresh before each real request attempt;
    // do not reuse stale credentials from before entering the adapter.
    // Routing identity: the main runtime reports its own session; a child runtime's port is derived by the parent
    // (helpers/child-client-ports.ts), rewriting sessionId to the root session known to the client.
    const refreshResult = await runtimeHeadersPort.refreshBeforeModelRequest({
      accountAccess: attemptInput.accountAccess,
      expectedAccountScope: attemptInput.expectedAccountScope,
      rejectedProjectTokenFingerprint: attemptInput.rejectedProjectTokenFingerprint,
      abortSignal: attemptInput.abortSignal ?? input.abortSignal,
      modelId: String(input.model.modelId),
      providerId: String(input.model.providerId),
      reason: attemptInput.reason ?? "model-request",
      sessionId: runtime.sessionId,
      traceContext: input.traceContext,
      turnId: input.traceContext.turnId,
    });
    if (!refreshResult.headersApplied) {
      throw new Error("Provider runtime headers were not applied before model request attempt.");
    }
    runtime.logger?.debug("Provider runtime headers refreshed before model request attempt", {
      ...traceContextToLogContext(input.traceContext),
      attempt: attemptInput.attempt,
      event: "model.request.runtime_headers_refreshed",
      headersApplied: refreshResult.headersApplied,
      module: "core.runtime",
      providerId: String(input.model.providerId),
    });
    return refreshResult;
  };
}
