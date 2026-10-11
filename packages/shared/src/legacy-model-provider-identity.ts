import {
  BUILTIN_MODEL_PROVIDER_IDS,
  BUILTIN_PROVIDER_TEMPLATE_IDS,
} from "./model-provider-types.js";
import { normalizeOfficialGlmModelId } from "./official-glm-model-id.js";

// Do not infer the site from a user-defined Provider name; the binding identity for off-peak tickets must not change either.
export function migrateLegacyOfficialGlmModelId(providerId: string, modelId: string): string {
  return /^(?:builtin:(?:zai|bigmodel)(?:-start-plan|-coding-plan)?|account:(?:zai|bigmodel)-(?:start-plan|individual-coding-plan|team-coding-plan))$/.test(
    providerId,
  )
    ? normalizeOfficialGlmModelId(modelId)
    : modelId;
}

/**
 * Used only for one-way upgrades of previously published data; not a runtime Provider alias or selection fallback.
 * Using the current account to interpret an old Coding Plan would lose the original intent during offline/SSH migration.
 * Same-domain Individual is only a deterministic migration target; resolving the current account belongs to valid-selection parsing and must not bind execution here.
 * Migration does not check model/tier availability; an ordinary unknown ID is not evidence of a legacy format.
 */
export function migrateLegacyModelProviderId(providerId: string): string | undefined {
  switch (providerId) {
    case "builtin:bigmodel":
      return BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel;
    case "builtin:zai":
      return BUILTIN_PROVIDER_TEMPLATE_IDS.zai;
    case "builtin:bigmodel-start-plan":
      return BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
    case "builtin:zai-start-plan":
      return BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan;
    case "builtin:bigmodel-coding-plan":
      return BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
    case "builtin:zai-coding-plan":
      return BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    default:
      return providerId.startsWith("builtin:") ? undefined : providerId;
  }
}
