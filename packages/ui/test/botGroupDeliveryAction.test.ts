import { createElement, type ContextType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  BotGroupDeliveryAction,
  ConnectedBotGroupDeliveryAction,
} from "@/v4/BotGroupDeliveryAction.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { BotGroupDelivery } from "@zcode/shared";

import { DeliveryContext } from "@/v4/botGroupDeliveryContext.js";
import { expectedCopy } from "./helpers/uiCopy.js";

const render = (results: BotGroupDelivery[]) =>
  renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(BotGroupDeliveryAction, {
        turnId: "product-turn-a",
        sourceCommandIds: ["command-a"],
        syncing: true,
        results,
        onRetry: vi.fn(),
        onReconcile: vi.fn(),
      }),
    ),
  );
const result = (
  status: BotGroupDelivery["status"],
  sourceCommandId?: string,
): BotGroupDelivery => ({
  id: "delivery",
  taskId: "task",
  sourceCommandId,
  text: "SECRET_FULL_RESULT ou_sender",
  status,
  updatedAt: 1,
});
describe("group reply delivery action", () => {
  it.each(["sent", "failed", "unknown"] as const)(
    "topic-bound reply hides details and preserves %s delivery handling",
    (status) => {
      const value = {
        taskId: "task",
        context: {
          botId: "bot",
          workspacePath: "/workspace",
          mode: "task",
          activeTaskId: "task",
          updatedAt: 1,
          group: {
            chatId: "chat",
            threadId: "thread",
            name: "群聊",
            ownerId: "owner",
            enabled: true,
            taskIds: ["task"],
            currentOptions: {},
            deliveries: { delivery: result(status, "command-a") },
          },
        },
        provider: "feishu",
        busyId: null,
        retry: vi.fn(),
        reconcile: vi.fn(),
        retryPreparation: vi.fn(),
      } satisfies NonNullable<ContextType<typeof DeliveryContext>>;
      const html = renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(
            DeliveryContext.Provider,
            { value },
            createElement(ConnectedBotGroupDeliveryAction, {
              turnId: "turn",
              sourceCommandIds: ["command-a"],
            }),
          ),
        ),
      );
      expect(html).not.toContain("data-bot-topic-details");
      expect(html).not.toContain(expectedCopy("bots.topic.details"));
      if (status === "sent") expect(html).toBe("");
      else expect(html).toContain('data-bot-group-delivery="turn"');
    },
  );
  it.each(["pending", "sent", "invalidated"] as const)("hides %s deliveries", (status) => {
    expect(render([result(status, "command-a")])).toBe("");
  });
  it("never guesses another turn or a legacy delivery onto this reply", () => {
    expect(render([result("failed", "command-b"), result("unknown")])).toBe("");
  });
  it.each(["failed", "unknown"] as const)(
    "shows a compact %s action without duplicated content",
    (status) => {
      const html = render([result(status, "command-a")]);
      expect(html).toContain('data-bot-group-delivery="product-turn-a"');
      expect(html).toContain(
        status === "failed"
          ? expectedCopy("bots.group.deliveryFailed")
          : expectedCopy("bots.group.deliveryUnknown"),
      );
      expect(html).not.toContain("SECRET_FULL_RESULT");
      expect(html).not.toContain("ou_sender");
      expect(html).not.toContain("<aside");
      expect(html).not.toContain(expectedCopy("bots.group.confirmReceived"));
    },
  );
});
