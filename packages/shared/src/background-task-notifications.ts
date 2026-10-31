import type { ZCodeMessageWithParts } from "./zcode-protocol-legacy-types.js";
import { textFromZCodeMessageParts } from "./zcode-protocol-legacy-types.js";
import type { ZCodeStreamEvent } from "./zcode-task-types-core.js";
import { subagentResultMetaSchema } from "./zcode-protocol-v4/workflow-row-meta.js";

export interface ZCodeBackgroundTaskNotificationInfo {
  error?: string;
  outputFile?: string;
  result?: string;
  status?: string;
  summary?: string;
  taskId?: string;
}

const TASK_NOTIFICATION_OPEN = "<task-notification>";
const TASK_NOTIFICATION_CLOSE = "</task-notification>";

export interface ZCodeParsedBackgroundTaskNotification {
  notification: ZCodeBackgroundTaskNotificationInfo;
  toolUseId: string;
}

/**
 * One message may merge several notifications; parse each `<task-notification>` block and read only tags inside that block.
 * Root cause: taking the first match over the whole text read across blocks — a failed task without `<result>` picked up the next
 * notification's `<result>` as its failure reason, and later tasks never got a terminal state.
 * `originMeta` is the originMeta of the turn the notification sits in (unvalidated). The background Agent's terminal state and
 * raw failure text come from its `subagentResult`; the notification body carries no <error>. It describes a single
 * notification only, so it is used only when there is exactly one block.
 * Legacy sessions and merged turns lack it; they read in-block <status> / <error>. The summary text is not parsed: product data must not depend on model-visible wording.
 */
export function parseZCodeBackgroundTaskNotifications(
  text: string | undefined,
  originMeta?: unknown,
): ZCodeParsedBackgroundTaskNotification[] {
  const trimmed = text?.trim();
  if (!trimmed?.startsWith(TASK_NOTIFICATION_OPEN)) {
    return [];
  }
  const blocks = trimmed
    .split(TASK_NOTIFICATION_OPEN)
    .slice(1)
    .map((block) => block.split(TASK_NOTIFICATION_CLOSE)[0]!);
  const subagentResult =
    blocks.length === 1
      ? subagentResultMetaSchema.safeParse(asPlainRecord(originMeta).subagentResult).data
      : undefined;
  return blocks.flatMap((block) => {
    const toolUseId = readTaskNotificationTag(block, "tool-use-id");
    if (!toolUseId) {
      return [];
    }
    return [
      {
        toolUseId,
        notification: {
          error: subagentResult ? subagentResult.error : readTaskNotificationTag(block, "error"),
          outputFile: readTaskNotificationTag(block, "output-file"),
          result: readTaskNotificationTag(block, "result"),
          status: subagentResult?.status ?? readTaskNotificationTag(block, "status"),
          summary: readTaskNotificationTag(block, "summary"),
          taskId: readTaskNotificationTag(block, "task-id"),
        },
      },
    ];
  });
}

export function collectZCodeBackgroundTaskNotificationsByToolUseId(
  messages: readonly ZCodeMessageWithParts[],
): Map<string, ZCodeBackgroundTaskNotificationInfo> {
  const notifications = new Map<string, ZCodeBackgroundTaskNotificationInfo>();
  for (const message of messages) {
    if (message.info.role !== "user") {
      continue;
    }
    for (const parsed of parseZCodeBackgroundTaskNotifications(
      textFromZCodeMessageParts(message.parts),
      message.info.metadata?.originMeta,
    )) {
      notifications.set(parsed.toolUseId, parsed.notification);
    }
  }
  return notifications;
}

/**
 * Failure reason shown in the App: prefer the structured result or the raw <error> text; when a merged turn has neither,
 * use this notification's own full result / summary sentence (same as the V4 projection), without extracting a reason from the summary.
 */
export function zcodeBackgroundTaskNotificationFailureText(
  notification: ZCodeBackgroundTaskNotificationInfo,
): string | undefined {
  return notification.error ?? notification.result ?? notification.summary;
}

export function zcodeBackgroundTaskNotificationToolUpdateStatus(
  status: string | undefined,
): Extract<
  Extract<ZCodeStreamEvent, { type: "tool_call_update" }>["status"],
  "completed" | "failed" | "stopped"
> {
  if (status === "failed" || status === "lost") {
    return "failed";
  }
  // Both killed and stopped in task-notification mean the task was stopped; do not map either to completed.
  if (status === "stopped" || status === "killed") {
    return "stopped";
  }
  return "completed";
}

export function attachZCodeBackgroundTaskNotificationToRaw(
  raw: unknown,
  notification: ZCodeBackgroundTaskNotificationInfo | undefined,
): unknown {
  if (!notification) {
    return raw;
  }
  const record = asPlainRecord(raw);
  const meta = asPlainRecord(record._meta);
  const zcode = asPlainRecord(meta.zcode);
  return {
    ...record,
    _meta: {
      ...meta,
      zcode: {
        ...zcode,
        taskNotification: notification,
      },
    },
  };
}

function readTaskNotificationTag(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "u"));
  const value = match?.[1]?.trim();
  return value ? decodeTaskNotificationXmlText(value) : undefined;
}

function decodeTaskNotificationXmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
