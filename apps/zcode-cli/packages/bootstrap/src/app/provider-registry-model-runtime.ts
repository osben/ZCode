import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import {
  createExternalAgentModel,
  type ExternalAgentTurnDriver,
  type Model,
} from "@zcode/contracts";
import type { AgentRuntimeDeps } from "@zcode/core";
import {
  type ModelSelection,
  type ModelSelectionValidation,
  type Provider,
  type ProviderModel,
  type ProviderRegistryView,
} from "@zcode/provider";
import { createRegistrySelectionProtocolError } from "./provider-registry-selection.js";

export type RuntimeModelFactory = NonNullable<AgentRuntimeDeps["modelFactory"]>;

export interface ProviderRegistryModelSource {
  getView(): ProviderRegistryView;
  getProvider(providerId: string): Provider | undefined;
  getModel(providerId: string, modelId: string): ProviderModel | undefined;
  validateSelection(selection: ModelSelection): ModelSelectionValidation;
  onDidChange(listener: () => void): () => void;
}

type ApiProviderModelAdapter = Pick<AiSdkModelAdapter, "createModel">;

/** Turn drivers of `acp-agent` providers, bound by the composition root (specs/acp-agent-runtime.md). */
export interface ExternalAgentDriverSource {
  driverFor(agentId: string): ExternalAgentTurnDriver;
}

interface ApiProviderModelRuntimeOptions {
  readonly registry: ProviderRegistryModelSource;
  readonly modelAdapter: ApiProviderModelAdapter;
  readonly externalAgents?: ExternalAgentDriverSource;
}

/**
 * Look up a complete fact from the business Registry and directly create a Model with frozen static configuration.
 */
export class ApiProviderModelRuntime {
  readonly #registry: ProviderRegistryModelSource;
  readonly #modelAdapter: ApiProviderModelAdapter;
  readonly #externalAgents: ExternalAgentDriverSource | undefined;
  #started = false;

  constructor(options: ApiProviderModelRuntimeOptions) {
    this.#registry = options.registry;
    this.#modelAdapter = options.modelAdapter;
    this.#externalAgents = options.externalAgents;
  }

  readonly modelFactory: RuntimeModelFactory = (target): Model => {
    if (!this.#started) throw new Error("ApiProviderModelRuntime 必须先 start() 再创建 Model");
    const validation = this.#registry.validateSelection(target.selection);
    if (!validation.ok) throw createRegistrySelectionProtocolError(validation);
    const providerId = target.selection.providerId;
    const modelId = target.selection.modelId;
    const provider = this.#registry.getProvider(providerId);
    if (!provider) throw new Error("Registry Selection 校验与 Provider 索引结果不一致");
    const registryModel = this.#registry.getModel(providerId, modelId);
    if (!registryModel) throw new Error("Registry Selection 校验与 Model 索引结果不一致");
    return this.#createRegistryModel(provider, registryModel, target);
  };

  start(): void {
    if (this.#started) return;
    this.#started = true;
  }

  dispose(): void {
    this.#started = false;
  }

  #createRegistryModel(
    provider: Provider,
    registryModel: ProviderModel,
    target: Parameters<RuntimeModelFactory>[0],
  ): Model {
    const config = registryModel.config;
    // ACP agents are external processes, not model APIs: the marker Model carries the turn driver and
    // never reaches the AI SDK adapter (specs/acp-agent-runtime.md "Chat delegation (phase 4)").
    // The registry access union does not name `acp-agent`, so the check is structural on the stored shape.
    const access = provider.config.access as { readonly type?: unknown; readonly agentId?: unknown };
    if (access.type === "acp-agent" && typeof access.agentId === "string") {
      const driver = this.#externalAgents?.driverFor(access.agentId);
      if (!driver) throw new Error("ACP agent runtime is not available in this process");
      const reasoningLevel = target.selection.options?.reasoningLevel;
      return createExternalAgentModel({
        driver,
        providerId: provider.providerId,
        modelId: registryModel.modelId,
        properties: config.properties,
        optionSpecs: config.optionSpecs,
        options: reasoningLevel === undefined ? {} : { reasoningLevel },
      });
    }
    // Output budget belongs to an individual request and must be explicitly determined by the Agent
    // execution chain, not silently bound in ModelFactory. Selection was validated at the Registry
    // boundary above, so Factory must not repair missing defaults.
    const normalReasoningLevel = target.selection.options!.reasoningLevel!;
    return this.#modelAdapter.createModel({
      providerId: provider.providerId,
      modelId: registryModel.modelId,
      providerConfig: provider.config,
      modelConfig: config,
      // Off-Peak and Highspeed both rely on execution-scoped dynamic requestAuth (JWT /
      // plan key / card ID header) when sending, so the source carrying it must be passed
      // through to the adapter. This gate corresponds one-to-one with the
      // requestAuthRequired gate in runner.ts: omitting highspeed drops the source here,
      // leaving runner-side requestAuth missing so the turn throws
      // model_request_auth_missing before sending.
      ...(provider.config.access.type === "zhipu-account" &&
      (provider.config.access.mode === "off-peak" ||
        provider.config.access.mode === "highspeed")
        ? {
            requestDependencies: {
              requestAuth: {
                source: target.requestDependencies?.requestAuth?.source,
              },
            },
          }
        : {}),
      options: {
        reasoningLevel: normalReasoningLevel,
      },
    });
  }
}
