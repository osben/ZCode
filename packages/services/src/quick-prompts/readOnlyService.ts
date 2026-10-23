import {
  QUICK_PROMPT_READ_ONLY_ERROR,
  type IQuickPromptService,
} from "#src/quick-prompts/contract.js";

/**
 * Read-only view of the quick prompt service for mobile attachments (spec rule 21). Reads pass through; every
 * mutation rejects with a stable code instead of being omitted, so a stale client gets an explicit answer.
 * Pure on purpose: the desktop Host and both Source Server WebSocket paths wrap the same service the same way.
 */
export function createReadOnlyQuickPromptService(
  service: IQuickPromptService,
): IQuickPromptService {
  const rejected = async (): Promise<never> => {
    throw new Error(QUICK_PROMPT_READ_ONLY_ERROR);
  };
  return {
    read: (input) => service.read(input),
    readProjects: () => service.readProjects(),
    create: rejected,
    update: rejected,
    delete: rejected,
    duplicate: rejected,
    setPinned: rejected,
    setHidden: rejected,
    reorder: rejected,
  };
}
