import type { ZCodeUiError } from "./zcodeUiError.js";

export const CHAT_ERROR_RESUME_MESSAGE = "Continue from where you left off";

const MODEL_CONFIG_MISSING_CODES = new Set([
  "model_config_missing",
  "MODEL_CONFIG_MISSING",
  "ModelConfigMissing",
]);

export function isModelConfigMissingError(error: Pick<ZCodeUiError, "code" | "message">): boolean {
  // On desktop, the agent falls back to the CLI config when the model registry is empty and throws "Model config is missing".
  // The real cause is that no model is available; the CLI config path must not be exposed to desktop users.
  // Match only the structured code. Wrapped errors such as UNKNOWN or SEND_FAILED can contain the same text in their message,
  // and matching it would wrongly hide Copy and Feedback.
  return Boolean(error.code && MODEL_CONFIG_MISSING_CODES.has(error.code));
}

// Resending the same prompt cannot fix a missing model config, and a hook block would fire again on resend,
// so Resume is not offered for either error.
export function canResumeChatError(error: Pick<ZCodeUiError, "code" | "message">): boolean {
  return !isModelConfigMissingError(error) && error.code !== "fault.runtime.hookBlocked";
}
