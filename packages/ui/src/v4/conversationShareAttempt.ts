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
  rejectionRule?: string,
): ConversationShareAttempt | null {
  // 3218：分享已被 owner 撤销，旧幂等键只会继续返回撤销错误。
  if (code === 3211 || code === 3212 || code === 3218) return null;
  // 3210 + preparation_state_invalid：preparation 已不在可上传状态，或同一幂等键对应的请求已变化，
  // 沿用旧幂等键只会继续命中同一份失效记录。其他 3210（文件变化、缺上传）仍可原样重试。
  return code === 3210 && rejectionRule === "preparation_state_invalid" ? null : attempt;
}
