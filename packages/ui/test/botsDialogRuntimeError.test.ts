import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BotConfig, BotRuntimeInfo } from "@zcode/shared";
import { ALL_BOT_WORKSPACES } from "@zcode/shared";
import { BotSummaryCard } from "@/BotsDialog/BotSummaryCard.js";
import { ProviderSettingsCard } from "@/BotsDialog/ProviderSettingsCard.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";

const bot: BotConfig = {
  id: "feishu-bot",
  name: "咪处长",
  provider: "feishu",
  enabled: true,
  credentialRef: "credential-ref",
  feishuAppId: "cli_test",
  allowedWorkspaces: [ALL_BOT_WORKSPACES],
  allowedCommands: {},
  currentOptions: {},
  replyMode: "streaming_card",
};

const runtime: BotRuntimeInfo = {
  botId: bot.id,
  provider: bot.provider,
  status: "error",
  message: "Feishu WebSocket failed: code: 1000040351, system busy",
};

function renderZh(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, { initialLocale: "en-US" }, element),
  );
}

describe("BotsDialog runtime error", () => {
  it("shows a runtime failure instead of the unbound summary", () => {
    const markup = renderZh(
      createElement(BotSummaryCard, {
        bot,
        runtime,
        selectedBotDisplayName: bot.name,
        selectedBotName: bot.name,
        fallbackBotName: "飞书机器人",
        renaming: false,
        onStartRename: vi.fn(),
        onCommitNameDraft: vi.fn(),
        onNameDraftChange: vi.fn(),
        onNameInputKeyDown: vi.fn(),
        onPatchBot: vi.fn(),
      }),
    );

    expect(markup).toContain(expectedCopy("bots.runtime.feishuConnectionFailed"));
    expect(markup).not.toContain(expectedCopy("bots.unbound"));
  });

  it("shows delivery errors independently of an active connection", () => {
    const markup = renderZh(
      createElement(ProviderSettingsCard, {
        bot,
        runtime: {
          ...runtime,
          status: "connected",
          deliveryError: "HTTP 200, code=230101, log_id=delivery-log",
        },
        credentialValue: "",
        bindCode: {
          botId: bot.id,
          code: "BB2549",
          createdAt: 1,
          expiresAt: 60_001,
          ttlMs: 60_000,
        },
        bindExpired: false,
        bindRemainingMs: 26_000,
        bindCountdownProgress: 43,
        feishuRegistration: null,
        feishuRegistrationLoading: false,
        weixinRegistration: null,
        weixinRegistrationLoading: false,
        weixinActivated: false,
        secretSaving: false,
        onCredentialValueChange: vi.fn(),
        onSaveSecret: vi.fn(),
        onRemoveSecret: vi.fn(),
        onOpenTelegramBotFather: vi.fn(),
        onStartWeixinRegistration: vi.fn(),
        onStartFeishuRegistration: vi.fn(),
        onCreateBindCode: vi.fn(),
        onUnbind: vi.fn(),
        onCopyBindCommand: vi.fn(),
      }),
    );

    expect(markup).toContain(expectedCopy("bots.runtime.deliveryFailed"));
    expect(markup).toContain("230101");
    expect(markup).toContain("delivery-log");
    expect(markup).not.toContain(expectedCopy("bots.runtime.cannotConnectFeishu"));
  });

  it("replaces an active bind command with the persistent connection error", () => {
    const markup = renderZh(
      createElement(ProviderSettingsCard, {
        bot,
        runtime,
        credentialValue: "",
        bindCode: {
          botId: bot.id,
          code: "BB2549",
          createdAt: 1,
          expiresAt: 60_001,
          ttlMs: 60_000,
        },
        bindExpired: false,
        bindRemainingMs: 26_000,
        bindCountdownProgress: 43,
        feishuRegistration: null,
        feishuRegistrationLoading: false,
        weixinRegistration: null,
        weixinRegistrationLoading: false,
        weixinActivated: false,
        secretSaving: false,
        onCredentialValueChange: vi.fn(),
        onSaveSecret: vi.fn(),
        onRemoveSecret: vi.fn(),
        onOpenTelegramBotFather: vi.fn(),
        onStartWeixinRegistration: vi.fn(),
        onStartFeishuRegistration: vi.fn(),
        onCreateBindCode: vi.fn(),
        onUnbind: vi.fn(),
        onCopyBindCommand: vi.fn(),
      }),
    );

    expect(markup).toContain(expectedCopy("bots.runtime.cannotConnectFeishu"));
    expect(markup).toContain("1000040351");
    expect(markup).toContain("system busy");
    expect(markup).not.toContain("/bind BB2549");
    expect(markup).not.toContain(expectedCopy("bots.setup.refreshBindCode"));
  });

  it("keeps an existing binding while showing that its connection is interrupted", () => {
    const markup = renderZh(
      createElement(ProviderSettingsCard, {
        bot: { ...bot, providerUserId: "ou_bound_user" },
        runtime,
        credentialValue: "",
        bindCode: null,
        bindExpired: false,
        bindRemainingMs: 0,
        bindCountdownProgress: 0,
        feishuRegistration: null,
        feishuRegistrationLoading: false,
        weixinRegistration: null,
        weixinRegistrationLoading: false,
        weixinActivated: false,
        secretSaving: false,
        onCredentialValueChange: vi.fn(),
        onSaveSecret: vi.fn(),
        onRemoveSecret: vi.fn(),
        onOpenTelegramBotFather: vi.fn(),
        onStartWeixinRegistration: vi.fn(),
        onStartFeishuRegistration: vi.fn(),
        onCreateBindCode: vi.fn(),
        onUnbind: vi.fn(),
        onCopyBindCommand: vi.fn(),
      }),
    );

    expect(markup).toContain(expectedCopy("bots.runtime.boundConnectionInterrupted"));
    expect(markup).toContain(expectedCopy("bots.runtime.boundConnectionInterruptedDescription"));
    expect(markup).toContain(expectedCopy("bots.unbind"));
    expect(markup).not.toContain(">已连通<");
    expect(markup).not.toContain("暂时不能完成绑定");
  });
});
