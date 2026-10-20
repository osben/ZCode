import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FeedbackTicketDetail, FeedbackTicketSummary } from "@zcode/shared";
import type { IFeedbackService } from "@zcode/services";
import {
  FeedbackBackgroundUploadIndicator,
  FeedbackBackgroundUploadIndicatorView,
  getFeedbackBackgroundOpenTarget,
  shouldOpenExistingFeedbackTicket,
  type FeedbackBackgroundUploadIndicatorViewProps,
} from "@/feedback/FeedbackBackgroundUploadIndicator.js";
import {
  dismissFeedbackSubmissionJob,
  startFeedbackSubmissionJob,
  type FeedbackSubmissionCopy,
} from "@/feedback/feedbackSubmissionJob.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";

function createSubmissionCopy(): FeedbackSubmissionCopy {
  return {
    connectingLabel: expectedCopy("feedback.submission.connectingLabel"),
    connectingDetail: expectedCopy("feedback.submission.connectingDetail"),
    cancelingCreateLabel: expectedCopy("feedback.submission.cancelingCreateLabel"),
    cancelingCreateDetail: expectedCopy("feedback.submission.cancelingCreateDetail"),
    canceledLabel: expectedCopy("feedback.submission.canceledLabel"),
    canceledDetail: expectedCopy("feedback.submission.canceledDetail"),
    uploadingScreenshotLabel: expectedCopy("feedback.submission.uploadingScreenshotLabel"),
    submittedLabel: expectedCopy("feedback.submission.submittedLabel"),
    submittedDetail: expectedCopy("feedback.submission.submittedDetail"),
    failedLabel: expectedCopy("feedback.submission.failedLabel"),
    networkErrorDetail: expectedCopy("feedback.submission.networkErrorDetail"),
    postCreateNetworkErrorDetail: expectedCopy("feedback.submission.postCreateNetworkErrorDetail"),
    pausingLogLabel: expectedCopy("feedback.submission.pausingLogLabel"),
    pausingLogDetail: expectedCopy("feedback.submission.pausingLogDetail"),
    exportingLogLabel: expectedCopy("feedback.submission.exportingLogLabel"),
    exportingLogDetail: expectedCopy("feedback.submission.exportingLogDetail"),
    uploadingLogLabel: expectedCopy("feedback.submission.uploadingLogLabel"),
    logUploadSuccessLabel: expectedCopy("feedback.submission.logUploadSuccessLabel"),
    logUploadPausedLabel: expectedCopy("feedback.submission.logUploadPausedLabel"),
    logUploadPausedDetail: expectedCopy("feedback.submission.logUploadPausedDetail"),
    preparingUploadDetail: expectedCopy("feedback.submission.preparingUploadDetail"),
  };
}

function createTicket(id: string): FeedbackTicketDetail {
  const summary: FeedbackTicketSummary = {
    id,
    title: "后台上传反馈",
    type: "bug",
    status: "已提交",
    created_at: "2026-06-04T10:00:00.000Z",
    updated_at: "2026-06-04T10:00:00.000Z",
  };
  return {
    ...summary,
    description: "desc",
    attachments: [],
    comments: [],
    events: [],
  };
}

function createFeedbackService(overrides: Partial<IFeedbackService> = {}): IFeedbackService {
  return {
    getDeviceSnapshot: vi.fn(),
    create: vi.fn(async () => createTicket("ticket-1")),
    list: vi.fn(),
    get: vi.fn(),
    comment: vi.fn(async () => ({
      id: 1,
      body: "ok",
      created_at: "2026-06-04T10:00:00.000Z",
    })),
    uploadAttachmentData: vi.fn(),
    uploadAttachmentWithProgress: vi.fn(),
    prepareCompactLogArchive: vi.fn(),
    cleanupPreparedLogArchive: vi.fn(),
    onDynamicUploadProgress: vi.fn(() => () => ({
      dispose: vi.fn(),
    })),
    cancelCreate: vi.fn(),
    cancelUpload: vi.fn(),
    revealLogArchive: vi.fn(),
    ...overrides,
  } as unknown as IFeedbackService;
}

function renderIndicator(props?: Partial<FeedbackBackgroundUploadIndicatorViewProps>) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(FeedbackBackgroundUploadIndicatorView, {
        status: "running",
        progress: {
          kind: "uploading-log",
          label: expectedCopy("feedback.submission.uploadingLogLabel"),
          detail: "2.0 MB / 4.0 MB",
          progress: 50,
        },
        onOpen: vi.fn(),
        onContinueUpload: vi.fn(),
        onDismiss: vi.fn(),
        defaultExpanded: false,
        ...props,
      }),
    ),
  );
}

describe("FeedbackBackgroundUploadIndicator", () => {
  it("opens an existing ticket for terminal background jobs", () => {
    expect(shouldOpenExistingFeedbackTicket("success", "ticket-1")).toBe(true);
    expect(shouldOpenExistingFeedbackTicket("error", "ticket-1")).toBe(true);
    expect(shouldOpenExistingFeedbackTicket("error", undefined)).toBe(false);
    expect(shouldOpenExistingFeedbackTicket("paused-log", "ticket-1")).toBe(false);
  });

  it("targets the exact unfinished submission card that was clicked", () => {
    expect(
      getFeedbackBackgroundOpenTarget({
        id: "feedback-job-a",
        status: "running",
        ticketId: "ticket-a",
      }),
    ).toEqual({ kind: "submission", jobId: "feedback-job-a" });
    expect(
      getFeedbackBackgroundOpenTarget({
        id: "feedback-job-b",
        status: "paused-log",
        ticketId: "ticket-b",
      }),
    ).toEqual({ kind: "submission", jobId: "feedback-job-b" });
    expect(
      getFeedbackBackgroundOpenTarget({
        id: "feedback-job-c",
        status: "error",
        ticketId: "ticket-c",
      }),
    ).toEqual({ kind: "ticket", ticketId: "ticket-c" });
  });

  it("stays hidden while the feedback submit dialog is still open", async () => {
    let releaseCreate: (() => void) | null = null;
    const feedbackService = createFeedbackService({
      create: vi.fn(
        () =>
          new Promise<FeedbackTicketDetail>((resolve) => {
            releaseCreate = () => resolve(createTicket("ticket-open"));
          }),
      ),
    });
    const job = startFeedbackSubmissionJob({
      feedbackService,
      copy: createSubmissionCopy(),
      ticketInput: {
        title: "后台上传反馈",
        description: "desc",
        type: "bug",
        source: "desktop-app",
      },
      screenshots: [],
      includeLogs: false,
      formDraft: {
        description: "desc",
        screenshots: [],
        includeLogs: false,
        type: "bug",
      },
    });

    expect(
      renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(FeedbackBackgroundUploadIndicator, {
            feedbackDialogOpen: true,
          }),
        ),
      ),
    ).toBe("");

    releaseCreate?.();
    await job.done.finally(() => dismissFeedbackSubmissionJob(job.id));
  });

  it("renders one card for every unfinished background submission", () => {
    const feedbackService = createFeedbackService({
      create: vi.fn(() => new Promise<FeedbackTicketDetail>(() => {})),
    });
    const jobs = ["并发反馈 A", "并发反馈 B"].map((title) =>
      startFeedbackSubmissionJob({
        feedbackService,
        copy: createSubmissionCopy(),
        ticketInput: {
          title,
          description: title,
          type: "bug",
          source: "desktop-app",
        },
        screenshots: [],
        includeLogs: false,
        formDraft: {
          description: title,
          screenshots: [],
          includeLogs: false,
          type: "bug",
        },
      }),
    );

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(FeedbackBackgroundUploadIndicator, {
          feedbackDialogOpen: false,
        }),
      ),
    );

    expect(html.match(new RegExp(expectedCopy("feedback.background.title"), "g"))).toHaveLength(2);
    expect(html).toContain("flex-col");
    for (const job of jobs) {
      dismissFeedbackSubmissionJob(job.id);
    }
  });

  it("renders a folded status capsule by default to avoid covering the workspace", () => {
    const html = renderIndicator();

    expect(html).toContain(expectedCopy("feedback.background.title"));
    expect(html).toContain("rounded-xl border border-popover-border bg-popover");
    expect(html).toContain("grid-cols-[auto_minmax(0,1fr)_auto]");
    expect(html).toContain("gap-0.5");
    expect(html).not.toContain("rounded-md border border-border bg-surface");
    expect(html).toContain(expectedCopy("feedback.submission.uploadingLogLabel"));
    expect(html).toContain("50%");
    expect(html).toContain(expectedCopy("feedback.background.open"));
    expect(html).not.toContain(expectedCopy("feedback.background.expand"));
    expect(html).not.toContain("2.0 MB / 4.0 MB");
    expect(html).not.toContain(expectedCopy("feedback.background.pauseLogs"));
  });

  it("keeps the success state folded with progress visible", () => {
    const html = renderIndicator({
      status: "success",
      progress: {
        kind: "success",
        label: expectedCopy("feedback.submission.submittedLabel"),
        detail: expectedCopy("feedback.submission.submittedDetail"),
        progress: 100,
      },
    });

    expect(html).toContain(expectedCopy("feedback.submission.submittedLabel"));
    expect(html).toContain("100%");
    expect(html).toContain("width:100%");
    expect(html).toContain(expectedCopy("feedback.background.open"));
    expect(html).not.toContain(expectedCopy("feedback.background.expand"));
    expect(html).not.toContain(expectedCopy("feedback.submission.submittedDetail"));
  });

  it("renders full progress details without log skip actions when expanded", () => {
    const html = renderIndicator({ defaultExpanded: true });

    expect(html).toContain(expectedCopy("feedback.background.title"));
    expect(html).toContain("rounded-xl border border-popover-border bg-popover");
    expect(html).toContain("grid-cols-[auto_minmax(0,1fr)_auto]");
    expect(html).toContain("gap-0.5");
    expect(html).not.toContain("rounded-md border border-border bg-surface");
    expect(html).toContain(expectedCopy("feedback.submission.uploadingLogLabel"));
    expect(html).toContain("2.0 MB / 4.0 MB");
    expect(html).toContain("width:50%");
    expect(html).toContain(expectedCopy("feedback.background.openDetail"));
    expect(html).toContain(expectedCopy("feedback.background.open"));
    expect(html).not.toContain(expectedCopy("feedback.background.pauseLogs"));
    expect(html).not.toContain("不传日志");
  });

  it("only allows continuing when log upload is paused", () => {
    const html = renderIndicator({
      defaultExpanded: true,
      status: "paused-log",
      progress: {
        kind: "paused-log",
        label: expectedCopy("feedback.submission.logUploadPausedLabel"),
        detail: expectedCopy("feedback.submission.logUploadPausedDetail"),
        progress: 0,
      },
    });

    expect(html).toContain(expectedCopy("feedback.submission.logUploadPausedLabel"));
    expect(html).toContain(expectedCopy("feedback.submit.continueUpload"));
    expect(html).not.toContain(expectedCopy("feedback.background.dismiss"));
    expect(html).not.toContain("不传日志");
  });
});
