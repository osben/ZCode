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
} from "@/feedback/feedbackSubmissionJob.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy, TEST_LOCALE } from "./helpers/uiCopy.js";

function createTicket(id: string): FeedbackTicketDetail {
  const summary: FeedbackTicketSummary = {
    id,
    title: "Background feedback upload",
    type: "bug",
    status: "submitted",
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
      { initialLocale: TEST_LOCALE },
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
      ticketInput: {
        title: "Background feedback upload",
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
          { initialLocale: TEST_LOCALE },
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
    const jobs = ["Concurrent feedback A", "Concurrent feedback B"].map((title) =>
      startFeedbackSubmissionJob({
        feedbackService,
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
        { initialLocale: TEST_LOCALE },
        createElement(FeedbackBackgroundUploadIndicator, {
          feedbackDialogOpen: false,
        }),
      ),
    );

    const titleCopy = expectedCopy("feedback.background.title");
    expect(html.match(new RegExp(titleCopy, "g"))).toHaveLength(2);
    for (const job of jobs) {
      dismissFeedbackSubmissionJob(job.id);
    }
  });

  it("hides progress details while folded", () => {
    const html = renderIndicator();

    expect(html).toContain(expectedCopy("feedback.background.title"));
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
    expect(html).toContain(expectedCopy("feedback.background.open"));
    expect(html).not.toContain(expectedCopy("feedback.background.expand"));
    expect(html).not.toContain(expectedCopy("feedback.submission.submittedDetail"));
  });

  it("renders full progress details without log skip actions when expanded", () => {
    const html = renderIndicator({ defaultExpanded: true });

    expect(html).toContain(expectedCopy("feedback.background.title"));
    expect(html).toContain(expectedCopy("feedback.submission.uploadingLogLabel"));
    expect(html).toContain("2.0 MB / 4.0 MB");
    expect(html).toContain(expectedCopy("feedback.background.openDetail"));
    expect(html).toContain(expectedCopy("feedback.background.open"));
    expect(html).not.toContain(expectedCopy("feedback.background.pauseLogs"));
    expect(html).not.toContain("Skip logs");
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
    expect(html).not.toContain("Skip logs");
  });
});
