import { basename, join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import type {
  ApiClient,
  CreateFeedbackTicketInput,
  FeedbackDeviceInfo,
  FeedbackTicketDetail,
} from "@zcode/shared";
import {
  buildRuntimeZCodeApiUrl,
  ZCODE_BUILD_TIME,
  ZCODE_COMMIT,
  ZCODE_UPSTREAM_BASE_VERSION,
} from "@zcode/shared";
import { Emitter } from "@zcode/rpc";
import { arch, platform, release, type as osType } from "node:os";

import type { LocalCredentialService } from "../credential/credentialService.js";
import type { IOAuthService } from "../oauth/oauth.js";
import type { FeedbackUploadProgress, IFeedbackService } from "./feedback.js";
import {
  FeedbackHttpClient,
  FeedbackUploadCanceledError,
  isFeedbackAccessTokenInvalidError,
} from "./feedbackHttpClient.js";
import { cleanupLogArchive, prepareCompactLogArchive } from "./compactLogArchive.js";
import { getFeedbackAttachmentDir } from "../paths.js";

const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const FEEDBACK_ACCESS_TOKEN_KEY = "zcodefeedbackaccesstoken";

export interface CreateFeedbackServiceOptions {
  credentialService: Pick<LocalCredentialService, "load" | "saveIfAbsent" | "deleteIfEquals">;
  oauthService: IOAuthService;
  apiClient: ApiClient;
  apiBaseUrl?: string;
  createFullLogArchive?: (
    sourceDir: string,
    options?: {
      onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
    },
  ) => Promise<{ path: string; size: number }>;
  revealPath?: (path: string) => Promise<void>;
}

interface FeedbackRequestAuth {
  headers: Record<string, string>;
  /** Access token used for anonymous requests; logged-in requests do not have one. */
  accessToken?: string;
}

function userRequestAuth(jwtToken: string): FeedbackRequestAuth {
  return { headers: { Authorization: `Bearer ${jwtToken}` } };
}

function anonymousRequestAuth(accessToken: string): FeedbackRequestAuth {
  return { headers: { "X-Feedback-AccessToken": accessToken }, accessToken };
}

function resolveApiBaseUrl(explicit?: string): string {
  return (
    explicit?.trim() ||
    process.env.ZCODE_FEEDBACK_API_BASE?.trim() ||
    buildRuntimeZCodeApiUrl(process.env, "/api/v1")
  );
}

function buildDeviceSnapshot(): FeedbackDeviceInfo {
  return {
    appVersion: ZCODE_UPSTREAM_BASE_VERSION,
    buildCommitId: ZCODE_COMMIT,
    buildTime: ZCODE_BUILD_TIME,
    nodeVersion: process.version,
    osType: osType(),
    osPlatform: platform(),
    osRelease: release(),
    // On macOS, node:os.version() returns the full Darwin kernel string, which can exceed the backend os_version VARCHAR(64) and fail the write.
    osVersion: release(),
    osArch: arch(),
  };
}

export function createFeedbackService(options: CreateFeedbackServiceOptions): IFeedbackService {
  const httpClient = new FeedbackHttpClient({
    baseUrl: resolveApiBaseUrl(options.apiBaseUrl),
    apiClient: options.apiClient,
  });
  const uploadProgressEmitters = new Map<string, Emitter<FeedbackUploadProgress>>();
  const activeUploadControllers = new Map<string, AbortController>();
  const activeCreateControllers = new Map<string, AbortController>();

  async function loadCredential(key: string): Promise<string | undefined> {
    return (await options.credentialService.load(key))?.trim() || undefined;
  }

  // Logged-in requests carry only the JWT, anonymous requests only the access token. When neither exists the caller must not send a request:
  // the server would otherwise treat a credential-less request as a legacy identity via the X-Device-Mid common parameter.
  async function loadRequestAuth(): Promise<FeedbackRequestAuth | undefined> {
    const jwtToken = await loadCredential(ZCODE_JWT_TOKEN_KEY);
    if (jwtToken) {
      return userRequestAuth(jwtToken);
    }
    const accessToken = await loadCredential(FEEDBACK_ACCESS_TOKEN_KEY);
    return accessToken ? anonymousRequestAuth(accessToken) : undefined;
  }

  async function requireRequestAuth(): Promise<FeedbackRequestAuth> {
    const auth = await loadRequestAuth();
    if (!auth) {
      throw new Error("Missing feedback credential");
    }
    return auth;
  }

  // Requested only on anonymous submission. Issuing belongs to this creation and shares its timeout and cancellation; it is not merged into a process-wide shared request:
  // a shared request once left cancellation of a hung issuance waiting forever, and later submissions reused the same hung request.
  // Concurrent requests from the same process or several Host processes converge on one access token via a "write only if absent" under the credential file lock.
  async function ensureAccessToken(signal: AbortSignal): Promise<string> {
    const stored = await loadCredential(FEEDBACK_ACCESS_TOKEN_KEY);
    if (stored) return stored;
    const issued = await httpClient.issueAccessToken(signal);
    return options.credentialService.saveIfAbsent(FEEDBACK_ACCESS_TOKEN_KEY, issued);
  }

  // Discard only when the server explicitly rules the access token invalid; network errors must not discard it, or the anonymous identity would be lost for no reason.
  async function discardRejectedAccessToken(
    auth: FeedbackRequestAuth,
    error: unknown,
  ): Promise<void> {
    if (auth.accessToken && isFeedbackAccessTokenInvalidError(error)) {
      await options.credentialService.deleteIfEquals(FEEDBACK_ACCESS_TOKEN_KEY, auth.accessToken);
    }
  }

  async function sendWithAuth<T>(
    auth: FeedbackRequestAuth,
    send: (authHeaders: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    try {
      return await send(auth.headers);
    } catch (error) {
      await discardRejectedAccessToken(auth, error);
      throw error;
    }
  }

  async function createTicket(
    input: CreateFeedbackTicketInput,
    signal: AbortSignal,
  ): Promise<FeedbackTicketDetail> {
    const jwtToken = await loadCredential(ZCODE_JWT_TOKEN_KEY);
    if (jwtToken) {
      return httpClient.create(input, userRequestAuth(jwtToken).headers, { signal });
    }
    const auth = anonymousRequestAuth(await ensureAccessToken(signal));
    try {
      return await httpClient.create(input, auth.headers, { signal });
    } catch (error) {
      if (!isFeedbackAccessTokenInvalidError(error)) {
        throw error;
      }
      // The server rejected the request at authentication and the ticket was not created; discard the stale value, request once more and retry without duplicating the ticket.
      await discardRejectedAccessToken(auth, error);
      return sendWithAuth(anonymousRequestAuth(await ensureAccessToken(signal)), (authHeaders) =>
        httpClient.create(input, authHeaders, { signal }),
      );
    }
  }

  function getUploadProgressEmitter(id: string): Emitter<FeedbackUploadProgress> {
    const current = uploadProgressEmitters.get(id);
    if (current) return current;
    const emitter = new Emitter<FeedbackUploadProgress>({
      onDidRemoveLastListener: () => {
        uploadProgressEmitters.delete(id);
        emitter.dispose();
      },
    });
    uploadProgressEmitters.set(id, emitter);
    return emitter;
  }

  return {
    create: async (input, createOptions) => {
      const device = input.device ?? buildDeviceSnapshot();
      const operationId = createOptions?.operationId?.trim();
      const controller = new AbortController();
      if (operationId) {
        // When the UI cancels ticket creation, closing the dialog is not enough; the Host must find the current HTTP request by operationId
        // and abort it, so "connecting to the feedback service" does not hang forever.
        activeCreateControllers.get(operationId)?.abort();
        activeCreateControllers.set(operationId, controller);
      }
      try {
        return await createTicket({ ...input, device }, controller.signal);
      } finally {
        if (operationId && activeCreateControllers.get(operationId) === controller) {
          activeCreateControllers.delete(operationId);
        }
      }
    },
    cancelCreate: async (operationId) => {
      const key = operationId.trim();
      if (!key) return;
      activeCreateControllers.get(key)?.abort();
    },
    list: async (query) => {
      const auth = await loadRequestAuth();
      if (!auth) {
        // Not logged in and never submitted anonymously: there is no identity to query, so do not request an access token just to list.
        return { items: [], total: 0 };
      }
      return sendWithAuth(auth, (authHeaders) => httpClient.list(query ?? {}, authHeaders));
    },
    get: async (id) =>
      sendWithAuth(await requireRequestAuth(), (authHeaders) => httpClient.get(id, authHeaders)),
    comment: async (id, body) =>
      sendWithAuth(await requireRequestAuth(), (authHeaders) =>
        httpClient.comment(id, body, authHeaders),
      ),
    uploadAttachment: async (id, kind, file) => {
      const auth = await requireRequestAuth();
      const filename = file.filename ?? basename(file.path);
      const contentType = file.contentType ?? (kind === "image" ? "image/png" : "application/zip");
      return sendWithAuth(auth, (authHeaders) =>
        httpClient.uploadFile(id, kind, file.path, filename, contentType, {
          authHeaders,
          messageId: file.messageId,
        }),
      );
    },
    uploadAttachmentWithProgress: async (id, kind, file, progressId) => {
      const auth = await requireRequestAuth();
      const filename = file.filename ?? basename(file.path);
      const contentType = file.contentType ?? (kind === "image" ? "image/png" : "application/zip");
      const emitter = getUploadProgressEmitter(progressId);
      emitter.fire({
        id: progressId,
        phase: "preparing",
        uploadedBytes: 0,
        totalBytes: 0,
      });
      const controller = new AbortController();
      activeUploadControllers.set(progressId, controller);
      return sendWithAuth(auth, (authHeaders) =>
        httpClient.uploadFile(id, kind, file.path, filename, contentType, {
          authHeaders,
          messageId: file.messageId,
          signal: controller.signal,
          onUploadProgress: (event) => {
            emitter.fire({
              id: progressId,
              phase: event.uploadedBytes >= event.totalBytes ? "complete" : "uploading",
              uploadedBytes: event.uploadedBytes,
              totalBytes: event.totalBytes,
            });
          },
        }),
      )
        .catch((error) => {
          if (error instanceof FeedbackUploadCanceledError) {
            emitter.fire({
              id: progressId,
              phase: "canceled",
              uploadedBytes: 0,
              totalBytes: 0,
            });
          }
          throw error;
        })
        .finally(() => {
          activeUploadControllers.delete(progressId);
        });
    },
    cancelUpload: async (progressId) => {
      activeUploadControllers.get(progressId)?.abort();
    },
    onDynamicUploadProgress: (id) => getUploadProgressEmitter(id).event,
    uploadAttachmentData: async (id, kind, file) => {
      const auth = await requireRequestAuth();
      const attachmentRootDir = getFeedbackAttachmentDir();
      await mkdir(attachmentRootDir, { recursive: true });
      const tempDir = await mkdtemp(join(attachmentRootDir, "attachment-"));
      // Attachment names come from the renderer and must not be used as local relative paths.
      const filename = basename(file.filename.replaceAll("\\", "/")) || "attachment";
      const tempPath = join(tempDir, "content");
      try {
        await writeFile(tempPath, Buffer.from(file.dataBase64, "base64"));
        return await sendWithAuth(auth, (authHeaders) =>
          httpClient.uploadFile(id, kind, tempPath, filename, file.contentType, {
            authHeaders,
            messageId: file.messageId,
          }),
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    attachLogsFromExport: async (id, attachOptions) => {
      const auth = await requireRequestAuth();
      const archive = await prepareCompactLogArchive({
        full: attachOptions?.full,
        createFullArchive: options.createFullLogArchive,
      });
      try {
        return await sendWithAuth(auth, (authHeaders) =>
          httpClient.uploadFile(
            id,
            "log",
            archive.path,
            basename(archive.path),
            "application/zip",
            {
              authHeaders,
            },
          ),
        );
      } finally {
        await cleanupLogArchive(archive.path);
      }
    },
    getDeviceSnapshot: async () => buildDeviceSnapshot(),
    prepareCompactLogArchive: async (archiveOptions) => {
      const progressId = archiveOptions?.progressId;
      const progressEmitter = progressId ? getUploadProgressEmitter(progressId) : null;
      return prepareCompactLogArchive({
        full: archiveOptions?.full,
        createFullArchive: options.createFullLogArchive,
        onProgress: progressEmitter
          ? (event) => {
              progressEmitter.fire({
                id: progressId!,
                phase: "preparing",
                uploadedBytes: event.processedBytes,
                totalBytes: event.totalBytes,
              });
            }
          : undefined,
      });
    },
    cleanupPreparedLogArchive: (path) => cleanupLogArchive(path),
    revealLogArchive: async (path) => {
      if (options.revealPath) {
        await options.revealPath(path);
        return;
      }
    },
  };
}
