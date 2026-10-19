// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";

const h = vi.hoisted(() => {
  const initialize = vi.fn(async () => {});
  const dismissNewTaskBanner = vi.fn();
  const setPendingCreateDraft = vi.fn();
  const refreshCodingPlanSupport = vi.fn(async () => {});
  const openCodingPlanUpgrade = vi.fn();
  const inventory = { status: "ready" as "ready" | "loading" | "error", retry: vi.fn() };
  const loggerDebug = vi.fn();
  const toast = vi.fn();
  const messages: { current: Record<string, string> } = { current: {} };
  const locale = { current: "en-US" };
  const offPeakTemplateIds = {
    current: ["standupGitSummary", "ciFlakyReport", "customize"] as string[],
  };
  const remoteTemplateCopy = {
    standupGitSummary: {
      en: {
        title: "Remote standup summary",
        description: "Remote Friday summary",
        prompt: "Summarize the remote standup.",
      },
      cn: { title: "远程站会摘要", description: "远程周五摘要", prompt: "汇总远程站会。" },
    },
    ciFlakyReport: {
      en: {
        title: "Remote CI report",
        description: "Remote CI failures",
        prompt: "Review the remote CI report.",
      },
      cn: { title: "远程 CI 报告", description: "远程 CI 失败", prompt: "检查远程 CI 报告。" },
    },
    documentationSyncCheck: {
      en: {
        title: "Remote docs check",
        description: "Remote documentation sync",
        prompt: "Review remote documentation.",
      },
      cn: { title: "远程文档检查", description: "远程文档同步", prompt: "检查远程文档。" },
    },
  };
  const providerSettingsState = {
    view: null as import("@zcode/services").ProviderSettingsView | null,
  };
  const state = {
    loading: false,
    grayConfig: {
      enabled: true,
      modelSelectionView: { revision: 1, providers: [] },
    },
    codingPlanSupport: {
      supported: false,
      reason: "connection_unselected",
    },
    newTaskBannerDismissed: false,
    initialize,
    refreshCodingPlanSupport,
    dismissNewTaskBanner,
    setPendingCreateDraft,
  };
  const settings = {
    providerFamilyDomain: undefined as "zai" | "bigmodel" | undefined,
    modelProviderFamilyModes: {} as Record<string, "oauth" | "apiKey">,
    modelProviderFamilySelectedKeys: {} as Record<string, string>,
  };
  // 真实 useServices 返回的是稳定的 Context 值；mock 若每次调用都新建对象，
  // 组件任何一次重渲染都会让 initialize 的依赖变化并重复拉取灰度配置。
  const services = {
    offPeakTaskService: {},
    codingPlanSubscriptionService: {},
  };
  return {
    initialize,
    loggerDebug,
    locale,
    messages,
    offPeakTemplateIds,
    providerSettingsState,
    openCodingPlanUpgrade,
    inventory,
    refreshCodingPlanSupport,
    services,
    setPendingCreateDraft,
    settings,
    state,
    toast,
    remoteTemplateCopy,
  };
});

vi.mock("@/components/ui/toast.js", () => ({ toast: h.toast }));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => h.services,
}));
vi.mock("@/hooks/useProviderSettingsView.js", () => ({
  useProviderSettingsView: () => ({
    state: h.providerSettingsState.view
      ? { status: "ready", view: h.providerSettingsState.view }
      : { status: "loading" },
    reload: vi.fn(),
  }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: h.settings }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: h.locale.current,
    intl: {
      formatMessage: ({ id }: { id: string }) => h.messages.current[id] ?? id,
    },
  }),
}));
vi.mock("@/settings/useAutomationTemplates.js", () => ({
  useAutomationTemplates: () => ({
    scheduled: [],
    rejectedScheduledTemplateIds: [],
    offPeak: h.offPeakTemplateIds.current.map((id) => {
      const customize = id === "customize" || id === "item-customize";
      const copy = customize
        ? null
        : h.remoteTemplateCopy[
            id as "standupGitSummary" | "ciFlakyReport" | "documentationSyncCheck"
          ];
      return {
        id,
        title: copy ? { en: copy.en.title, cn: copy.cn.title } : {},
        // Automations 仍展示 contents；首页必须显式读取 homepageDescription（descs 映射结果）。
        description: copy
          ? { en: `contents:${copy.en.description}`, cn: `contents:${copy.cn.description}` }
          : {},
        homepageDescription: copy ? { en: copy.en.description, cn: copy.cn.description } : {},
        prompt: copy ? { en: copy.en.prompt, cn: copy.cn.prompt } : { en: "", cn: "" },
        customize,
        icon: customize ? "customize" : id,
        ...(customize
          ? {}
          : {
              iconName:
                id === "standupGitSummary"
                  ? "git-commit-horizontal"
                  : id === "ciFlakyReport"
                    ? "activity"
                    : "file-text",
            }),
      };
    }),
  }),
}));
vi.mock("@/logger.js", () => ({
  logger: { debug: h.loggerDebug },
}));
vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  useOptionalCodingPlanUpgradeDialog: () => ({
    openCodingPlanUpgrade: h.openCodingPlanUpgrade,
    inventory: h.inventory,
  }),
}));
vi.mock("@/store/offPeakTaskStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/offPeakTaskStore.js")>();
  return {
    ...actual,
    useOffPeakTaskStore: (selector: (state: typeof h.state) => unknown) => selector(h.state),
  };
});

import { OffPeakNewTaskEntry } from "@/v4/OffPeakNewTaskEntry.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

beforeEach(() => {
  vi.clearAllMocks();
  h.inventory.status = "ready";
  h.state.loading = false;
  h.state.grayConfig = {
    enabled: true,
    modelSelectionView: { revision: 1, providers: [] },
  };
  h.state.codingPlanSupport = {
    supported: false,
    reason: "connection_unselected",
  };
  h.providerSettingsState.view = {
    revision: 1,
    addableProviders: [],
    providerOrder: [],
    providers: [],
  };
  h.messages.current = {};
  h.locale.current = "en-US";
  h.offPeakTemplateIds.current = ["standupGitSummary", "ciFlakyReport", "customize"];
  h.settings.providerFamilyDomain = undefined;
  h.settings.modelProviderFamilyModes = {};
  h.settings.modelProviderFamilySelectedKeys = {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OffPeakNewTaskEntry", () => {
  // Locale-behavior test: the zh-CN row guards against mixed-language banner, card and draft copy.
  it.each([
    {
      locale: "zh-CN",
      messages: zhCN,
      bannerText: "订阅用户新功能体验：创建“闲时任务”，我们将免费在算力富余时段为你完成指派任务。",
      bannerTipText: "本功能不消耗订阅用户套餐额度、本功能仅面向订阅用户开放",
      fullCopy:
        "订阅用户新功能体验：创建“闲时任务”，我们将免费在算力富余时段为你完成指派任务。本功能不消耗订阅用户套餐额度、本功能仅面向订阅用户开放",
      copySeparator: "",
    },
    {
      locale: "en-US",
      messages: enUS,
      bannerText:
        'New feature for subscribers: Create "Idle-time task" , We will complete your assigned task for free during periods of surplus computing power.',
      bannerTipText:
        "This feature does not consume your subscription plan quota and is available exclusively to subscribers.",
      fullCopy:
        'New feature for subscribers: Create "Idle-time task" , We will complete your assigned task for free during periods of surplus computing power. This feature does not consume your subscription plan quota and is available exclusively to subscribers.',
      copySeparator: " ",
    },
  ])(
    "$locale 首页展示、提示与模板预填使用同一种语言",
    ({ locale, messages, bannerText, bannerTipText, fullCopy, copySeparator }) => {
      h.messages.current = messages;
      h.locale.current = locale;
      h.providerSettingsState.view = {
        revision: 2,
        addableProviders: [],
        providerOrder: [],
        providers: [
          {
            providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            enabled: true,
            executable: true,
            effectiveConfig: {
              label: "Z.ai Coding Plan",
              access: {
                type: "zhipu-account",
                family: "zai",
                mode: "individual-coding-plan",
                entitled: true,
              },
              api: {
                type: "anthropic-messages",
                baseUrl: "https://example.com",
              },
              builtinModelIds: ["glm-5"],
            },
            issues: [],
            models: [],
          },
        ],
      };

      const copy = h.remoteTemplateCopy.standupGitSummary[locale === "zh-CN" ? "cn" : "en"];
      const { title, description, prompt } = copy;
      const onOpenAutomations = vi.fn();

      render(createElement(OffPeakNewTaskEntry, { onOpenAutomations }));
      const bannerCopy = screen.getByText(bannerText);
      fireEvent.focus(bannerCopy);
      const tipCopies = screen.getAllByText(bannerTipText);
      expect([bannerText, bannerTipText].join(copySeparator)).toBe(fullCopy);
      expect(tipCopies.length).toBeGreaterThan(0);
      expect(
        tipCopies.some(
          (copy) =>
            copy.parentElement?.classList.contains("max-w-none") &&
            copy.parentElement?.classList.contains("whitespace-nowrap"),
        ),
      ).toBe(true);
      const templateCard = screen.getByRole("button", {
        name: `${title} ${description}`,
      });
      fireEvent.click(templateCard);

      expect(h.toast).not.toHaveBeenCalled();
      expect(h.setPendingCreateDraft).toHaveBeenCalledWith({
        title,
        prompt,
        telemetrySource: {
          eventRegion: "app.session",
          templateId: "standupGitSummary",
        },
      });
      expect(onOpenAutomations).toHaveBeenCalledOnce();
    },
  );
});
