/**
 * quick-prompts-ui contract layer: the only file of this module that imports @zcode/services. The other module files
 * import these names from here, so the UI layer never depends on a service implementation (architecture policy rule
 * ui-implementation-import). Keep this list to what the UI consumes.
 */
export {
  LEGACY_SINGLE_ROOT_PROJECT_PREFIX,
  QUICK_PROMPTS_CHANGED_CHANNEL,
  QUICK_PROMPT_BODY_MAX_LENGTH,
  QUICK_PROMPT_COLORS,
  QUICK_PROMPT_LIST_LIMIT,
  QUICK_PROMPT_NAME_MAX_LENGTH,
  findQuickPromptGlobalBlockers,
} from "@zcode/services";
export type {
  IQuickPromptService,
  QuickPrompt,
  QuickPromptBody,
  QuickPromptColor,
  QuickPromptProjectRef,
  QuickPromptScope,
  QuickPromptSnapshot,
} from "@zcode/services";
