/**
 * Usage hints on ChatGPT plan account groups of the model picker (specs/chatgpt-plan-signin.md "Usage across the
 * app"). Presentation only: a hint never disables a group or a model.
 */
import { parseChatGptPlanAccountProviderId } from "@zcode/shared";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import type { ChatGptPlanUsageMap } from "@/lib/chatGptPlanUsageStore.js";
import {
  usageHeadline,
  usageResetCountdown,
  usageWindowLabel,
  usageRemainingPercent,
  type UsageMessage,
} from "@/settings/model-provider-section/chatgptPlanUsage.js";

const GROUP_KEY_PREFIX = "registry-provider:";

type Format = (message: UsageMessage) => string;

/** The account key of a registry group of a ChatGPT plan account, or null. */
export function chatGptPlanAccountKeyOfGroup(group: Pick<ModelSelectGroup, "key">): string | null {
  if (!group.key.startsWith(GROUP_KEY_PREFIX)) return null;
  return parseChatGptPlanAccountProviderId(group.key.slice(GROUP_KEY_PREFIX.length));
}

export function withChatGptPlanUsageHints<Group extends ModelSelectGroup>(
  groups: readonly Group[],
  usage: ChatGptPlanUsageMap,
  nowMs: number,
  format: Format,
): Group[] {
  if (usage.size === 0) return [...groups];
  return groups.map((group) => {
    const accountKey = chatGptPlanAccountKeyOfGroup(group);
    const snapshot = accountKey ? usage.get(accountKey) : undefined;
    if (!snapshot) return group;
    const headline = usageHeadline(snapshot, nowMs);
    if (headline.kind === "pending") return group;
    const windows = [
      ["primary", snapshot.primary],
      ["secondary", snapshot.secondary],
    ] as const;
    const title = windows
      .flatMap(([role, window]) =>
        window
          ? [
              `${format(usageWindowLabel(window, role))}: ${format({
                id: "settings.modelProvider.chatgpt.usage.left",
                values: { percent: usageRemainingPercent(window.usedPercent) },
              })}`,
            ]
          : [],
      )
      .join(" · ");
    if (headline.kind === "limit") {
      return {
        ...group,
        labelHint: {
          text: format({ id: "chat.toolbar.chatgptUsage.limitReached" }),
          tone: "critical",
          title,
        },
      };
    }
    // The row stays short (menus are narrow); the reset countdown and every window go in the tooltip.
    const countdown = usageResetCountdown(headline.window.resetsAt, nowMs);
    const text = format({
      id: "settings.modelProvider.chatgpt.usage.left",
      values: { percent: headline.remaining },
    });
    const resets =
      countdown && countdown !== "pending"
        ? format({
            id: "settings.modelProvider.chatgpt.usage.resetsIn",
            values: { duration: format(countdown) },
          })
        : null;
    return {
      ...group,
      labelHint: { text, tone: headline.severity, title: resets ? `${resets} · ${title}` : title },
    };
  });
}
