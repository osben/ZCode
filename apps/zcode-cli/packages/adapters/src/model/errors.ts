// ============================================================
// AI SDK model adapter errors
// ============================================================

import {
  ModelFailureReason,
  type ErrorAttribution,
  type ModelErrorCode,
  type ModelId,
} from "@zcode/contracts";

export const ModelErrorSource = {
  Network: "network",
  Provider: "provider",
  Runtime: "runtime",
} as const satisfies Record<string, NonNullable<ErrorAttribution["source"]>>;

export type ModelErrorSource = (typeof ModelErrorSource)[keyof typeof ModelErrorSource];

export type LocalProviderConfigurationErrorContext = Record<string, unknown> & {
  envKey?: string;
  modelId?: ModelId;
  providerId: string;
  reason: typeof ModelFailureReason.ProviderNotConfigured;
  retryable: false;
  source: typeof ModelErrorSource.Runtime;
};

export function createLocalProviderConfigurationErrorContext(
  context: Pick<LocalProviderConfigurationErrorContext, "envKey" | "modelId" | "providerId">,
): LocalProviderConfigurationErrorContext {
  // Missing providers and authentication configuration errors occur before request creation and do
  // not pass through runner error normalization. Preserve runtime attribution directly at the Model
  // Execution assembly boundary so monitoring does not blame the upstream provider for local
  // configuration problems.
  return {
    ...context,
    reason: ModelFailureReason.ProviderNotConfigured,
    retryable: false,
    source: ModelErrorSource.Runtime,
  };
}

export interface AiSdkModelAdapterErrorOptions {
  cause?: unknown;
  context?: Record<string, unknown>;
}

export class AiSdkModelAdapterError extends Error {
  readonly code: ModelErrorCode;
  readonly cause?: unknown;
  readonly context?: Record<string, unknown>;

  constructor(code: ModelErrorCode, message: string, options?: AiSdkModelAdapterErrorOptions) {
    super(message);
    this.name = "AiSdkModelAdapterError";
    this.code = code;
    this.cause = options?.cause;
    this.context = options?.context;
  }

  enrichContext(context: Record<string, unknown>): this {
    Object.assign(this, { context });
    return this;
  }
}
