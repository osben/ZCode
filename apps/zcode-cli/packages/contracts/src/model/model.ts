import type {
  JsonSchema,
  ModelInputMessage,
  ModelId,
  ModelProviderId,
  ModelStreamEvent,
  ModelTextResult,
  ModelToolContract,
} from "./index.js";
import { modelSelectionSchema, type ModelSelection } from "@zcode/shared/model-selection";
import type { ModelPropertiesData, ModelOptionSpecsData } from "@zcode/shared/model-config";
import type { ToolSearchCapability } from "../tools/tool-search.js";

export type { ModelSelection } from "@zcode/shared/model-selection";

// Retain only the CLI's public type names; fields come from the same data schema, without copying provider configuration definitions.
export type {
  ModelInputFormatData as ModelInputFormat,
  ModelOutputFormatData as ModelOutputFormat,
  EnumOptionSpecData as EnumOptionSpec,
  LimitOptionSpecData as LimitOptionSpec,
} from "@zcode/shared/model-config";
export type ModelOptionSpecs = ModelOptionSpecsData;
export type ModelProperties = ModelPropertiesData;
export type ModelPropertiesInput = ModelProperties;

export interface ModelOptions {
  reasoningLevel?: string;
  maxOutputTokens?: number;
}

export interface ModelRequest {
  toolSearchEnabled?: boolean;
  messages: ModelInputMessage[];
  tools?: ModelToolContract[];
  responseJsonSchema?: JsonSchema;
  options?: ModelOptions;
  abortSignal?: AbortSignal;
}

// The first phase reuses result and stream-event fields already normalized by the Provider SDK.
// Keep old names only at the Adapter compatibility boundary; business code uses the two names below.
export type ModelResult = ModelTextResult;
export type ModelEvent = ModelStreamEvent;

export interface Model {
  readonly requestCapabilities?: { readonly toolSearch?: ToolSearchCapability };
  readonly providerId: ModelProviderId;
  readonly modelId: ModelId;
  readonly displayName?: string;
  readonly properties: ModelProperties;
  readonly optionSpecs: ModelOptionSpecs;
  readonly options: ModelOptions;

  bind(options?: ModelOptions): Model;
  generateText(request: ModelRequest): Promise<ModelResult>;
  streamText(request: ModelRequest): AsyncIterable<ModelEvent>;
}

/** Validate the current ModelSelection value; convert old database formats only in a versioned migration, not as a fallback during normal reads. */
export function parseModelSelectionValue(value: unknown): ModelSelection | undefined {
  const parsed = modelSelectionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
