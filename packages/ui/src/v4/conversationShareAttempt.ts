import type { ConversationShareAttempt } from "@/store/conversationShareSelectionStore.js";

export type { ConversationShareAttempt } from "@/store/conversationShareSelectionStore.js";

export interface ConversationShareAttemptIdFactory {
  now?: () => number;
  randomUUID?: () => string | undefined;
}

export function ensureConversationShareAttempt(
  current: ConversationShareAttempt | null,
  attemptKey: string,
  sessionId: string,
  factory: ConversationShareAttemptIdFactory = {},
): ConversationShareAttempt {
  if (current?.key === attemptKey) return current;

  const now = factory.now ?? Date.now;
  const disclosureAcceptedAt = now();
  const requestSuffix = factory.randomUUID?.() ?? `${sessionId}-${disclosureAcceptedAt}`;

  // Retries must reuse the same idempotent request body. Previously, only clientRequestId was reused,
  // while disclosureAcceptedAt was regenerated on each SessionPane click, changing payload_sha256
  // and causing the server to reject the same idempotency key as a body conflict with 409.
  return {
    key: attemptKey,
    clientRequestId: `share-${requestSuffix}`,
    disclosureAcceptedAt,
  };
}

/** 只有服务端明确确认记录失效才能换幂等键；超时和审核等待不能据此判断发布失败。 */
export function retainConversationShareAttemptAfterFailure(
  attempt: ConversationShareAttempt,
  code?: number,
): ConversationShareAttempt | null {
  return code === 3211 || code === 3212 ? null : attempt;
}
