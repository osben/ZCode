/* oxlint-disable eslint(max-lines) -- Telemetry state locking, deviceMid coordination, and reporting share the same state file; splitting them could cause lock semantics to drift. */
import {
  createUuid,
  ZCODE_VERSION,
  ZCODE_ENV,
  ZCODE_TELEMETRY_ENABLED,
  ZCODE_TELEMETRY_REPORT_ENDPOINT,
  buildZCodeSourceHeadersFromContext,
  rewriteZCodeEndpointUrl,
  sanitizeTelemetryEventDetail,
  type TelemetryEventPayload,
  type TelemetryRendererContext,
  type OAuthLoginAttribution,
} from "@zcode/shared";
import {
  ensureDeviceMid,
  ensureDeviceMidInLockedState,
  type EnsureDeviceMidOptions,
} from "../device/deviceMid.js";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { version } from "node:os";
import { dirname, join } from "node:path";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";

function sessionCreateEventId(userId: string, sessionId: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["zcode:session_create:v1", userId, sessionId]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const LOCK_RETRY_DELAY_MS = 10;
const LOCK_RETRY_COUNT = 200;
const LOCK_STALE_MS = 5 * 60 * 1000;
const DAILY_ACTIVE_IN_FLIGHT_TTL_MS = 5 * 60 * 1000;
const REPORT_REQUEST_TIMEOUT_MS = 5_000;
const REPORT_RETRY_DELAY_MS = 300;
const REPORT_RATE_LIMIT_RETRY_DELAY_MS = 1_000;
const REPORT_MAX_ATTEMPTS = 2;

interface TelemetryCoreDependencies {
  fetchImpl?: typeof fetch;
  loadUserId?: () => Promise<string>;
  loadAuthorization?: (userId: string) => Promise<string | null>;
  loadMarketingParams?: () => Promise<OAuthLoginAttribution | null>;
  randomUUID?: () => string;
  now?: () => number;
  appVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  releaseChannel?: string;
  osVersion?: string;
  homeDir?: string;
  resolveZCodeEndpointOrigin?: () => Promise<string> | string;
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
}

type TelemetryFailureCategory =
  | "network"
  | "timeout"
  | "http_408"
  | "http_429"
  | "http_5xx"
  | "http_4xx"
  | "http_other";

class TelemetryReportError extends Error {
  constructor(
    readonly category: TelemetryFailureCategory,
    readonly retryable: boolean,
    status?: number,
  ) {
    super(
      status === undefined
        ? `Telemetry report failed: ${category}`
        : `Telemetry report failed with status ${status}`,
    );
  }
}

interface TelemetryState {
  lastDailyActiveDate?: string;
  deviceMid?: string;
  dailyActiveInFlight?: {
    date: string;
    startedAt: number;
  };
}

interface TelemetryLockOwner {
  pid: number;
  createdAt: number;
}

function normalizeOsCategory(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

function toLocalDateKey(timestamp: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function resolveTelemetryStateFile(homeDir?: string): string {
  if (homeDir) {
    return join(homeDir, ".zcode", "v2", "telemetry-state.json");
  }
  return join(getAppConfigDir(), "telemetry-state.json");
}

function resolveTelemetryLockFile(homeDir?: string): string {
  if (homeDir) {
    return join(homeDir, ".zcode", "v2", "telemetry-state.lock");
  }
  return join(getAppConfigDir(), "telemetry-state.lock");
}

function isFreshDailyActiveInFlight(
  value: TelemetryState["dailyActiveInFlight"],
  date: string,
  timestamp: number,
): boolean {
  if (!value || value.date !== date) {
    return false;
  }

  return timestamp - value.startedAt < DAILY_ACTIVE_IN_FLIGHT_TTL_MS;
}

async function readTelemetryState(homeDir?: string): Promise<TelemetryState> {
  try {
    const raw = await readFile(resolveTelemetryStateFile(homeDir), "utf-8");
    const parsed = JSON.parse(raw) as TelemetryState;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

async function writeTelemetryState(state: TelemetryState, homeDir?: string): Promise<void> {
  const telemetryStateFile = resolveTelemetryStateFile(homeDir);
  await mkdir(dirname(telemetryStateFile), { recursive: true });
  await writeFile(telemetryStateFile, JSON.stringify(state, null, 2), "utf-8");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeStaleTelemetryLockIfNeeded(
  lockFile: string,
  timestamp: number,
): Promise<boolean> {
  try {
    const metadata = await stat(lockFile);
    if (timestamp - metadata.mtimeMs < LOCK_STALE_MS) {
      const owner = await readTelemetryLockOwner(lockFile);
      if (!owner || isProcessAlive(owner.pid)) {
        return false;
      }
    }

    await unlink(lockFile).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function readTelemetryLockOwner(lockFile: string): Promise<TelemetryLockOwner | null> {
  try {
    const raw = await readFile(lockFile, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TelemetryLockOwner>;
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.createdAt === "number" &&
      Number.isFinite(parsed.createdAt)
    ) {
      return {
        pid: parsed.pid,
        createdAt: parsed.createdAt,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code !== "ESRCH"
    );
  }
}

async function withTelemetryStateLock<T>(
  homeDir: string | undefined,
  run: (state: TelemetryState) => Promise<T>,
): Promise<T> {
  const lockFile = resolveTelemetryLockFile(homeDir);
  await mkdir(dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx");
      try {
        // Bugfix: legacy lock files were empty, so a lock left after a crash could not be identified as orphaned for five minutes.
        // New locks record the owner PID so later processes can safely reclaim a lock whose owner has exited but was just left behind.
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            createdAt: Date.now(),
          }),
          "utf-8",
        );
        const state = await readTelemetryState(homeDir);
        return await run(state);
      } finally {
        await handle.close();
        await unlink(lockFile).catch(() => {});
      }
    } catch (error) {
      const isLockConflict =
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST";
      if (!isLockConflict) {
        throw error;
      }

      // Bugfix: telemetry-state.lock may remain on disk after a crash/forced exit, causing every later startup to block until timeout.
      // Detect clearly stale orphan locks by mtime and reclaim them automatically so an old empty file in the user directory cannot block reporting indefinitely.
      const removedStaleLock = await removeStaleTelemetryLockIfNeeded(lockFile, Date.now());
      if (removedStaleLock) {
        continue;
      }

      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  throw new Error("Telemetry state lock timeout");
}

// Persistent device identity is owned only by device/deviceMid: it uses the same telemetry-state file and lock.
// Keep the old export name as a stable alias for reporting entry points and delegate internally to avoid a second write path.
export type { EnsureDeviceMidOptions as EnsureTelemetryDeviceMidOptions } from "../device/deviceMid.js";

export function ensureTelemetryDeviceMid(options: EnsureDeviceMidOptions = {}): Promise<string> {
  return ensureDeviceMid(options);
}

export function createTelemetryCore(dependencies: TelemetryCoreDependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const loadUserId = dependencies.loadUserId ?? (async () => "");
  const loadMarketingParams = dependencies.loadMarketingParams ?? (async () => null);
  const telemetryLogger = createServiceLogger("telemetry-core");
  const warn = dependencies.warn ?? ((message: string) => telemetryLogger.warn(undefined, message));
  let didWarnMarketingParamsLoadFailure = false;
  const randomUUID = dependencies.randomUUID ?? (() => createUuid());
  const now = dependencies.now ?? Date.now;
  const appVersion = dependencies.appVersion ?? ZCODE_VERSION;
  const platform = dependencies.platform ?? process.platform;
  const osVersion = dependencies.osVersion ?? version();
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? REPORT_REQUEST_TIMEOUT_MS;
  const retrySleep = dependencies.sleep ?? sleep;
  const pendingReports = new Set<Promise<void>>();
  const deviceMidOptions: EnsureDeviceMidOptions = {
    homeDir: dependencies.homeDir,
    randomUUID,
  };

  function classifyHttpFailure(status: number): TelemetryReportError {
    if (status === 408) {
      return new TelemetryReportError("http_408", true, status);
    }
    if (status === 429) {
      return new TelemetryReportError("http_429", true, status);
    }
    if (status >= 500 && status <= 599) {
      return new TelemetryReportError("http_5xx", true, status);
    }
    if (status >= 400 && status <= 499) {
      return new TelemetryReportError("http_4xx", false, status);
    }
    return new TelemetryReportError("http_other", false, status);
  }

  async function sendReportAttempt(
    endpoint: string,
    body: string,
    headers: Record<string, string>,
    userId: string,
  ): Promise<void> {
    let authorization: string | null = null;
    try {
      authorization = (await dependencies.loadAuthorization?.(userId)) ?? null;
    } catch {
      // Report anonymously when credentials cannot be read; do not print the raw exception or block the business event.
    }
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), requestTimeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
          ...(authorization ? { Authorization: authorization } : {}),
        },
        // Do not forward identity-bearing reports to a server redirect target.
        redirect: "error",
        body,
        signal: abortController.signal,
      });
    } catch {
      throw new TelemetryReportError(abortController.signal.aborted ? "timeout" : "network", true);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw classifyHttpFailure(response.status);
    }
  }

  async function sendReport(
    payload: TelemetryEventPayload,
    context: TelemetryRendererContext,
    eventId: string,
    userId: string,
    deviceMid: string,
  ): Promise<void> {
    // Stop processing the event here when the master switch is off or no reporting endpoint is configured.
    if (!ZCODE_TELEMETRY_ENABLED || !ZCODE_TELEMETRY_REPORT_ENDPOINT) {
      return;
    }
    let marketingParams: OAuthLoginAttribution | null = null;
    try {
      marketingParams = await loadMarketingParams();
    } catch {
      // Fix: marketing attribution is only additional telemetry context, so corrupted or temporarily unreadable credentials
      // must not block the original event. Warn only once per core to avoid flooding logs with high-volume telemetry.
      if (!didWarnMarketingParamsLoadFailure) {
        didWarnMarketingParamsLoadFailure = true;
        // Credential backend exceptions may contain local paths or stack traces; production logs retain only a fixed, redacted fallback event.
        warn("Telemetry marketing attribution load failed; continuing without attribution");
      }
    }
    const requestBody = JSON.stringify({
      event_id: eventId,
      client_timezone: context.clientTimezone,
      client_language: context.clientLanguage,
      element_name: payload.elementName,
      event_region: payload.eventRegion,
      event_type: payload.eventType,
      event_text: payload.eventText ?? "",
      // Fix: Host/Main or an older Renderer can bypass UI sanitization; at the final egress boundary, consistently forbid raw errors and secrets from login URLs.
      event_extra_detail: sanitizeTelemetryEventDetail(
        payload.elementName,
        payload.eventExtraDetail,
      ),
      user_id: userId,
      screen_resolution: context.screenResolution,
      app_version: appVersion,
      device_os_category: normalizeOsCategory(platform),
      device_os_version: osVersion,
      device_mid: deviceMid,
      mac_id: "",
      marketing_params: JSON.stringify(marketingParams ?? {}),
      ...(payload.talkId ? { talk_id: payload.talkId } : {}),
      ...(payload.messageId ? { message_id: payload.messageId } : {}),
    });

    const endpoint = String(
      rewriteZCodeEndpointUrl(
        ZCODE_TELEMETRY_REPORT_ENDPOINT,
        (await dependencies.resolveZCodeEndpointOrigin?.()) ?? ZCODE_TELEMETRY_REPORT_ENDPOINT,
      ),
    );

    const headers = buildZCodeSourceHeadersFromContext({
      appVersion,
      platform,
      arch: dependencies.arch ?? process.arch,
      osVersion,
      releaseChannel: dependencies.releaseChannel ?? ZCODE_ENV,
      clientLanguage: context.clientLanguage,
      clientTimezone: context.clientTimezone,
      deviceMid,
      endpointOrigin: new URL(endpoint).origin,
    });
    const startedAt = Date.now();
    let lastError: TelemetryReportError | null = null;
    let attempts = 0;
    for (let attempt = 1; attempt <= REPORT_MAX_ATTEMPTS; attempt += 1) {
      attempts = attempt;
      try {
        await sendReportAttempt(endpoint, requestBody, headers, userId);
        return;
      } catch (error) {
        lastError =
          error instanceof TelemetryReportError ? error : new TelemetryReportError("network", true);
        if (!lastError.retryable || attempt === REPORT_MAX_ATTEMPTS) {
          break;
        }

        // Fix: public /event/report used to drop events immediately on transient network failures. Record only redacted
        // attempt metadata and retry a bounded number of times; never write payloads, response bodies, or raw errors to production logs.
        telemetryLogger.debug(
          undefined,
          `retry event=${payload.elementName} eventId=${eventId} attempt=${attempt} category=${lastError.category}`,
        );
        await retrySleep(
          lastError.category === "http_429"
            ? REPORT_RATE_LIMIT_RETRY_DELAY_MS
            : REPORT_RETRY_DELAY_MS,
        );
      }
    }

    const finalError = lastError ?? new TelemetryReportError("network", true);
    warn(
      `Telemetry report failed; event=${payload.elementName} eventId=${eventId} attempts=${attempts} category=${finalError.category} elapsedMs=${Date.now() - startedAt}`,
    );
    throw finalError;
  }

  function trackReport(report: Promise<void>): Promise<void> {
    const tracked = report.finally(() => pendingReports.delete(tracked));
    pendingReports.add(tracked);
    return tracked;
  }

  async function flushPendingReports({ timeoutMs }: { timeoutMs: number }): Promise<void> {
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    });

    try {
      // Fix: if shutdown drain snapshots the Set only once, it can miss IPC reports that reach Main while the barrier is waiting.
      // Reread the set after each batch settles until it is empty or the shared deadline is reached.
      while (!timedOut && pendingReports.size > 0) {
        await Promise.race([Promise.allSettled(pendingReports), deadline]);
      }
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }

    if (pendingReports.size > 0) {
      warn(`Telemetry flush timed out; pending=${pendingReports.size}`);
    }
  }

  return {
    reportEvent(input: {
      context: TelemetryRendererContext;
      elementName: string;
      eventRegion: string;
      eventType: string;
      eventText?: string;
      eventExtraDetail: Record<string, string>;
      userId?: string;
      talkId?: string;
      messageId?: string;
    }): Promise<void> {
      return trackReport(
        (async () => {
          const userId = input.userId ?? (await loadUserId());
          // Duplicate callbacks/reports of the same Session across hosts must retain event identity; do not generate a random ID each time.
          // UUIDv8 represents an application-defined SHA-256 mapping, so changing source/device does not create a new creation event.
          const eventId =
            input.elementName === "session_create" && input.talkId
              ? sessionCreateEventId(userId, input.talkId)
              : randomUUID();
          const deviceMid = await ensureTelemetryDeviceMid(deviceMidOptions);

          await sendReport(
            {
              elementName: input.elementName,
              eventRegion: input.eventRegion,
              eventType: input.eventType,
              eventText: input.eventText,
              eventExtraDetail: input.eventExtraDetail,
              userId,
              talkId: input.talkId,
              messageId: input.messageId,
            },
            input.context,
            eventId,
            userId,
            deviceMid,
          );
        })(),
      );
    },

    reportAppLaunch(context: TelemetryRendererContext): Promise<void> {
      return trackReport(
        (async () => {
          const eventId = randomUUID();
          const userId = await loadUserId();
          const deviceMid = await ensureTelemetryDeviceMid(deviceMidOptions);

          await sendReport(
            {
              elementName: "app_launch",
              eventRegion: "app",
              eventType: "view",
              eventExtraDetail: {},
              userId,
            },
            context,
            eventId,
            userId,
            deviceMid,
          );
        })(),
      );
    },

    reportAppDailyActive(context: TelemetryRendererContext): Promise<void> {
      return trackReport(
        (async () => {
          const timestamp = now();
          const today = toLocalDateKey(timestamp, context.clientTimezone);
          const userId = await loadUserId();
          const pendingReport = await withTelemetryStateLock(
            dependencies.homeDir,
            async (state) => {
              if (state.lastDailyActiveDate === today) {
                return null;
              }

              if (isFreshDailyActiveInFlight(state.dailyActiveInFlight, today, timestamp)) {
                return null;
              }

              const eventId = randomUUID();
              const deviceMid = await ensureDeviceMidInLockedState(state, deviceMidOptions);
              // Bugfix: reportAppDailyActive used to perform the network request while holding the lock.
              // If app_launch / app_daily_active / reportEvent ran concurrently during startup, later calls stayed blocked outside the lock,
              // reliably ending in "Telemetry state lock timeout". Write an in-flight marker under a short lock,
              // send the request outside the lock, then commit completion under another short lock to preserve cross-instance deduplication without blocking the entire telemetry channel.
              state.dailyActiveInFlight = {
                date: today,
                startedAt: timestamp,
              };
              await writeTelemetryState(state, dependencies.homeDir);
              return { eventId, deviceMid };
            },
          );

          if (!pendingReport) {
            return;
          }

          try {
            await sendReport(
              {
                elementName: "app_daily_active",
                eventRegion: "app",
                eventType: "view",
                eventExtraDetail: {},
                userId,
              },
              context,
              pendingReport.eventId,
              userId,
              pendingReport.deviceMid,
            );
          } catch (error) {
            await withTelemetryStateLock(dependencies.homeDir, async (state) => {
              if (state.dailyActiveInFlight?.date === today) {
                delete state.dailyActiveInFlight;
                await writeTelemetryState(state, dependencies.homeDir);
              }
            });
            throw error;
          }

          await withTelemetryStateLock(dependencies.homeDir, async (state) => {
            state.lastDailyActiveDate = today;
            if (state.dailyActiveInFlight?.date === today) {
              delete state.dailyActiveInFlight;
            }
            await writeTelemetryState(state, dependencies.homeDir);
          });
        })(),
      );
    },

    flushPendingReports,
  };
}
