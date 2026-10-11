import { redactTelemetryText, redactTelemetryUrl } from "@zcode/shared";

/**
 * Final redaction pass for ARMS SDK auto-collected events before they leave the machine.
 *
 * SDK collectors choose which fields to collect, and their raw values may contain UI text (click),
 * local paths and stacks (exception), or full URLs (api/resource). `appARMSBootstrap.beforeReport`
 * is the only place that can rewrite a whole batch before reporting, so keep the rules here instead
 * of spreading them across collector configuration.
 *
 * Redaction changes only the reporting copy: network aggregation has already ingested its data
 * before this function, while local logs, error display, and crash archives continue to use original values.
 */

/** Exception message limit, matching the 2,000-character console-normalization limit in the dependency patch. */
const EXCEPTION_MESSAGE_MAX_LENGTH = 2_000;

/** Stack/snapshot limit: preserve recent error frames without sending the entire body to ARMS. */
const EXCEPTION_STACK_MAX_LENGTH = 4_000;

/**
 * Browser SDK click names look like `click on <type-><tag>: <first 20 characters of innerText>...`.
 * Keep only through the tag; text after `: ` may be a session title, filename, or message body in ZCode.
 */
const CLICK_NAME_PATTERN = /^(click on [a-z0-9-]+)(?::[\s\S]*)?$/iu;

/** Do not pass through names in an unexpected format; use a fixed bucket so events remain countable without carrying content. */
const CLICK_NAME_FALLBACK = "click";

function isClickEvent(event: Record<string, unknown>): boolean {
  return event.event_type === "click" || event.type === "click";
}

function isExceptionEvent(event: Record<string, unknown>): boolean {
  return event.event_type === "exception";
}

function isNativeDumpEvent(event: Record<string, unknown>): boolean {
  // Native dumps are parsed by the crash collector, and their binary_images/threads are structured
  // forensic data. filterAndEnrichNativeCrashEvents also relies on binary_images to identify product
  // binaries, so do not rewrite it here.
  return event.type === "crash" && event.source === "crashReporter";
}

function isResourceEvent(event: Record<string, unknown>): boolean {
  const eventType = String(event.event_type ?? "").toLowerCase();
  return eventType === "api" || eventType === "resource" || eventType.includes("resource");
}

function redactTextField(event: Record<string, unknown>, key: string, maxLength: number): void {
  const value = event[key];
  if (typeof value !== "string" || !value) {
    return;
  }
  event[key] = redactTelemetryText(value, { maxLength });
}

function redactUrlField(event: Record<string, unknown>, key: string): void {
  const value = event[key];
  if (typeof value !== "string" || !value) {
    return;
  }
  event[key] = redactTelemetryUrl(value);
}

function redactClickEvent(event: Record<string, unknown>): void {
  const name = event.name;
  event.name =
    typeof name === "string"
      ? (CLICK_NAME_PATTERN.exec(name)?.[1] ?? CLICK_NAME_FALLBACK)
      : CLICK_NAME_FALLBACK;
  // snapshots href/src values may be local file paths; id/className add no diagnostic value.
  delete event.snapshots;
}

function redactExceptionEvent(event: Record<string, unknown>): void {
  if (isNativeDumpEvent(event)) {
    return;
  }
  redactTextField(event, "message", EXCEPTION_MESSAGE_MAX_LENGTH);
  redactTextField(event, "stack", EXCEPTION_STACK_MAX_LENGTH);
  // Fix rationale: the jsError collector writes ErrorEvent.filename to file. In Windows installs,
  // script paths may be under C:\Users\<username>\AppData\...; apply the same rules as for stack
  // while preserving structured fields such as line/column.
  redactTextField(event, "file", EXCEPTION_MESSAGE_MAX_LENGTH);
  redactTextField(event, "snapshots", EXCEPTION_STACK_MAX_LENGTH);
}

function redactResourceEvent(event: Record<string, unknown>): void {
  redactUrlField(event, "url");
  redactUrlField(event, "name");
  redactTextField(event, "message", EXCEPTION_MESSAGE_MAX_LENGTH);
}

/**
 * Redact a batch of SDK auto-collected events in place and return it for chaining in `beforeReport`.
 *
 * Handle only the three auto-collected event types click / exception / api-resource. Custom events
 * (`perf_*`, etc.) are redacted where they are constructed; do not rewrite them a second time here,
 * which could make fields unreadable after two rule sets are applied.
 */
export function redactArmsEventBatch(
  events: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }
    if (isClickEvent(event)) {
      redactClickEvent(event);
      continue;
    }
    if (isExceptionEvent(event)) {
      redactExceptionEvent(event);
      continue;
    }
    if (isResourceEvent(event)) {
      redactResourceEvent(event);
    }
  }
  return events;
}
