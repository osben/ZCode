import type { ModelRequestSecurityState } from "./request-security.js";
// ============================================================
// Vercel AI SDK model runner
// ============================================================

import {
  ModelErrorCode,
  ModelProtocolError,
  getCurrentModelInvocationContext,
} from "@zcode/contracts";
import type {
  Logger,
  Model,
  ModelOptions,
  ModelRequestAuth,
  ModelRequestDependencies,
  ModelRequestAuthSourceInput,
  ModelStatusSink,
  ModelStreamEvent,
  ModelTextResult,
} from "@zcode/contracts";
import type { RegistryModelConfig, RegistryProviderConfig } from "@zcode/provider";
import {
  AiSdkModelExecution,
  type AiSdkResolvedModel,
  type AiSdkNetworkConfig,
  type AiSdkModelExecutionConfig,
  type EnvRecord,
} from "./model-execution.js";
import {
  resolveAiSdkModelRetryOptions,
  type AiSdkModelRetryOptions,
  type ResolvedAiSdkModelRetryOptions,
} from "./retry-policy.js";
import { resolveRetryOptionsForBudget } from "./retry-budget.js";
import { DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS } from "./stream-idle-timeout.js";
import { runGenerateText } from "./runner-generate.js";
import { runStreamText } from "./runner-stream.js";
import { normalizeReasoningHistory } from "./reasoning-history-normalization.js";
import {
  defaultRuntime,
  type AiSdkAccountAccess,
  type AiSdkModelRuntime,
  type AiSdkModelTextRequest,
  type ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { createModel, type ModelExecutionRequest } from "./model.js";
import { refreshOffPeakRequestAuth } from "./off-peak-request-auth.js";
import { aggregateModelStreamToTextResult } from "./stream-to-text-result.js";

export type { AiSdkModelRetryOptions } from "./retry-policy.js";
export type {
  AiSdkGenerateTextOptions,
  AiSdkGenerateTextResult,
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  AiSdkStreamTextResult,
} from "./runner-runtime.js";
export { normalizeUsage, toModelStreamEvent } from "./runner-normalization.js";

export interface AiSdkModelAdapterOptions {
  defaultHeaders?: AiSdkModelExecutionConfig["defaultHeaders"];
  requestSecurityState?: ModelRequestSecurityState;
  endpointRoutingPort?: import("@zcode/contracts").ProviderEndpointRoutingPort;
  network?: AiSdkNetworkConfig;
  runtime?: AiSdkModelRuntime;
  env?: EnvRecord;
  debugDir?: string;
  logger?: Logger;
  retry?: AiSdkModelRetryOptions;
  statusSink?: ModelStatusSink;
  streamIdleTimeoutMs?: number;
  modelIoFullRetentionEnabled?: boolean;
}

export interface CreateAiSdkModelOptions {
  providerId: string;
  modelId: string;
  providerConfig: RegistryProviderConfig;
  modelConfig: RegistryModelConfig;
  displayName?: string;
  options?: ModelOptions;
  requestDependencies?: ModelRequestDependencies;
}

export class AiSdkModelAdapter {
  private readonly execution: AiSdkModelExecution;
  private readonly runtime: AiSdkModelRuntime;
  private readonly env: EnvRecord;
  private readonly debugDir?: string;
  private readonly logger?: Logger;
  private readonly retry: ResolvedAiSdkModelRetryOptions;
  private statusSink?: ModelStatusSink;
  private readonly streamIdleTimeoutMs: number;
  private modelIoFullRetentionEnabled: boolean;

  constructor(options: AiSdkModelAdapterOptions) {
    this.execution = new AiSdkModelExecution(
      {
        defaultHeaders: options.defaultHeaders,
        ...(options.endpointRoutingPort
          ? { endpointRoutingPort: options.endpointRoutingPort }
          : {}),
        ...(options.network ? { network: options.network } : {}),
        ...(options.env ? { env: options.env } : {}),
      },
      {
        ...(options.requestSecurityState
          ? { requestSecurityState: options.requestSecurityState }
          : {}),
        ...(options.logger ? { logger: options.logger } : {}),
      },
    );
    this.runtime = options.runtime ?? defaultRuntime;
    this.env = options.env ?? process.env;
    this.debugDir = options.debugDir;
    this.logger = options.logger;
    this.retry = resolveAiSdkModelRetryOptions(options.retry, this.env);
    this.statusSink = options.statusSink;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS;
    this.modelIoFullRetentionEnabled = options.modelIoFullRetentionEnabled ?? false;
  }

  setModelIoFullRetentionEnabled(enabled: boolean): void {
    this.modelIoFullRetentionEnabled = enabled;
  }

  addStatusSink(sink: ModelStatusSink): void {
    const current = this.statusSink;
    if (!current || current === sink) {
      this.statusSink = sink;
      return;
    }
    this.statusSink = {
      async publish(event) {
        // Run sinks independently: failure in one sink must not affect the others or block the existing call chain.
        const results = await Promise.allSettled([
          Promise.resolve().then(() => current.publish(event)),
          Promise.resolve().then(() => sink.publish(event)),
        ]);
        const failed = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failed) throw failed.reason;
      },
    };
  }

  createModel(options: CreateAiSdkModelOptions): Model {
    const boundResolution = this.execution.bindModel({
      providerId: options.providerId,
      modelId: options.modelId,
      providerConfig: options.providerConfig,
      supportsJsonSchemaOutput: options.modelConfig.properties.supportsJsonSchemaOutput,
      optionSpecs: options.modelConfig.optionSpecs,
    });
    const properties = options.modelConfig.properties;
    const resolved = {
      ...boundResolution.resolved,
      properties,
      ...(resolveAccountAccess(options.providerConfig.access)
        ? { accountAccess: resolveAccountAccess(options.providerConfig.access) }
        : {}),
    };
    const optionSpecs = options.modelConfig.optionSpecs;
    const toLegacyRequest = (request: ModelExecutionRequest): AiSdkModelTextRequest => {
      const context = getCurrentModelInvocationContext();
      const {
        refreshRuntimeHeadersBeforeAttempt: contextRefreshRuntimeHeadersBeforeAttempt,
        ...invocationContext
      } = context ?? {};
      const shouldAttachReasoningTelemetry = request.options.reasoningLevel !== undefined;
      const selectedReasoningLevel = request.options.reasoningLevel;
      const requestAuthDependency = options.requestDependencies?.requestAuth;
      // Root cause: accelerated-card (highspeed) and Off-Peak are both Coding Plan-derived modes; this turn's dynamic auth
      // (zcode JWT + Coding Plan dual JWT + X-Highspeed-Card-ID, see docs/highspeed/highspeed-card-spec.md
      // §2.2) is passed to the execution-scoped Source through modelExecution.requestAuth. If the gate recognizes only off-peak, highspeed
      // falls into the account runtime-header refresh path below, which discards the entire requestAuth (including card ID); the accelerated request then fails with 401 at /api/v1/highspeed because of the missing card ID/
      // wrong auth. Both derived no-sign-in modes must consume the execution-scoped Source.
      const requestAuthRequired =
        options.providerConfig.access.type === "zhipu-account" &&
        (options.providerConfig.access.mode === "off-peak" ||
          options.providerConfig.access.mode === "highspeed");
      // The call-level runtime-header Port serves only account-based Models with complete Account Access bindings;
      // if ordinary API-key Models use this port too, static auth is incorrectly sent to the Host for refresh and fails before the request.
      // Derived modes retain execution-scoped tickets/card identity; Off-Peak PATs still refresh per request through the original account owner.
      const refreshRuntimeHeadersBeforeAttempt = requestAuthRequired
        ? async (input: ModelRequestAuthSourceInput) => {
            const requestAuth = await requestAuthDependency?.source?.resolve(input);
            if (!hasRequestAuth(requestAuth)) {
              throw new ModelProtocolError(
                ModelErrorCode.ModelRequestAuthMissing,
                `Model request auth is unavailable: ${resolved.providerId}/${resolved.modelId}`,
              );
            }
            const refreshedAuth =
              options.providerConfig.access.type === "zhipu-account" &&
              options.providerConfig.access.mode === "off-peak"
                ? await refreshOffPeakRequestAuth({
                    auth: requestAuth,
                    input,
                    accountAccess: options.providerConfig.access,
                    refresh: contextRefreshRuntimeHeadersBeforeAttempt,
                  })
                : requestAuth;
            return { headersApplied: true, requestAuth: refreshedAuth };
          }
        : isAccountAccess(options.providerConfig.access)
          ? (contextRefreshRuntimeHeadersBeforeAttempt ??
            (async () => {
              throw new ModelProtocolError(
                ModelErrorCode.ModelRequestAuthMissing,
                `Account model request auth is unavailable: ${resolved.providerId}/${resolved.modelId}`,
              );
            }))
          : undefined;
      return {
        messages: request.messages,
        tools: request.tools,
        responseJsonSchema: request.responseJsonSchema,
        abortSignal: request.abortSignal,
        maxOutputTokens: request.options.maxOutputTokens,
        ...invocationContext,
        ...(shouldAttachReasoningTelemetry
          ? {
              modelCall: {
                ...invocationContext.modelCall,
                reasoning: {
                  ...invocationContext.modelCall?.reasoning,
                  // Inferring enabled/disabled from tier names such as none/off made Telemetry treat
                  // provider-specific dialects as universal semantics. Record only the public tier
                  // actually selected for the request.
                  ...(selectedReasoningLevel ? { requestedLevel: selectedReasoningLevel } : {}),
                },
              },
            }
          : {}),
        ...(refreshRuntimeHeadersBeforeAttempt
          ? {
              refreshRuntimeHeadersBeforeAttempt: (input) =>
                refreshRuntimeHeadersBeforeAttempt({
                  ...input,
                  ...(options.providerConfig.access.type === "zhipu-account"
                    ? { accountAccess: options.providerConfig.access }
                    : {}),
                }),
            }
          : {}),
      };
    };
    const resolveForRequest = (
      request: AiSdkModelTextRequest,
      optionValues: Required<ModelOptions>,
    ): ((requestAuth?: ModelRequestAuth) => ResolvedAiSdkModel) => {
      const maxOutputTokens = requireMaxOutputTokens(optionValues);
      return request.refreshRuntimeHeadersBeforeAttempt
        ? (requestAuth) => ({
            ...assertSameBoundModel(
              resolved,
              boundResolution.resolveRequest({
                options: {
                  maxOutputTokens,
                  reasoningLevel: optionValues.reasoningLevel,
                },
                requestAuth,
              }),
            ),
            properties,
            ...(resolveAccountAccess(options.providerConfig.access)
              ? { accountAccess: resolveAccountAccess(options.providerConfig.access) }
              : {}),
          })
        : () => ({
            ...boundResolution.resolveRequest({
              options: {
                maxOutputTokens,
                reasoningLevel: optionValues.reasoningLevel,
              },
            }),
            properties,
            ...(resolveAccountAccess(options.providerConfig.access)
              ? { accountAccess: resolveAccountAccess(options.providerConfig.access) }
              : {}),
          });
    };
    return createModel({
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      displayName: options.displayName,
      properties,
      optionSpecs: {
        maxOutputTokens: optionSpecs.maxOutputTokens,
        reasoningLevel: optionSpecs.reasoningLevel,
      },
      options: options.options,
      executor: {
        generateText: (request) => {
          const legacyRequest = toLegacyRequest(request);
          if (options.providerConfig.access.type === "chatgpt-account") {
            // The SIWC direct route rejects non-streaming requests (stream:true is required on
            // every inference call), so route generateText through the streaming path and aggregate.
            return aggregateModelStreamToTextResult(
              this.streamTextWithResolved(
                legacyRequest,
                resolved,
                resolveForRequest(legacyRequest, request.options),
              ),
            );
          }
          return this.generateTextWithResolved(
            legacyRequest,
            resolved,
            resolveForRequest(legacyRequest, request.options),
          );
        },
        streamText: (request) => {
          const legacyRequest = toLegacyRequest(request);
          return this.streamTextWithResolved(
            legacyRequest,
            resolved,
            resolveForRequest(legacyRequest, request.options),
          );
        },
      },
    });
  }

  private generateTextWithResolved(
    request: AiSdkModelTextRequest,
    resolved: ResolvedAiSdkModel,
    resolveModel: () => ResolvedAiSdkModel,
  ): Promise<ModelTextResult> {
    const projectedRequest = projectRequestHistory(request, resolved);
    return runGenerateText({
      debugDir: this.debugDir,
      env: this.env,
      logger: this.logger,
      request: projectedRequest,
      resolveModel,
      resolved,
      retry: resolveRetryOptionsForBudget(this.retry, projectedRequest.modelRetryBudget),
      runtime: this.runtime,
      statusSink: this.statusSink,
      modelIoFullRetentionEnabled: this.modelIoFullRetentionEnabled,
    });
  }

  private async *streamTextWithResolved(
    request: AiSdkModelTextRequest,
    resolved: ResolvedAiSdkModel,
    resolveModel: () => ResolvedAiSdkModel,
  ): AsyncGenerator<ModelStreamEvent> {
    const projectedRequest = projectRequestHistory(request, resolved);
    yield* runStreamText({
      debugDir: this.debugDir,
      env: this.env,
      logger: this.logger,
      request: projectedRequest,
      resolveModel,
      resolved,
      // The single-attempt budget reduces maxAttempts to 1 for execution-scoped handles with selectionFallback.
      retry: resolveRetryOptionsForBudget(this.retry, projectedRequest.modelRetryBudget),
      runtime: this.runtime,
      statusSink: this.statusSink,
      streamIdleTimeoutMs: this.streamIdleTimeoutMs,
      modelIoFullRetentionEnabled: this.modelIoFullRetentionEnabled,
    });
  }
}

function requireMaxOutputTokens(options: ModelOptions): number {
  if (options.maxOutputTokens === undefined) {
    throw new ModelProtocolError(
      ModelErrorCode.InvalidModelRequest,
      "maxOutputTokens requires an explicit request value",
    );
  }
  return options.maxOutputTokens;
}

function isAccountAccess(access: RegistryProviderConfig["access"]): boolean {
  return access.type === "zhipu-account" || access.type === "chatgpt-account";
}

/** Both account domains need per-attempt runtime-header refresh; only zhipu carries a wire payload. */
function resolveAccountAccess(
  access: RegistryProviderConfig["access"],
): AiSdkAccountAccess | undefined {
  if (access.type === "zhipu-account") return access;
  if (access.type === "chatgpt-account") return { type: "chatgpt-account" };
  return undefined;
}

function hasRequestAuth(
  requestAuth: ModelRequestAuth | undefined,
): requestAuth is ModelRequestAuth {
  if (requestAuth?.apiKey?.trim()) return true;
  return Object.values(requestAuth?.headers ?? {}).some((value) => value.trim().length > 0);
}

function assertSameBoundModel(
  bound: ResolvedAiSdkModel,
  refreshed: AiSdkResolvedModel,
): AiSdkResolvedModel {
  if (bound.providerId !== refreshed.providerId || bound.modelId !== refreshed.modelId) {
    throw new Error("Runtime header refresh changed the bound model identity.");
  }
  return refreshed;
}

function projectRequestHistory(
  request: AiSdkModelTextRequest,
  resolved: ResolvedAiSdkModel,
): AiSdkModelTextRequest {
  if (resolved.providerKind !== "anthropic") return request;

  // Structural normalization used to run in the serializer for every physical request, so a
  // signature-repair retry would remove the assistant placeholder added in the previous attempt
  // and merge the user message again. Project once at the logical request entry point; later attempts
  // may only reuse or derive from this request-local history.
  const messages = normalizeReasoningHistory(request.messages, {
    providerId: resolved.providerId,
    modelId: resolved.modelId,
  });
  return messages === request.messages ? request : { ...request, messages };
}
