import { channelContentText, type ChannelContentPart } from "@zcode/shared";
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

// Message-receive events use "bot" while history APIs use "app"; mixing them up previously dropped real bot events at the entry point.
export function isFeishuBotSender(senderType: string): boolean {
  return senderType === "bot" || senderType === "app";
}

/** Accept only real mention identities; never trigger execution from display names or literal @ text in the body. */
export function readGroupMessage(
  text: string,
  mentions: unknown,
  botOpenId: string,
  senderType: string,
  senderOpenId?: string,
): {
  text: string;
  commandText: string;
  mentionedBot: boolean;
  contentParts?: ChannelContentPart[];
} | null {
  // Bots may participate in onboarded topics, but their own echoes must be filtered by trusted ID, never by display name.
  if (!botOpenId || (senderType !== "user" && !isFeishuBotSender(senderType))) return null;
  if (isFeishuBotSender(senderType) && (!senderOpenId || senderOpenId === botOpenId)) return null;
  let mentioned = false;
  const tokens = new Map<string, ChannelContentPart>();
  for (const item of Array.isArray(mentions) ? mentions : []) {
    const mention = record(item);
    const id = record(mention?.id)?.open_id;
    const key = mention?.key;
    if (typeof key !== "string" || !key) continue;
    if (id === botOpenId) mentioned = true;
    if (typeof mention?.name === "string" || id === botOpenId) {
      if (typeof id === "string" && /^ou_[a-zA-Z0-9_-]+$/u.test(id))
        tokens.set(key, {
          type: "channelMention",
          refId: `m${tokens.size + 1}`,
          targetId: id,
          idType: "open_id",
          channel: "feishu",
          entityType: "unknown",
          name: typeof mention?.name === "string" && mention.name.trim() ? mention.name : id,
        });
      else tokens.set(key, { type: "text", text: `@${mention.name}` });
    }
  }
  text = text.trim();
  const contentParts: ChannelContentPart[] = [];
  while (text) {
    const next = [...tokens.keys()]
      .map((key) => ({ key, index: text.indexOf(key) }))
      .filter((item) => item.index >= 0)
      .sort((a, b) => a.index - b.index || b.key.length - a.key.length)[0];
    if (!next) {
      contentParts.push({ type: "text", text });
      break;
    }
    if (next.index) contentParts.push({ type: "text", text: text.slice(0, next.index) });
    contentParts.push(tokens.get(next.key)!);
    text = text.slice(next.index + next.key.length);
  }
  while (contentParts[0]?.type === "text") {
    contentParts[0].text = contentParts[0].text.trimStart();
    if (contentParts[0].text) break;
    contentParts.shift();
  }
  while (contentParts.at(-1)?.type === "text") {
    const last = contentParts.at(-1)!;
    if (last.type !== "text") break;
    last.text = last.text.trimEnd();
    if (last.text) break;
    contentParts.pop();
  }
  // A self-@ is part of the original transcript; only the command copy may strip the leading wake marker.
  let commandStart = 0;
  while (commandStart < contentParts.length) {
    const part = contentParts[commandStart]!;
    if (
      (part.type === "text" && !part.text.trim()) ||
      (part.type === "channelMention" && part.targetId === botOpenId)
    )
      commandStart++;
    else break;
  }
  return {
    text: channelContentText(contentParts),
    commandText: channelContentText(contentParts.slice(commandStart)).trim(),
    mentionedBot: mentioned,
    ...(contentParts.some((part) => part.type === "channelMention") ? { contentParts } : {}),
  };
}

export function readGroupMentionText(
  text: string,
  mentions: unknown,
  botOpenId: string,
  senderType: string,
  senderOpenId?: string,
): string | null {
  // Quoted preparation must also pass through the sender identity, otherwise legitimate bots get filtered as missing identities.
  const message = readGroupMessage(text, mentions, botOpenId, senderType, senderOpenId);
  return message?.mentionedBot ? message.text : null;
}

/** Extract only the card's visible body; button values and approval parameters must not be treated as another bot's speech. */
export function readGroupCardText(value: unknown): string {
  if (Array.isArray(value)) return value.map(readGroupCardText).filter(Boolean).join("\n");
  const item = record(value);
  if (!item) return "";
  const lines: string[] = [];
  for (const key of ["elements", "body", "header", "title", "text", "content"]) {
    const child = item[key];
    if (typeof child === "string" && (key === "text" || key === "content")) lines.push(child);
    else if (typeof child === "object") lines.push(readGroupCardText(child));
  }
  return lines.filter(Boolean).join("\n");
}

/** "interactive" is also an ordinary reply carrier; identify action cards by widget structure, never by blocking all messages of a type. */
export function isGroupControlCard(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isGroupControlCard);
  const item = record(value);
  if (!item) return false;
  const tag = typeof item.tag === "string" ? item.tag : "";
  if (
    /^(?:button|action|form|input|select(?:_.*)?|multi_select(?:_.*)?|date_picker|time_picker|datetime_picker|picker|checker|overflow)$/u.test(
      tag,
    )
  )
    return true;
  return Object.entries(item).some(([key, child]) => key !== "value" && isGroupControlCard(child));
}

/** Sender-side IDs inside card bodies may differ from receiver-side IDs; use the platform's ordered mentions to restore local identities. */
export function readGroupConversationCardText(value: unknown, mentions: unknown): string {
  const text = readGroupCardText(value);
  const native = Array.isArray(mentions)
    ? mentions.map(record).filter((item) => typeof item?.key === "string")
    : [];
  const nodes = [...text.matchAll(/<at\s+id=["']?([^\s>"']+)["']?[^>]*>[\s\S]*?<\/at>/gu)];
  let index = 0;
  return text.replace(
    /<at\s+id=["']?([^\s>"']+)["']?[^>]*>[\s\S]*?<\/at>/gu,
    (_node, id: string) => {
      const mention =
        native.find((item) => record(item?.id)?.open_id === id) ??
        (native.length === nodes.length ? native[index] : undefined);
      index++;
      return typeof mention?.key === "string" ? mention.key : "@unknown";
    },
  );
}
