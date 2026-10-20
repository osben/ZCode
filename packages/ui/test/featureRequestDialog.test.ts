import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { IFeedbackService } from "@zcode/services";
import {
  FeatureRequestDialog,
  buildFeatureRequestDescription,
} from "@/feedback/FeatureRequestDialog.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";

const capturedFeatureRequestStore = vi.hoisted(() => ({
  open: true,
  close: vi.fn(),
  openTickets: vi.fn(),
}));

vi.mock("@/feedback/feedbackStore.js", () => ({
  useFeedbackStore: (
    selector: (state: {
      featureRequestOpen: boolean;
      close: () => void;
      openTickets: (ticketId?: string) => void;
    }) => unknown,
  ) =>
    selector({
      featureRequestOpen: capturedFeatureRequestStore.open,
      close: capturedFeatureRequestStore.close,
      openTickets: capturedFeatureRequestStore.openTickets,
    }),
}));

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? createElement("div", null, children) : null,
  DialogContent: ({ children, ...props }: { children: ReactNode; className?: string }) =>
    createElement("div", props, children),
  DialogHeader: ({ children, ...props }: { children: ReactNode; className?: string }) =>
    createElement("div", props, children),
  DialogTitle: ({ children, ...props }: { children: ReactNode; className?: string }) =>
    createElement("h2", props, children),
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: vi.fn(),
}));

function createFeedbackService(): IFeedbackService {
  return {
    getDeviceSnapshot: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    comment: vi.fn(),
    uploadAttachmentData: vi.fn(),
    uploadAttachmentWithProgress: vi.fn(),
    prepareCompactLogArchive: vi.fn(),
    cleanupPreparedLogArchive: vi.fn(),
    onDynamicUploadProgress: vi.fn(),
    cancelCreate: vi.fn(),
    cancelUpload: vi.fn(),
    onDynamicUpdate: vi.fn(),
  } as unknown as IFeedbackService;
}

describe("FeatureRequestDialog", () => {
  it("renders a dedicated product request form instead of bug feedback controls", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(FeatureRequestDialog, {
          feedbackService: createFeedbackService(),
        }),
      ),
    );

    expect(html).toContain(expectedCopy("feedback.featureRequest.title"));
    expect(html).toContain(expectedCopy("feedback.featureRequest.descriptionLabel"));
    expect(html).toContain(expectedCopy("feedback.featureRequest.solutionLabel"));
    expect(html).toContain(expectedCopy("feedback.featureRequest.reset"));
    expect(html).toContain(expectedCopy("feedback.featureRequest.submit"));
    expect(html).not.toContain("截图");
    expect(html).not.toContain(expectedCopy("feedback.submit.simple.logsLabel"));
  });

  it("aligns the feature request shell with the feedback dialog style", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(FeatureRequestDialog, {
          feedbackService: createFeedbackService(),
        }),
      ),
    );

    expect(html).toContain("h-[min(38rem,calc(100vh-2rem))]");
    expect(html).toContain("w-[min(34rem,calc(100vw-2rem))]");
    expect(html).toContain("p-6 pb-0");
    expect(html).toContain("px-6 pb-4 pt-3");
    expect(html).toContain("px-6 pb-6 pt-2");
    expect(html).not.toContain("border-b border-border");
    expect(html).not.toContain("border-t border-border");
  });

  it("产品需求输入框使用固定尺寸并允许长连续文本换行", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(FeatureRequestDialog, {
          feedbackService: createFeedbackService(),
        }),
      ),
    );

    expect(html).toContain("field-sizing-fixed");
    expect(html).toContain("max-w-full");
    expect(html).toContain("min-w-0");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("break-words");
    expect(html).not.toContain("field-sizing-content");
  });

  it("builds a structured feature request description for feedback service", () => {
    const mockFormatMessage = (id: string) => {
      const map: Record<string, string> = {
        "feedback.featureRequest.descriptionLabel": "需求描述",
        "feedback.featureRequest.solutionLabel": "期望的解决方案",
        "feedback.submit.template.section.featureSource": "来源",
      };
      return map[id] ?? id;
    };
    expect(
      buildFeatureRequestDescription({
        description: "希望支持快捷指令",
        solution: "输入框旁增加快捷菜单",
        source: "Workspace Header 帮助菜单 / 给产品提需求",
        formatMessage: mockFormatMessage,
      }),
    ).toBe(
      [
        "## 需求描述",
        "希望支持快捷指令",
        "",
        "## 期望的解决方案",
        "输入框旁增加快捷菜单",
        "",
        "## 来源",
        "Workspace Header 帮助菜单 / 给产品提需求",
      ].join("\n"),
    );
  });
});
