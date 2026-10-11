import type { InputRouting } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationComposerSendOptions } from "@/v4/ConversationComposer.js";

export interface PromptScrollFocusPolicyInput {
  draftMode: boolean;
  inputRoutingMode: InputRouting["mode"] | null;
  heldQueueDisposition?: ConversationComposerSendOptions["heldQueueDisposition"];
}

/**
 * Focus the bottom of the timeline for a new prompt only when it follows the immediate-send path.
 * enqueue represents future intent, and the user may currently be reading earlier content, so queueing must not steal their position;
 * both explicit dispositions of a held choice immediately call startNow, so they behave like ordinary direct sends.
 */
export function shouldFocusTimelineAfterComposerSend(input: PromptScrollFocusPolicyInput): boolean {
  if (input.draftMode) return true;
  if (input.heldQueueDisposition) return true;
  return input.inputRoutingMode === "startNow";
}
