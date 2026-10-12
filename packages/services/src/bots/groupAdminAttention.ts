import type { BotActor, BotOutboundMessage } from "@zcode/shared";

/** Escalates only config/connection errors explicitly identified by the service; never scan model output to guess admin to-dos. */
export class BotAdminRequiredError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** Preserves structured prompts from the preparation phase so topic continuation does not flatten recipients into plain text. */
export class BotReplyError extends Error {
  constructor(public readonly replies: BotOutboundMessage[]) {
    super(replies.map((reply) => reply.text).join("\n"));
  }
}

/** Notification dedup does not participate in task intake, authorization, or execution; re-notifications after a restart are allowed. */
export function createGroupAdminAttention() {
  const sent = new Map<string, true>();
  const scope = (actor: BotActor, owner: string) =>
    JSON.stringify([actor.botId, actor.chatId, actor.threadId, owner]);
  return {
    mention(actor: BotActor, owner: string | undefined, reason: string): string[] | undefined {
      if (actor.chatType !== "group" || !actor.chatId || !owner) return undefined;
      const key = `${scope(actor, owner)}:${reason}`;
      if (sent.has(key)) return [];
      sent.set(key, true);
      if (sent.size > 1000) sent.delete(sent.keys().next().value!);
      return [owner];
    },
    clear(actor?: BotActor, owner?: string, reason?: string) {
      if (!actor) {
        sent.clear();
        return;
      }
      if (!owner) return;
      const prefix = `${scope(actor, owner)}:`;
      for (const key of sent.keys()) {
        if (
          reason
            ? key === `${prefix}${reason}`
            : key.startsWith(prefix) &&
              !key.slice(prefix.length).startsWith("permission:") &&
              !key.slice(prefix.length).startsWith("plan:")
        )
          sent.delete(key);
      }
    },
  };
}
