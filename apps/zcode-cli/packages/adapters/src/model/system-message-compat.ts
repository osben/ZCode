import {
  modelMessageContentToText,
  type ModelInputMessage,
} from "@zcode/contracts";

export function normalizeOpenAiCompatibleSystemMessages(
  messages: readonly ModelInputMessage[],
): ModelInputMessage[] {
  let leadingSystemCount = 0;
  while (messages[leadingSystemCount]?.role === "system") {
    leadingSystemCount += 1;
  }

  if (leadingSystemCount <= 1) {
    return [...messages];
  }

  const leadingSystemMessages = messages.slice(0, leadingSystemCount);
  const lastLeadingSystem = leadingSystemMessages.at(-1);

  // Some older OpenAI-compatible chat templates accept only one leading system message.
  // Core intentionally preserves multiple segments for Anthropic cache boundaries, so merge them
  // in their original order only at the compatible-protocol serialization boundary.
  // By design, each subsequent block carries its own left boundary; the adapter does not infer or add whitespace.
  return [
    {
      role: "system",
      content: leadingSystemMessages
        .map((message) => modelMessageContentToText(message.content))
        .join(""),
      ...(lastLeadingSystem?.cacheControl
        ? { cacheControl: { ...lastLeadingSystem.cacheControl } }
        : {}),
    },
    ...messages.slice(leadingSystemCount),
  ];
}
