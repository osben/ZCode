import type { BotTopicHistoryBatch, BotTopicHistoryRequest, BotTopicMessage } from "@zcode/shared";

/** Distinguish permission denials from transient network errors so failures do not mislead users into re-authorizing. */
export class TopicHistoryPermissionError extends Error {}

interface TopicHistoryReader {
  /** Native thread containers paginate newest-first; the API does not support time filtering. */
  list(page?: string): Promise<{ messages: BotTopicMessage[]; next?: string }>;
  get(messageId: string): Promise<BotTopicMessage>;
  hydrate?(message: BotTopicMessage): Promise<BotTopicMessage>;
}

/** Only prepares immutable background and never advances the checkpoint; advancing must wait for CLI admission confirmation. */
export async function readTopicHistory(
  request: BotTopicHistoryRequest,
  reader: TopicHistoryReader,
): Promise<BotTopicHistoryBatch> {
  // The first @ on a root message must still hit the native history API; never skip the permission check just because there are no older messages.
  if (request.messageId === request.rootMessageId && !request.checkpoint) {
    await reader.list();
    return { messages: [], checkpoint: request.messageId, hasGap: false };
  }
  const seen = new Set<string>();
  const messages: BotTopicMessage[] = [];
  let boundaryFound = false;
  let checkpointFound = !request.checkpoint;
  let hasGap = false;
  let page: string | undefined;
  let examined = 0;
  let finished = false;
  const validate = (message: BotTopicMessage) => {
    if (message.chatId !== request.chatId || message.threadId !== request.threadId)
      throw new Error("Topic history scope mismatch");
  };
  // The page cap also bounds scanning a flood of new messages after this @, so a hot topic never fails to catch up to the boundary.
  for (let pages = 0; pages < 8 && !finished; pages += 1) {
    const batch = await reader.list(page);
    for (const message of batch.messages) {
      validate(message);
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      if (!boundaryFound) {
        if (message.id === request.messageId) boundaryFound = true;
        continue;
      }
      if (message.id === request.checkpoint) {
        checkpointFound = true;
        finished = true;
        break;
      }
      if (examined >= 200) {
        hasGap = true;
        finished = true;
        break;
      }
      examined += 1;
      if (message.deleted) hasGap = true;
      if (!message.deleted && message.id !== request.rootMessageId) messages.push(message);
    }
    if (!batch.next) finished = true;
    else if (!finished) page = batch.next;
  }
  if (!boundaryFound) throw new Error("Topic history invocation boundary unavailable");
  if (!finished || !checkpointFound) hasGap = true;
  messages.reverse();
  if (!request.checkpoint) {
    const root = await reader.get(request.rootMessageId);
    validate(root);
    if (root.deleted) hasGap = true;
    else if (root.id !== request.messageId) messages.unshift(root);
  }
  // Messages outside the history window and deleted cards must not block this input round on a body-read failure; filter first, then read required material.
  if (reader.hydrate) {
    const hydrated = await Promise.all(messages.map((message) => reader.hydrate!(message)));
    messages.splice(0, messages.length, ...hydrated);
  }
  // Card bodies and bot confirmation replies are not discussion material; the scan still keeps the native boundary to avoid breaking the checkpoint.
  const isBot = (message: BotTopicMessage) => message.senderType === "app";
  const cards = new Set(
    messages
      .filter((message) => isBot(message) && message.controlCard === true)
      .map((message) => message.id),
  );
  return {
    messages: messages.filter(
      (message) =>
        !cards.has(message.id) &&
        !(isBot(message) && message.parentId && cards.has(message.parentId)),
    ),
    checkpoint: request.messageId,
    hasGap,
  };
}
