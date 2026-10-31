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
  readonly requestCapabilities?: {
    readonly toolSearch?: ToolSearchCapability;
    /** True when the protocol folds a tool result and the user text after it into one message; the projection merges the immediately following reminder into the tool result on this basis. */
    readonly foldRemindersIntoToolResults?: boolean;
  };
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

/** Model's data fields (invocation methods excluded). */
export type ModelDescriptor = Omit<Model, "bind" | "generateText" | "streamText">;

// The key table is forced complete by the type: adding a data field to Model without registering it here fails typecheck.
const MODEL_DESCRIPTOR_KEYS = {
  requestCapabilities: true,
  providerId: true,
  modelId: true,
  displayName: true,
  properties: true,
  optionSpecs: true,
  options: true,
} as const satisfies Record<keyof ModelDescriptor, true>;

/**
 * Model-wrapping decorators use it to copy all data fields and implement only the invocation methods themselves.
 * Fix rationale: when decorators hand-copied fields one by one, the idle-time wrapper missed the later-added
 * requestCapabilities, so idle turns did not fold into tool_result while ToolSearch was handled as
 * protocol-unsupported — one session showed two request shapes.
 */
export function modelDescriptorOf(model: Model): ModelDescriptor {
  const descriptor: Partial<Record<keyof ModelDescriptor, unknown>> = {};
  for (const key of Object.keys(MODEL_DESCRIPTOR_KEYS) as Array<keyof ModelDescriptor>) {
    if (model[key] !== undefined) descriptor[key] = model[key];
  }
  return descriptor as ModelDescriptor;
}

/** Validate the current ModelSelection value; convert old database formats only in a versioned migration, not as a fallback during normal reads. */
export function parseModelSelectionValue(value: unknown): ModelSelection | undefined {
  const parsed = modelSelectionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
