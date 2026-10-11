/* eslint-disable max-lines -- The feedback background submission state machine keeps creation, screenshots, log uploads, cancellation, and fallback logic together; this change fixes a 413/fetch regression, so keep it in one file to limit behavioral scope. */
import type { CreateFeedbackTicketInput, FeedbackAttachmentKind } from "@zcode/shared";
import type { FeedbackUploadProgress, IFeedbackService } from "@zcode/services";
import type { FeedbackSubmitDraft } from "@/feedback/feedbackStore.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";

export interface FeedbackSubmissionAttachmentDraft {
  filename: string;
  contentType: string;
  dataBase64: string;
  size: number;
}

export interface FeedbackSubmissionProgressState {
  kind?: "working" | "uploading-log" | "paused-log" | "success";
  label: string;
  detail?: string;
  progress?: number;
  uploadedBytes?: number;
  totalBytes?: number;
  indeterminate?: boolean;
}

export interface FeedbackSubmissionCopy {
  connectingLabel: string;
  connectingDetail: string;
  cancelingCreateLabel: string;
  cancelingCreateDetail: string;
  canceledLabel: string;
  canceledDetail: string;
  uploadingScreenshotLabel: string;
  submittedLabel: string;
  submittedDetail: string;
  failedLabel: string;
  networkErrorDetail: string;
  postCreateNetworkErrorDetail: string;
  pausingLogLabel: string;
  pausingLogDetail: string;
  exportingLogLabel: string;
  exportingLogDetail: string;
  uploadingLogLabel: string;
  logUploadSuccessLabel: string;
  logUploadPausedLabel: string;
  logUploadPausedDetail: string;
  preparingUploadDetail: string;
}

export type FeedbackSubmissionJobStatus = "running" | "paused-log" | "success" | "error";

export interface FeedbackSubmissionJobState {
  id: string;
  status: FeedbackSubmissionJobStatus;
  progress: FeedbackSubmissionProgressState;
  ticketId?: string;
  error?: string;
}

export interface FeedbackSubmissionJob {
  readonly id: string;
  /** Snapshot of the user form at submission time, used to reopen the matching feedback by jobId. */
  readonly formDraft: FeedbackSubmitDraft;
  readonly done: Promise<{ ticketId: string }>;
  getState: () => FeedbackSubmissionJobState;
  subscribe: (listener: (state: FeedbackSubmissionJobState) => void) => { dispose: () => void };
  cancelSubmission: () => Promise<void>;
  cancelActiveUpload: () => Promise<void>;
  continueLogUpload: () => void;
}

export interface FeedbackSubmissionJobSnapshot extends FeedbackSubmissionJobState {
  job: FeedbackSubmissionJob;
}

export interface StartFeedbackSubmissionJobOptions {
  feedbackService: IFeedbackService;
  ticketInput: CreateFeedbackTicketInput;
  screenshots: FeedbackSubmissionAttachmentDraft[];
  includeLogs: boolean;
  formDraft: FeedbackSubmitDraft;
  copy?: FeedbackSubmissionCopy;
  onTicketCreated?: (ticketId: string) => void;
  onCompleted?: (ticketId: string) => void;
  onError?: (message: string) => void;
}

type LogUploadAction = "continue";

const DEFAULT_SUBMISSION_COPY: FeedbackSubmissionCopy = {
  connectingLabel: "正在连接反馈服务",
  connectingDetail: "创建成功后会继续上传截图和日志",
  cancelingCreateLabel: "正在取消提交",
  cancelingCreateDetail: "已收到取消请求，正在停止创建反馈。",
  canceledLabel: "反馈提交已取消",
  canceledDetail: "反馈提交已取消",
  uploadingScreenshotLabel: "正在上传截图",
  submittedLabel: "反馈已提交",
  submittedDetail: "我们会尽快处理。",
  failedLabel: "反馈提交失败",
  networkErrorDetail: "无法连接反馈服务，请检查网络、VPN 或代理设置后重试。",
  postCreateNetworkErrorDetail:
    "反馈已创建，但后续材料上传失败。请打开已创建的反馈补充材料，不要重复提交。",
  pausingLogLabel: "正在暂停日志上传",
  pausingLogDetail: "已收到取消请求，稍等一下。",
  exportingLogLabel: "正在导出完整日志",
  exportingLogDetail: "会根据本机日志大小耗时数秒",
  uploadingLogLabel: "正在上传完整日志",
  logUploadSuccessLabel: "日志上传成功",
  logUploadPausedLabel: "已暂停日志上传",
  logUploadPausedDetail: "日志是定位问题的必需材料，请继续上传。",
  preparingUploadDetail: "准备上传",
};

let nextJobSeq = 0;
const submissionJobs = new Map<string, FeedbackSubmissionJob>();
const globalListeners = new Set<(jobs: FeedbackSubmissionJobSnapshot[]) => void>();

function getSubmissionJobSnapshots(): FeedbackSubmissionJobSnapshot[] {
  return Array.from(submissionJobs.values()).map((job) => ({
    ...job.getState(),
    job,
  }));
}

function notifySubmissionJobSnapshots() {
  const snapshot = getSubmissionJobSnapshots();
  for (const listener of globalListeners) {
    listener(snapshot);
  }
}

export function getFeedbackSubmissionJobsSnapshot(): FeedbackSubmissionJobSnapshot[] {
  return getSubmissionJobSnapshots();
}

export function subscribeFeedbackSubmissionJobs(
  listener: (jobs: FeedbackSubmissionJobSnapshot[]) => void,
): { dispose: () => void } {
  globalListeners.add(listener);
  listener(getSubmissionJobSnapshots());
  return {
    dispose: () => {
      globalListeners.delete(listener);
    },
  };
}

export function dismissFeedbackSubmissionJob(jobId: string): void {
  const job = submissionJobs.get(jobId);
  // paused-log is waiting for the user to resume the upload. If the job is removed from the global queue at this point,
  // waitForLogUploadAction will hang forever, and log archive cleanup and the final status will never progress.
  if (job?.getState().status === "paused-log") {
    return;
  }
  if (submissionJobs.delete(jobId)) {
    notifySubmissionJobSnapshots();
  }
}

export function getFeedbackSubmissionJob(jobId: string): FeedbackSubmissionJob | null {
  return submissionJobs.get(jobId) ?? null;
}

export async function cancelFeedbackCreateSubmissionJob(
  job: FeedbackSubmissionJob,
  options: { onCancelError?: (message: string) => void } = {},
): Promise<boolean> {
  const state = job.getState();
  if (state.status !== "running" || state.ticketId) {
    return false;
  }
  try {
    await job.cancelSubmission();
    dismissFeedbackSubmissionJob(job.id);
    return true;
  } catch (error) {
    const message = getErrorMessage(error);
    // cancelCreate is a host command across RPC; if the host disconnects or the call fails, do not let its
    // fire-and-forget rejection become an unhandled global rejection, or hide the background job as if cancellation succeeded.
    logger.warn("[FeedbackSubmissionJob] 取消反馈创建命令失败", {
      jobId: job.id,
      error: message,
    });
    options.onCancelError?.(message);
    return false;
  }
}

export function startFeedbackSubmissionJob(
  options: StartFeedbackSubmissionJobOptions,
): FeedbackSubmissionJob {
  const copy = options.copy ?? DEFAULT_SUBMISSION_COPY;
  const jobSeq = nextJobSeq++;
  const now = Date.now();
  const jobId = `feedback-submit-${now}-${jobSeq}`;
  const createOperationId = `feedback-create-${now}-${jobSeq}`;
  // The backend issue description already includes diagnostic information and cannot restore the user's original input.
  // Each background job must copy its own form snapshot at startup so concurrent feedback submissions do not overwrite one another.
  const formDraft = createFeedbackSubmitDraftSnapshot(options.formDraft);
  const listeners = new Set<(state: FeedbackSubmissionJobState) => void>();
  let state: FeedbackSubmissionJobState = {
    id: jobId,
    status: "running",
    progress: {
      kind: "working",
      label: copy.connectingLabel,
      detail: copy.connectingDetail,
      indeterminate: true,
    },
  };
  let activeUploadProgressId: string | null = null;
  let resolveLogUploadAction: ((action: LogUploadAction) => void) | null = null;
  let cancelRequested = false;
  let cancelNotified = false;

  function setState(patch: Partial<FeedbackSubmissionJobState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener(state);
    }
    notifySubmissionJobSnapshots();
  }

  function setProgress(progress: FeedbackSubmissionProgressState) {
    setState({ progress });
  }

  function markCreateCanceled() {
    if (cancelNotified) return;
    cancelNotified = true;
    setState({
      status: "error",
      error: copy.canceledDetail,
      progress: {
        kind: "working",
        label: copy.canceledLabel,
        detail: copy.canceledDetail,
        indeterminate: false,
      },
    });
    options.onError?.(copy.canceledDetail);
  }

  async function run(): Promise<{ ticketId: string }> {
    try {
      logger.info("[FeedbackSubmissionJob] 开始后台提交反馈", { jobId });
      const ticket = await options.feedbackService.create(options.ticketInput, {
        operationId: createOperationId,
      });
      if (cancelRequested) {
        // Treat the user's click as cancellation; even if the backend later returns a ticket,
        // do not restore the old submission job or continue uploading attachments, so users do not think it is still running in the background after canceling.
        throw new FeedbackSubmissionCanceledError(copy.canceledDetail);
      }
      setState({ status: "running", ticketId: ticket.id, error: undefined });
      // After issue creation succeeds, the foreground dialog may close; the background job continues uploading screenshots and logs.
      options.onTicketCreated?.(ticket.id);

      const failedScreenshots: string[] = [];
      for (const [index, screenshot] of options.screenshots.entries()) {
        try {
          setProgress({
            kind: "working",
            label: copy.uploadingScreenshotLabel,
            detail: `${index + 1}/${options.screenshots.length} · ${formatBytes(screenshot.size)}`,
            indeterminate: true,
          });
          await options.feedbackService.uploadAttachmentData(ticket.id, "image", {
            dataBase64: screenshot.dataBase64,
            filename: screenshot.filename,
            contentType: screenshot.contentType,
          });
        } catch (screenshotError) {
          failedScreenshots.push(`${screenshot.filename}: ${getErrorMessage(screenshotError)}`);
        }
      }

      if (failedScreenshots.length > 0) {
        await options.feedbackService
          .comment(ticket.id, `系统提示：部分截图上传失败：${failedScreenshots.join("；")}`)
          .catch(() => undefined);
      }

      if (options.includeLogs) {
        await uploadLogsUntilComplete(options.feedbackService, ticket.id, copy, {
          setState,
          setProgress,
          getActiveProgressId: () => activeUploadProgressId,
          setActiveProgressId: (id) => {
            activeUploadProgressId = id;
          },
          waitForLogUploadAction: () =>
            new Promise<LogUploadAction>((resolve) => {
              resolveLogUploadAction = resolve;
            }),
        });
      }

      setState({
        status: "success",
        ticketId: ticket.id,
        progress: {
          kind: "success",
          label: copy.submittedLabel,
          detail: copy.submittedDetail,
          progress: 100,
        },
      });
      options.onCompleted?.(ticket.id);
      logger.info("[FeedbackSubmissionJob] 后台反馈提交完成", {
        jobId,
        ticketId: ticket.id,
      });
      return { ticketId: ticket.id };
    } catch (error) {
      if (
        !state.ticketId &&
        (cancelRequested || error instanceof FeedbackSubmissionCanceledError)
      ) {
        markCreateCanceled();
        logger.info("[FeedbackSubmissionJob] 反馈提交已取消", { jobId });
        throw new FeedbackSubmissionCanceledError(copy.canceledDetail);
      }
      const rawMessage = getErrorMessage(error);
      // RPC sends only Node fetch's top-level message to the UI, reducing underlying connection errors to “fetch failed.”
      // Give users actionable network troubleshooting guidance while keeping the original error in logs for diagnosis.
      const message = getFeedbackSubmissionErrorMessage(rawMessage, copy, {
        ticketCreated: Boolean(state.ticketId),
      });
      setState({
        status: "error",
        error: message,
        progress: {
          kind: "working",
          label: copy.failedLabel,
          detail: message,
          indeterminate: false,
        },
      });
      options.onError?.(message);
      logger.warn("[FeedbackSubmissionJob] 后台反馈提交失败", {
        jobId,
        error: rawMessage,
        displayError: message,
      });
      throw error;
    } finally {
      activeUploadProgressId = null;
      resolveLogUploadAction = null;
    }
  }

  const done = run();
  // Feedback log upload is a long-running Host service task and must not depend on the submission dialog staying mounted.
  // Keep the job running in the module closure while foreground components subscribe to its state; closing the dialog only removes a subscriber and does not cancel the background upload.
  const job: FeedbackSubmissionJob = {
    id: jobId,
    formDraft,
    done,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    cancelActiveUpload: async () => {
      const progressId = activeUploadProgressId;
      if (!progressId) return;
      setProgress({
        kind: "working",
        label: copy.pausingLogLabel,
        detail: copy.pausingLogDetail,
        indeterminate: true,
      });
      await options.feedbackService.cancelUpload(progressId);
    },
    cancelSubmission: async () => {
      if (state.status !== "running" && state.status !== "paused-log") return;
      cancelRequested = true;
      if (!state.ticketId) {
        const previousProgress = state.progress;
        setProgress({
          kind: "working",
          label: copy.cancelingCreateLabel,
          detail: copy.cancelingCreateDetail,
          indeterminate: true,
        });
        try {
          await options.feedbackService.cancelCreate(createOperationId);
        } catch (error) {
          if (!cancelNotified && !state.ticketId) {
            setProgress(previousProgress);
          }
          throw error;
        }
        markCreateCanceled();
        return;
      }
      await job.cancelActiveUpload();
    },
    continueLogUpload: () => {
      resolveLogUploadAction?.("continue");
      resolveLogUploadAction = null;
    },
  };
  submissionJobs.set(job.id, job);
  notifySubmissionJobSnapshots();
  return job;
}

function createFeedbackSubmitDraftSnapshot(draft: FeedbackSubmitDraft): FeedbackSubmitDraft {
  const screenshots = draft.screenshots
    ? Object.freeze(draft.screenshots.map((screenshot) => Object.freeze({ ...screenshot })))
    : undefined;
  // The job is read by both global cards and the dialog, so freeze a copied snapshot
  // to prevent either subscriber from changing the description/attachments and corrupting the background task's recovery content.
  return Object.freeze({
    ...draft,
    ...(screenshots ? { screenshots } : {}),
  });
}

function getFeedbackSubmissionErrorMessage(
  rawMessage: string,
  copy: FeedbackSubmissionCopy,
  options: { ticketCreated: boolean },
): string {
  if (
    /^(?:fetch failed|failed to fetch|network request failed)$/i.test(rawMessage) ||
    /^request timed out after \d+ms$/i.test(rawMessage) ||
    /connect timeout error/i.test(rawMessage)
  ) {
    return options.ticketCreated ? copy.postCreateNetworkErrorDetail : copy.networkErrorDetail;
  }
  return rawMessage;
}

class FeedbackSubmissionCanceledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackSubmissionCanceledError";
  }
}

async function uploadLogsUntilComplete(
  feedbackService: IFeedbackService,
  ticketId: string,
  copy: FeedbackSubmissionCopy,
  callbacks: {
    setState: (patch: Partial<FeedbackSubmissionJobState>) => void;
    setProgress: (progress: FeedbackSubmissionProgressState) => void;
    getActiveProgressId: () => string | null;
    setActiveProgressId: (id: string | null) => void;
    waitForLogUploadAction: () => Promise<LogUploadAction>;
  },
): Promise<void> {
  let archive: { path: string; size: number } | null = null;
  const progressId = `feedback-log-${ticketId}-${Date.now()}`;
  // Full logs must be compressed into a zip locally first; showing indeterminate progress makes users think the export finished instantly.
  const progressSubscription = feedbackService.onDynamicUploadProgress(progressId)((progress) => {
    callbacks.setProgress(formatUploadProgress(progress, copy));
  });
  try {
    callbacks.setActiveProgressId(progressId);
    callbacks.setProgress({
      kind: "working",
      label: copy.exportingLogLabel,
      detail: copy.exportingLogDetail,
      indeterminate: true,
    });
    archive = await feedbackService.prepareCompactLogArchive({ full: true, progressId });
    let shouldRetryLogUpload = true;
    while (shouldRetryLogUpload) {
      try {
        callbacks.setActiveProgressId(progressId);
        callbacks.setProgress({
          kind: "uploading-log",
          label: copy.uploadingLogLabel,
          detail: `0 / ${formatBytes(archive.size)}`,
          progress: 0,
          uploadedBytes: 0,
          totalBytes: archive.size,
        });
        await feedbackService.uploadAttachmentWithProgress(
          ticketId,
          "log" satisfies FeedbackAttachmentKind,
          {
            path: archive.path,
            contentType: "application/zip",
          },
          progressId,
        );
        shouldRetryLogUpload = false;
        callbacks.setProgress({
          kind: "success",
          label: copy.logUploadSuccessLabel,
          detail: copy.submittedDetail,
          progress: 100,
          uploadedBytes: archive.size,
          totalBytes: archive.size,
        });
      } catch (logUploadError) {
        if (!isUploadCanceledError(logUploadError)) {
          // Full logs are required for troubleshooting; an automatic upload failure such as 413/network loss must not fall back to compact logs and report success.
          // Otherwise, developers may think they received the complete diagnostic context when the client actually skipped key logs.
          throw logUploadError;
        }
        callbacks.setActiveProgressId(null);
        callbacks.setState({
          status: "paused-log",
          progress: {
            kind: "paused-log",
            label: copy.logUploadPausedLabel,
            detail: copy.logUploadPausedDetail,
            progress: 0,
            uploadedBytes: 0,
            totalBytes: archive.size,
          },
        });
        await callbacks.waitForLogUploadAction();
        callbacks.setState({ status: "running" });
        shouldRetryLogUpload = true;
      } finally {
        callbacks.setActiveProgressId(null);
      }
    }
  } catch (logError) {
    const message = getErrorMessage(logError);
    await feedbackService
      .comment(
        ticketId,
        `系统提示：完整日志自动上传失败，请必要时让用户手动导出日志。错误：${message}`,
      )
      .catch(() => undefined);
    // Log upload is part of submission; unless the user explicitly skips it, do not swallow errors and show “Submitted successfully.”
    // Otherwise users will think full logs were delivered, while developers actually received an issue missing them.
    throw logError;
  } finally {
    if (archive) {
      await feedbackService.cleanupPreparedLogArchive(archive.path).catch(() => undefined);
    }
    callbacks.setActiveProgressId(null);
    progressSubscription.dispose();
  }
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

export function formatUploadProgress(
  progress: FeedbackUploadProgress,
  copy: FeedbackSubmissionCopy = DEFAULT_SUBMISSION_COPY,
): FeedbackSubmissionProgressState {
  const totalBytes = Math.max(progress.totalBytes, 0);
  const uploadedBytes = Math.min(Math.max(progress.uploadedBytes, 0), totalBytes);
  const percent = totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 0;
  if (progress.phase === "preparing") {
    return {
      kind: "working",
      label: copy.exportingLogLabel,
      detail:
        totalBytes > 0
          ? `${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`
          : copy.exportingLogDetail,
      progress: percent,
      uploadedBytes,
      totalBytes,
    };
  }
  return {
    kind: progress.phase === "complete" ? "success" : "uploading-log",
    label: progress.phase === "complete" ? copy.logUploadSuccessLabel : copy.uploadingLogLabel,
    detail:
      totalBytes > 0
        ? `${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`
        : copy.preparingUploadDetail,
    progress: percent,
    uploadedBytes,
    totalBytes,
  };
}

function isUploadCanceledError(error: unknown): boolean {
  return error instanceof Error && error.name === "FeedbackUploadCanceledError";
}
