import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { IFeedbackService } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";

function createFeedbackService(): IFeedbackService {
  return {
    getDeviceSnapshot: vi.fn(),
    create: vi.fn(),
    list: vi.fn(async () => ({ items: [], total: 0 })),
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

describe("FeedbackCenter", () => {
  it("does not mount a background ticket list watcher", async () => {
    const feedbackService = createFeedbackService();
    const { FeedbackCenter } = await import("@/feedback/FeedbackCenter.js");

    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TabStoreProvider,
          null,
          createElement(FeedbackCenter, {
            feedbackService,
            platform: { showTaskNotification: vi.fn() } as unknown as IPlatformService,
          }),
        ),
      ),
    );

    expect(feedbackService.list).not.toHaveBeenCalled();
  });
});
