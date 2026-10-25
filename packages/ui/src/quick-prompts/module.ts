/**
 * quick-prompts-ui 模块清单（architecture-governance managed 模块）。
 * 层：contract（contract.ts，唯一可 import @zcode/services）与 ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const quickPromptsUiModule = {
  id: "quick-prompts-ui",
  requires: ["services", "ui", "project-sidebar", "prompt-body", "mobile-ui"],
  provides: ["quick-prompts-ui"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
