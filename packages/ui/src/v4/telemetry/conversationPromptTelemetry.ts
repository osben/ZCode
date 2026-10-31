import {
  normalizeTelemetryUiMode,
  ZCODE_AGENT_PROVIDER,
  type TelemetryUiMode,
  type PlanIdentitySnapshot,
  type ZCodeProvider,
} from "@zcode/shared";
import { buildPromptTelemetryExtraDetail } from "@/lib/messageTelemetry.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { legacyTelemetryProviderId } from "@/lib/providerTelemetryIdentity.js";

export function resolveLegacyConversationModelValue(params: {
  configProvider?: string | null;
  modelName?: string | null;
}): string | null | undefined {
  const configProvider = params.configProvider?.trim();
  const modelName = params.modelName?.trim();
  if (!configProvider || !modelName || configProvider === ZCODE_AGENT_PROVIDER) {
    return params.modelName;
  }
  // Fix rationale: V4 config stores provider/model separately, so reporting only model loses the old UI's
  // `custom:<provider>:<model>` dimension and puts the same model into separate analytics buckets across old and new versions.
  return encodeCustomModelValue(legacyTelemetryProviderId(configProvider), modelName);
}

export { resolveLegacyRuntimeModelValue } from "@zcode/shared/conversation-telemetry";

/** V4 config.provider is the actual model provider ID; agentProvider identifies the ZCode runtime. */
export function buildV4ConversationPromptTelemetryExtraDetail(params: {
  uiMode?: TelemetryUiMode;
  agentProvider?: ZCodeProvider;
  configProvider?: string | null;
  modelName?: string | null;
  askMode?: string | null;
  providerBaseURL?: string | null;
  planIdentitySnapshot?: PlanIdentitySnapshot | null;
}): Record<string, string> {
  const agentProvider = params.agentProvider ?? ZCODE_AGENT_PROVIDER;
  const base = buildPromptTelemetryExtraDetail({
    askMode: params.askMode,
    modelName: resolveLegacyConversationModelValue(params),
    provider: agentProvider,
    providerBaseURL: params.providerBaseURL,
    planIdentitySnapshot: params.planIdentitySnapshot,
  });
  return {
    ...base,
    ui_mode: normalizeTelemetryUiMode(params.uiMode),
    message_source: "chat",
    task_trigger: "",
    model_provider: legacyTelemetryProviderId(
      params.configProvider?.trim() || base.model_provider || "",
    ),
    // agent identifies the ZCode runtime and must not be replaced with the model provider ID.
    agent: agentProvider,
  };
}
