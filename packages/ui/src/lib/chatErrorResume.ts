import type { ZCodeUiError } from "./zcodeUiError.js";

export const CHAT_ERROR_RESUME_MESSAGE = "Continue from where you left off";

const MODEL_CONFIG_MISSING_CODES = new Set([
  "model_config_missing",
  "MODEL_CONFIG_MISSING",
  "ModelConfigMissing",
]);

export function isModelConfigMissingError(error: Pick<ZCodeUiError, "code" | "message">): boolean {
  // 桌面端发送前 registry 为空时，agent 会退回 CLI config 并抛 Model config is missing。
  // 真实原因是“当前没有可用模型”，不能把 CLI 配置路径直接暴露给桌面用户。
  // 这里只按结构化 code 识别，避免 UNKNOWN/SEND_FAILED 等包装错误的可读 message
  // 碰巧包含同一段文本时被误判，并连带隐藏复制、反馈等诊断入口。
  return Boolean(error.code && MODEL_CONFIG_MISSING_CODES.has(error.code));
}

// 重发同一提示不能修复缺失的模型配置，hook 拦截也会在重发时再次拦截，因此这两类错误不提供 Resume。
export function canResumeChatError(error: Pick<ZCodeUiError, "code" | "message">): boolean {
  return !isModelConfigMissingError(error) && error.code !== "fault.runtime.hookBlocked";
}
