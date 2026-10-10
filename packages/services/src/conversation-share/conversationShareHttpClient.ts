/* oxlint-disable eslint(max-lines) -- One method per endpoint plus a shared requestData for authentication, redaction, and error normalization; splitting this file would remove the single entry point for the HTTP contract. */
import {
  conversationShareArtifactDescriptorSchema,
  conversationShareArtifactUploadDataSchema,
  conversationShareCapabilitiesWireSchema,
  narrowConversationShareCapabilities,
  conversationShareConfirmDataSchema,
  conversationShareConfirmRequestSchema,
  conversationShareContinuationDataSchema,
  conversationShareContinuationRequestSchema,
  conversationShareErrorEnvelopeSchema,
  conversationShareKnownErrorCodeSchema,
  conversationSharePreparationDataSchema,
  conversationSharePreparationRequestSchema,
  conversationSharePreviewDataSchema,
  createConversationShareSuccessEnvelopeSchema,
  decodeConversationShareRows,
  isConversationShareSchemaVersionSupported,
  type ApiClient,
  type ApiRequestInit,
  type ConversationShareApiErrorCode,
  type ConversationShareArtifactDescriptor,
  type ConversationShareArtifactUpload,
  type ConversationShareCapabilities,
  type ConversationShareConfirmRequest,
  type ConversationShareContinuation,
  type ConversationShareContinuationRequest,
  type ConversationSharePreparation,
  type ConversationSharePreparationRequest,
  type ConversationSharePreview,
  type ConversationShareRecord,
} from "@zcode/shared";
import type { z } from "zod";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { REQUEST_ID_HEADER_NAME, withRequestIdHeader } from "../providers/api/requestIdHeaders.js";
import { verifyConversationShareIntegrity } from "./conversationShareIntegrity.js";

const log = createServiceLogger("conversation-share-http");

export type ConversationShareClientErrorKind =
  | "authentication_required"
  | "feature_disabled"
  | "invalid_contract"
  | "invalid_conversation"
  | "disclosure_required"
  | "unsafe_structure"
  | "artifact_not_allowed"
  | "limit_exceeded"
  | "upload_incomplete"
  | "not_found"
  | "expired"
  | "import_not_allowed"
  | "rate_limited"
  | "network"
  | "safety_check_pending"
  | "unsupported_schema_version"
  | "unknown";

export class ConversationShareClientError extends Error {
  readonly kind: ConversationShareClientErrorKind;
  readonly status?: number;
  readonly code?: ConversationShareApiErrorCode;
  /** Request ID from the server response, used to correlate with backend logs. */
  readonly requestId?: string;
  /** Reuse the existing RPC details field to send safe diagnostic information to the Renderer. */
  readonly details?: { requestId?: string };
  declare readonly retryAfterMs?: number;

  constructor(options: {
    kind: ConversationShareClientErrorKind;
    message: string;
    status?: number;
    code?: ConversationShareApiErrorCode;
    retryAfterMs?: number;
    requestId?: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConversationShareClientError";
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
    const requestId = options.requestId?.trim();
    if (requestId && /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)) {
      this.requestId = requestId;
      this.details = { requestId };
    }
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

const ERROR_KIND_BY_CODE: Record<ConversationShareApiErrorCode, ConversationShareClientErrorKind> =
  {
    3001: "invalid_contract",
    3002: "rate_limited",
    3200: "feature_disabled",
    3201: "authentication_required",
    3203: "invalid_contract",
    3204: "invalid_contract",
    3205: "invalid_conversation",
    3206: "disclosure_required",
    3207: "unsafe_structure",
    3208: "artifact_not_allowed",
    3209: "limit_exceeded",
    3210: "upload_incomplete",
    3211: "not_found",
    3212: "expired",
    3213: "authentication_required",
    3214: "import_not_allowed",
    3215: "safety_check_pending",
  };

const IMF_FIXDATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12]\d|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/u;
const RFC_850_DATE_PATTERN =
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (?:0[1-9]|[12]\d|3[01])-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/u;
const ASCTIME_DATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [1-9]|0[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/u;
const HTTP_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const HTTP_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function formatHttpTime(date: Date): string {
  return [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function parseHttpDate(value: string): number | undefined {
  if (IMF_FIXDATE_PATTERN.test(value)) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toUTCString() === value
      ? timestamp
      : undefined;
  }
  if (RFC_850_DATE_PATTERN.test(value)) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return undefined;
    const date = new Date(timestamp);
    const canonical = `${HTTP_WEEKDAYS[date.getUTCDay()]}, ${String(date.getUTCDate()).padStart(2, "0")}-${HTTP_MONTHS[date.getUTCMonth()]}-${String(date.getUTCFullYear()).slice(-2)} ${formatHttpTime(date)} GMT`;
    return canonical === value ? timestamp : undefined;
  }
  if (ASCTIME_DATE_PATTERN.test(value)) {
    const timestamp = Date.parse(`${value} GMT`);
    if (!Number.isFinite(timestamp)) return undefined;
    const date = new Date(timestamp);
    const canonical = `${date.toUTCString().slice(0, 3)} ${HTTP_MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ${formatHttpTime(date)} ${date.getUTCFullYear()}`;
    return canonical === value ? timestamp : undefined;
  }
  return undefined;
}

function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (/^\d+$/u.test(normalized)) {
    const delayMs = Number(normalized) * 1_000;
    return Number.isSafeInteger(delayMs) && delayMs > 0 ? delayMs : undefined;
  }
  // Date.parse accepts ISO/localized dates and normalizes nonexistent dates; validate strictly against HTTP-date syntax first.
  const retryAt = parseHttpDate(normalized);
  if (retryAt === undefined) return undefined;
  const delayMs = retryAt - now;
  return delayMs > 0 ? delayMs : undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
// During confirm, the server runs safety checks synchronously and a single request can stay pending far beyond 30s (observed 50s+ before abort).
// Relax the timeout only for this endpoint; raising it globally to 2min would make capability discovery hang for 2min when offline.
// This is separate from confirmUntilReady's polling timeout, which controls retries after the server has returned pending and cannot help the request itself.
const CONFIRM_TIMEOUT_MS = 120_000;
// uploadArtifact cannot use the 30s default timeout: confirm alone may take 50s+, and larger
// artifacts will time out on slow uploads. Uploads have no automatic retry, so a timeout fails the whole publish. Scale the timeout by size:
// 30s for connection/server overhead plus a minimum assumed upload rate of 128KB/s, with the global default as the floor (small files are not shortened).
const UPLOAD_TIMEOUT_BASE_MS = 30_000;
const UPLOAD_MIN_THROUGHPUT_BYTES_PER_SEC = 128 * 1024;

function computeUploadTimeoutMs(fileSizeBytes: number, floorMs: number): number {
  return Math.max(
    floorMs,
    UPLOAD_TIMEOUT_BASE_MS + Math.ceil(fileSizeBytes / UPLOAD_MIN_THROUGHPUT_BYTES_PER_SEC) * 1_000,
  );
}

function normalizeRequestId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^[A-Za-z0-9._:-]{1,128}$/u.test(trimmed) ? trimmed : undefined;
}

interface ConversationShareHttpClientOptions {
  apiClient: ApiClient;
  baseUrl: string;
  tokenProvider: () => Promise<string | null>;
  timeoutMs?: number;
  /** Timeout for a single confirm request; defaults to 2min. */
  confirmTimeoutMs?: number;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export class ConversationShareHttpClient {
  private readonly apiClient: ApiClient;
  private readonly baseUrl: string;
  private readonly tokenProvider: () => Promise<string | null>;
  private readonly timeoutMs: number;
  private readonly confirmTimeoutMs: number;

  constructor(options: ConversationShareHttpClientOptions) {
    this.apiClient = options.apiClient;
    this.baseUrl = options.baseUrl;
    this.tokenProvider = options.tokenProvider;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
  }

  async getCapabilities(): Promise<ConversationShareCapabilities> {
    const wire = await this.requestData(
      "/shares/capabilities",
      { method: "GET" },
      conversationShareCapabilitiesWireSchema,
      "required",
    );
    const { capabilities, unsupportedArtifactTypes, unsupportedAccessModes } =
      narrowConversationShareCapabilities(wire);
    if (unsupportedArtifactTypes.length > 0 || unsupportedAccessModes.length > 0) {
      // Leave a searchable record when the backend adds an artifact type/access mode: capability discovery no longer fails,
      // but we still need to know what support to add.
      log.info(undefined, "conversation share capabilities dropped unsupported values", {
        types: unsupportedArtifactTypes,
        accessModes: unsupportedAccessModes,
        supportedCount: capabilities.allowed_artifacts.length,
      });
    }
    return capabilities;
  }

  createPreparation(
    input: ConversationSharePreparationRequest,
  ): Promise<ConversationSharePreparation> {
    const body = conversationSharePreparationRequestSchema.parse(input);
    return this.requestData(
      "/shares/preparations",
      this.jsonRequest("POST", body),
      conversationSharePreparationDataSchema,
      "required",
    );
  }

  uploadArtifact(
    preparationId: string,
    descriptor: ConversationShareArtifactDescriptor,
    file: Blob,
  ): Promise<ConversationShareArtifactUpload> {
    const parsedDescriptor = conversationShareArtifactDescriptorSchema.parse(descriptor);
    // Security boundary: record only public IDs, types, and byte counts; never log descriptors, filenames, paths, content, or authorization headers.
    log.debug(undefined, "conversation share artifact upload prepared", {
      preparationId,
      artifactId: parsedDescriptor.artifact_id,
      artifactType: parsedDescriptor.artifact_type,
      fileSizeBytes: file.size,
    });
    const form = new FormData();
    form.append("descriptor", JSON.stringify(parsedDescriptor));
    form.append("file", file, parsedDescriptor.display_name);
    return this.requestData(
      `/shares/preparations/${encodeURIComponent(preparationId)}/artifacts`,
      { method: "POST", body: form },
      conversationShareArtifactUploadDataSchema,
      "required",
      computeUploadTimeoutMs(file.size, this.timeoutMs),
    );
  }

  confirm(
    preparationId: string,
    input: ConversationShareConfirmRequest,
  ): Promise<ConversationShareRecord> {
    const body = conversationShareConfirmRequestSchema.parse(input);
    return this.requestData(
      `/shares/preparations/${encodeURIComponent(preparationId)}/confirm`,
      this.jsonRequest("POST", body),
      conversationShareConfirmDataSchema,
      "required",
      this.confirmTimeoutMs,
    );
  }

  async getPreview(shareCode: string): Promise<ConversationSharePreview> {
    const wire = await this.requestData(
      `/shares/${encodeURIComponent(shareCode)}/preview`,
      { method: "GET" },
      conversationSharePreviewDataSchema,
      "optional",
    );
    this.assertSupportedSchemaVersion(wire.schema_version, "preview");
    const decoded = this.decodeRows(wire.rows, "preview");
    return { ...wire, rows: decoded.rows, unsupportedRowCount: decoded.unsupportedCount };
  }

  async getContinuation(
    shareCode: string,
    input: ConversationShareContinuationRequest,
  ): Promise<ConversationShareContinuation> {
    const body = conversationShareContinuationRequestSchema.parse(input);
    const wire = await this.requestData(
      `/shares/${encodeURIComponent(shareCode)}/continuation`,
      this.jsonRequest("POST", body),
      conversationShareContinuationDataSchema,
      // Continuations for public_importable shares are authorized by share code + client request ID;
      // the client must not block the request because ZCode has no local login session.
      "optional",
    );
    this.assertSupportedSchemaVersion(wire.schema_version, "continuation");
    // Validate integrity against the exact values returned by the server, not parsed output. Otherwise, adding an optional field on the publisher
    // would make every older client calculate a different hash (see verifyConversationShareIntegrity comments).
    if (
      !verifyConversationShareIntegrity({
        rawRows: wire.rows,
        rawArtifacts: wire.artifacts,
        integrity: wire.integrity,
      })
    ) {
      throw new ConversationShareClientError({
        kind: "invalid_contract",
        message: "Conversation share integrity check failed",
      });
    }
    const decoded = this.decodeRows(wire.rows, "continuation");
    return {
      ...wire,
      rows: decoded.rows,
      rawRows: wire.rows,
      unsupportedRowCount: decoded.unsupportedCount,
    };
  }

  /**
   * If the version is newer than this client knows, do not guess its semantics or classify it as invalid_contract. The user should see "Please upgrade ZCode,"
   * not "Invalid share format." Continue for versions at or below this client version; handle new kinds/enums through per-row fallback.
   */
  private assertSupportedSchemaVersion(version: number, endpoint: string): void {
    if (isConversationShareSchemaVersionSupported(version)) return;
    log.warn(undefined, "conversation share payload schema version is newer than this client", {
      endpoint,
      version,
    });
    throw new ConversationShareClientError({
      kind: "unsupported_schema_version",
      message: "Conversation share payload requires a newer ZCode version",
    });
  }

  private decodeRows(
    rows: readonly unknown[],
    endpoint: string,
  ): ReturnType<typeof decodeConversationShareRows> {
    const decoded = decodeConversationShareRows(rows);
    if (decoded.unsupportedCount > 0) {
      // Do not fail silently: an unrecognized row disappears from the display, so leave a searchable record of the row type that needs support.
      log.info(undefined, "conversation share dropped rows this client cannot render", {
        endpoint,
        kinds: decoded.unsupportedKinds,
        droppedCount: decoded.unsupportedCount,
        keptCount: decoded.rows.length,
      });
    }
    return decoded;
  }

  private jsonRequest(method: "POST", body: unknown): ApiRequestInit {
    return {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  private async requestData<T>(
    path: string,
    init: ApiRequestInit,
    dataSchema: z.ZodType<T>,
    auth: "required" | "optional",
    timeoutMsOverride?: number,
  ): Promise<T> {
    const token = (await this.tokenProvider())?.trim() || null;
    if (auth === "required" && !token) {
      throw new ConversationShareClientError({
        kind: "authentication_required",
        message: "Conversation share authentication required",
        status: 401,
      });
    }

    // ApiClient injects a fallback request ID; generate and retain the same value here so nonstandard ApiClients
    // (such as a remote Host facade or test double) can also correlate the request ID with the server response.
    const headers = withRequestIdHeader(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const url = joinUrl(this.baseUrl, path);
    let response: Response;
    try {
      response = await this.apiClient.request(url, {
        ...init,
        headers: Object.fromEntries(headers.entries()),
        timeoutMs: timeoutMsOverride ?? this.timeoutMs,
      });
    } catch (error) {
      if (error instanceof ConversationShareClientError) throw error;
      throw new ConversationShareClientError({
        kind: "network",
        message: error instanceof Error ? error.message : "Conversation share network error",
        cause: error,
      });
    }

    const text = await response.text();
    const responseRequestId = normalizeRequestId(response.headers.get(REQUEST_ID_HEADER_NAME));
    if (!response.ok) {
      if (response.status === 401 && !text.trim()) {
        throw new ConversationShareClientError({
          kind: "authentication_required",
          message: "Conversation share authentication required",
          status: 401,
          requestId: responseRequestId,
        });
      }
      let parsedError: ReturnType<typeof conversationShareErrorEnvelopeSchema.safeParse> | null =
        null;
      if (text.trim()) {
        try {
          parsedError = conversationShareErrorEnvelopeSchema.safeParse(parseJson(text));
        } catch (error) {
          // A gateway 502/504 may return an HTML error page. Classify non-JSON 5xx responses as network errors
          // so infrastructure failures are not misreported as response-contract errors; parse failures at other statuses remain invalid_contract.
          if (response.status >= 500) {
            log.warn(undefined, "conversation share API upstream unavailable", {
              path,
              method: init.method ?? "GET",
              status: response.status,
              requestId: responseRequestId,
            });
            throw new ConversationShareClientError({
              kind: "network",
              message: `Conversation share API upstream failed with HTTP ${response.status}`,
              status: response.status,
              ...(responseRequestId === undefined ? {} : { requestId: responseRequestId }),
              cause: error,
            });
          }
          log.warn(undefined, "conversation share API returned invalid JSON", {
            path,
            method: init.method ?? "GET",
            status: response.status,
            requestId: responseRequestId,
          });
          throw new ConversationShareClientError({
            kind: "invalid_contract",
            message: "Conversation share API returned invalid JSON",
            status: response.status,
            ...(responseRequestId === undefined ? {} : { requestId: responseRequestId }),
            cause: error,
          });
        }
      }
      if (parsedError?.success) {
        // An unknown business code must not fail parsing the entire envelope (which would discard the server msg and degrade to a context-free
        // "HTTP 4xx"). Map known codes as before; classify unknown codes as unknown while preserving msg and status.
        const knownCode = conversationShareKnownErrorCodeSchema.safeParse(parsedError.data.code);
        const code = knownCode.success ? knownCode.data : undefined;
        const kind = code === undefined ? "unknown" : ERROR_KIND_BY_CODE[code];
        const retryAfterMs =
          code === 3215 ? parseRetryAfterMs(response.headers.get("retry-after")) : undefined;
        log.warn(undefined, "conversation share API request rejected", {
          path,
          method: init.method ?? "GET",
          status: response.status,
          kind,
          code: parsedError.data.code,
          requestId: responseRequestId,
        });
        throw new ConversationShareClientError({
          kind,
          message: parsedError.data.msg,
          status: response.status,
          ...(code === undefined ? {} : { code }),
          requestId: responseRequestId,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
      }
      log.warn(undefined, "conversation share API request rejected", {
        path,
        method: init.method ?? "GET",
        status: response.status,
        requestId: responseRequestId,
      });
      // Fallback classification for an empty body or invalid error envelope: 5xx is an infrastructure failure (network),
      // not unknown/invalid_contract; keep 429 as rate_limited and classify other statuses as unknown.
      throw new ConversationShareClientError({
        kind:
          response.status >= 500 ? "network" : response.status === 429 ? "rate_limited" : "unknown",
        message: `Conversation share API failed with HTTP ${response.status}`,
        status: response.status,
        ...(responseRequestId === undefined ? {} : { requestId: responseRequestId }),
      });
    }

    try {
      const envelope = createConversationShareSuccessEnvelopeSchema(dataSchema).parse(
        parseJson(text),
      );
      return envelope.data;
    } catch (error) {
      if (error instanceof ConversationShareClientError) throw error;
      throw new ConversationShareClientError({
        kind: "invalid_contract",
        message: "Conversation share API response does not match the client contract",
        status: response.status,
        ...(responseRequestId === undefined ? {} : { requestId: responseRequestId }),
        cause: error,
      });
    }
  }
}
