import type { BotOutboundMessage } from "@zcode/shared";

type ReplyTarget = Pick<BotOutboundMessage, "replyToMessageId" | "threadId" | "rootMessageId">;

/** Bounded fallback after an explicit unavailability; a topic must not be mis-sent to the owner's chat, nor retry the same stale anchor. */
export function getUnavailableReplyFallback(target: ReplyTarget): ReplyTarget | null {
  const current = target.replyToMessageId || (target.threadId ? target.rootMessageId : undefined);
  if (!current) return null;
  if (!target.threadId) return { ...target, replyToMessageId: undefined };
  if (!target.rootMessageId || current === target.rootMessageId) return null;
  return { ...target, replyToMessageId: target.rootMessageId };
}
