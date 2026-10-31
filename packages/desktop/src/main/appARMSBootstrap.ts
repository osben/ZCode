import { wrapStartupReporterRequest } from "./startupTelemetryDelivery.js";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import armsRum from "@arms/rum-electron";
import { ZCODE_AGENT_LIFECYCLE_LOG_MARKER } from "@zcode/shared/process-diagnostic";
import {
  ZCODE_ARMS_RUM_ENDPOINT,
  ZCODE_TELEMETRY_REPORT_ENDPOINT,
  ZCODE_VERSION,
  mapZCodeEnvToArmsRumEnv,
} from "@zcode/shared";
import { ARMS_BROWSER_COLLECTORS, parseArmsViewName } from "../shared/armsRumShared.js";
import { redactArmsEventBatch } from "./armsEventRedaction.js";
import { ensureDesktopDeviceMidSync } from "./desktopDeviceMid.js";
import { ingestArmsApiEventsFromBatch } from "./desktopNetworkTelemetry.js";
import { desktopRuntimeEnv, runtimeApplicationName } from "./desktopRuntimeEnv.js";
import { summarizeLongTaskAttribution } from "./longTaskAttributionSummary.js";
import { logger } from "./logger.js";

function reportEndpointKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? `${url.origin}${url.pathname}`
      : undefined;
  } catch {
    return undefined;
  }
}

const reportEndpoints = new Set(
  [ZCODE_ARMS_RUM_ENDPOINT, ZCODE_TELEMETRY_REPORT_ENDPOINT]
    .map(reportEndpointKey)
    .filter((value): value is string => value !== undefined),
);

function shouldExcludeArmsEvent(event: Record<string, unknown>): boolean {
  if (event.event_type === "api" || (event.event_type === "resource" && event.type === "api")) {
    // Report requests being captured again by the API collector would pollute network stats; exclude by full origin/path before aggregation.
    return [event.url, event.name].some((value) => {
      const key = reportEndpointKey(value);
      return key !== undefined && reportEndpoints.has(key);
    });
  }
  if (
    event.event_type !== "exception" ||
    event.type !== "error" ||
    typeof event.message !== "string"
  ) {
    return false;
  }
  // Exclude only the telemetry transport layer's fixed error text; business request failures and telemetry programming errors must not be swallowed.
  if (
    /^Telemetry report failed(?:: (?:network|timeout)| with status [1-5]\d{2})$/u.test(
      event.message,
    )
  ) {
    return true;
  }
  if (event.source === "console.error") {
    // Node prints the SQLite experimental-feature notice via console.error, so the SDK collects the warning as a JS error.
    // Strip only Node's process id and the fixed notice line before matching exactly; logs that also contain database errors must be kept.
    const sqliteWarning = "SQLite is an experimental feature and might change at any time";
    const warningText = event.message
      .replace(/^\(node:\d+\)\s+/u, "")
      .replace(
        /\s+\(Use `[^`\r\n]+ --trace-warnings \.\.\.` to show where the warning was created\)$/u,
        "",
      );
    if (
      warningText === `ExperimentalWarning: ${sqliteWarning}` ||
      (event.name === "ExperimentalWarning" && event.message === sqliteWarning)
    ) {
      return true;
    }
  }
  // A misaligned tab lifecycle makes later IPC keep emitting the same console noise; filter only the reported copy —
  // local logs and genuine uncaught exceptions are kept, and the registration/scope issue is still fixed by the browser lifecycle.
  return (
    event.source === "console.error" &&
    (event.message.includes(ZCODE_AGENT_LIFECYCLE_LOG_MARKER) ||
      /^browser tab '(?:browser|iab-tab):[^'\r\n]+' is unavailable for renderer scope$/u.test(
        event.message,
      ))
  );
}

// LoAF long-task snapshots (the SDK-collected top-five attributions) are not written to SLS by
// default. Add them to event.properties here so attribution summaries (top duration/ratio/invokerType)
// can be queried. Do not report raw script names/URLs.
function enrichLongTaskAttribution(events: Array<Record<string, unknown>>): void {
  for (const event of events) {
    if (event.event_type !== "longTask") {
      continue;
    }
    const summary = summarizeLongTaskAttribution(event.snapshots, event.duration);
    if (!summary) {
      continue;
    }
    const existingProps =
      event.properties && typeof event.properties === "object"
        ? (event.properties as Record<string, unknown>)
        : {};
    event.properties = { ...existingProps, ...summary };
  }
}

function isCrashReporterEvent(event: Record<string, unknown>): boolean {
  return (
    event.event_type === "exception" && event.type === "crash" && event.source === "crashReporter"
  );
}

function normalizeExecutableName(value: unknown): string {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/\.exe$/i, "")
    : "";
}

function hasProductExecutable(
  event: Record<string, unknown>,
  applicationName: string,
  runtimeExecutableName?: string,
): boolean {
  // Fix rationale: app name does not match the actual binary name in every run mode; development
  // uses Electron, and Linux Preview uses zcode-preview. Match both exactly rather than using a
  // prefix that could include helper dumps.
  const expectedNames = new Set(
    [applicationName, runtimeExecutableName].map(normalizeExecutableName).filter(Boolean),
  );
  if (expectedNames.size === 0 || !Array.isArray(event.binary_images)) {
    return false;
  }
  return event.binary_images.some((image) => {
    if (!image || typeof image !== "object") {
      return false;
    }
    return expectedNames.has(normalizeExecutableName((image as Record<string, unknown>).name));
  });
}

type NativeDumpProcessRole = "main" | "renderer" | "utility" | "gpu" | "host" | "agent" | "unknown";

const nativeDumpProcessRoleAliases: Record<string, NativeDumpProcessRole> = {
  main: "main",
  browser: "main",
  main_process: "main",
  renderer: "renderer",
  utility: "utility",
  utility_host: "utility",
  gpu: "gpu",
  host: "host",
  agent: "agent",
};

function readNativeDumpProcessRole(event: Record<string, unknown>): NativeDumpProcessRole {
  const metadata =
    event.meta && typeof event.meta === "object"
      ? (event.meta as Record<string, unknown>)
      : undefined;
  // Fix rationale: generic process_role may come from event properties or middleware and does not
  // prove the event came from a Crashpad dump. Trust only meta.process_type extracted from structured
  // annotation RVA by the dependency patch, so an unstructured main-process marker cannot promote a
  // helper dump to app_native_process and pollute Native Crash / Crash-Free metrics.
  const processType = metadata?.process_type;
  if (typeof processType === "string") {
    return nativeDumpProcessRoleAliases[processType.trim().toLowerCase()] ?? "unknown";
  }
  return "unknown";
}

export function filterAndEnrichNativeCrashEvents(
  events: Array<Record<string, unknown>>,
  applicationName: string,
  runtimeExecutableName?: string,
): Array<Record<string, unknown>> {
  return events.filter((event) => {
    if (!isCrashReporterEvent(event)) {
      return true;
    }
    if (!hasProductExecutable(event, applicationName, runtimeExecutableName)) {
      return false;
    }
    const existingProperties =
      event.properties && typeof event.properties === "object"
        ? (event.properties as Record<string, unknown>)
        : {};
    const nativeDumpProcessRole = readNativeDumpProcessRole(event);
    // Cause: binary_images proves only that a dump came from a product binary; it cannot distinguish
    // the main process, renderer, utility, or host when Linux/Windows share one executable. Keep
    // unknown roles in the raw crashReporter event, but exclude them from app_native_process; otherwise
    // a helper crash loop would be counted as an app native crash and lower Crash-Free. Only dumps
    // explicitly marked as main enter product KPIs.
    event.properties = {
      ...existingProperties,
      telemetry_schema_version: "2",
      // Bugfix: SDK retries may pass the same event through beforeReport again; preserve the incident ID for deduplication.
      crash_id:
        typeof existingProperties.crash_id === "string"
          ? existingProperties.crash_id
          : randomUUID(),
      crash_scope:
        nativeDumpProcessRole === "main" ? "app_native_process" : "native_dump_unattributed",
      crash_cause: "native_crash",
      crash_source: "crash_reporter_dump",
      native_dump_process_role: nativeDumpProcessRole,
    };
    return true;
  });
}

// Bugfix: the product backend may be production while a source-launched Desktop is still a local
// development run. Mark the ARMS environment as local based on the run mode to keep development data out of prod.
const armsRumEnv = mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv);

// The SDK overwrites ARMS user.id with an internal random value (config.user.id is explicitly skipped
// during event merging and cannot be injected), while user.name is not filtered. Put device_mid in
// user.name so RUM logs can be correlated by device. device_mid reuses the persistent UUID in
// telemetry-state.json (shared with warehouse reporting/preload injection; ensureDesktopDeviceMidSync
// is idempotent and does not write repeatedly).
// Renderer events are forwarded through ArmsEventBridge to main, then repackaged and reported by the
// main-process client using its config. Initializing this once in main covers both main and renderer events.
const armsDeviceMid = ensureDesktopDeviceMidSync();

// Rationale: armsRum.init() returns a Promise. If it is not awaited, web-contents-created/renderer
// injection may happen after the first window's dom-ready event, producing no reports.
// Await armsInitPromise before app.whenReady() creates a BrowserWindow (see index.ts).
// The SDK's sendCustom indicates only that an event was queued; the original request does not check
// HTTP status. Wrap the transport through the public useReporter hook during init to preserve the
// SDK's filtering and serialization flow.
const useReporter = armsRum.client.useReporter.bind(armsRum.client);
armsRum.client.useReporter = (reporter) => {
  const request = reporter.request.bind(reporter);
  reporter.request = wrapStartupReporterRequest(request, {
    acknowledged: (eventIds, delivery) =>
      logger.info("[database-startup] telemetry delivery", { eventIds, delivery }),
  });
  useReporter(reporter);
};
export const armsInitPromise = armsRum
  .init({
    enable: ZCODE_ARMS_RUM_ENDPOINT !== "",
    version: ZCODE_VERSION,
    endpoint: ZCODE_ARMS_RUM_ENDPOINT,
    env: armsRumEnv,
    // The SDK injects Browser SDK through executeJavaScript at dom-ready; do not initialize it again in preload/renderer or events will be collected twice.
    autoInject: true,
    browserCollectors: { ...ARMS_BROWSER_COLLECTORS },
    app: {
      name: runtimeApplicationName,
      version: ZCODE_VERSION,
      env: armsRumEnv,
      type: "electron",
      framework: "react",
    },
    user: {
      name: armsDeviceMid,
    },
    // Session sampling must be 1; otherwise ARMS drops session-wide events such as PV/perf/webvitals by default (at 0.1 in development, about 90% of page-performance events are lost).
    sessionConfig: {
      sampleRate: 1,
    },
    // Electron desktop performs full-page loads from file:// / dev-server with no History routing; false enables the SDK's default full-page-load performance collection.
    spaMode: false,
    parseViewName: parseArmsViewName,
    collectors: {
      jsError: true,
      consoleError: true,
      crash: true,
      application: true,
      api: true,
      rpc: true,
    },
    // Main-process collectors run on the Electron side; renderer-side collectors are configured by browserCollectors + autoInject.
    // SDK tracing.sample ranges from 0–100 percent; 0.1 means 0.1% sampling and is rarely triggered.
    tracing: {
      enable: true,
      sample: armsRumEnv === "prod" ? 0.1 : 1,
    },
    // HTTP end-to-end timings come from ARMS API batches; ingest in production and local runs, and print batch summaries locally.
    beforeReport: (payload: { events?: Array<Record<string, unknown>> }) => {
      // Bugfix: the crash collector scans a shared dump directory, which may also contain dumps
      // from external descendant processes. Keep only native crashes containing the current
      // product executable; filtering examines existing batch metadata and adds no I/O.
      const events = filterAndEnrichNativeCrashEvents(
        (payload?.events ?? []).filter((event) => !shouldExcludeArmsEvent(event)),
        runtimeApplicationName,
        basename(process.execPath),
      );
      payload.events = events;
      if (events.length === 0) {
        // The SDK stops sending only when it receives a null return; merely clearing events still uploads an empty batch.
        return null;
      }
      ingestArmsApiEventsFromBatch(events);
      enrichLongTaskAttribution(events);
      // Apply privacy redaction after ingest and attribution summaries: network aggregation uses
      // its own interface-normalization rules, and longTask summaries need the original snapshots.
      // Redact only the final copy that leaves the machine.
      redactArmsEventBatch(events);
      if (desktopRuntimeEnv === "development") {
        const perfEvents = events.filter(
          (event) => String(event.type ?? "").toLowerCase() === "perf",
        );
        const summary = events
          .map((event) => {
            const eventType = String(event.event_type ?? "?");
            const subType = String(event.type ?? "");
            const name = String(event.name ?? "");
            if (subType === "perf") {
              return `${eventType}:perf`;
            }
            return `${eventType}:${name || subType || "?"}`;
          })
          .join(", ");
        logger.info(
          `[arms] beforeReport batch=${events.length} perf=${perfEvents.length}${summary ? ` [${summary}]` : ""}`,
        );
      }
      return payload;
    },
  })
  .then(() => {
    logger.info(`[arms] electron initialized env=${armsRumEnv} version=${ZCODE_VERSION}`);
  })
  .catch((error) => {
    logger.error("[arms] electron init failed:", error);
    throw error;
  });
