import { parseRuntimeInputPresentation } from "@zcode/contracts";
import {
  INTERRUPT_MARKER_SOURCE,
  isKnownSystemReminderSource,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import {
  formatIncomingMessage,
  inputPresentationRole,
  isMidTurnInputPresentation,
  type InputPresentationRole,
} from "../../system-reminder/incoming-message.js";
import {
  getSystemReminderDescriptor,
  wrapSystemReminderForSource,
} from "../../system-reminder/source.js";

const INCOMING_MESSAGE_SOURCE = "incoming_message";
// Separator between adjacent notification blocks in an idle full batch.
const TASK_NOTIFICATION_BLOCK_SEPARATOR = "\n";

/** Projection map owned only by a single request; not written to canonical history or provider payload. */
export class ProviderEntryOrigins {
  private readonly origins = new WeakMap<RuntimeMessageEntry, readonly RuntimeMessageEntry[]>();

  get(entry: RuntimeMessageEntry): readonly RuntimeMessageEntry[] {
    return this.origins.get(entry) ?? [entry];
  }

  set(entry: RuntimeMessageEntry, inputs: readonly RuntimeMessageEntry[]): void {
    this.origins.set(
      entry,
      inputs.flatMap((input) => this.get(input)),
    );
  }

  /**
   * Position of the projected entry carrying the last real user input in original order; -1 when absent.
   * Bug cause: under MCS the guide merges into the system at the run's end, which may sort after
   * a later real prompt; taking the last projected entry with a real-user source would select
   * that system, and images in the prompt would lose media budget protection.
   */
  latestRealUserIndex(
    projected: readonly RuntimeMessageEntry[],
    canonical: readonly RuntimeMessageEntry[],
  ): number {
    const latest = canonical.findLast(isCanonicalRealUser);
    return latest ? projected.findIndex((entry) => this.get(entry).includes(latest)) : -1;
  }

  representative(entry: RuntimeMessageEntry): RuntimeMessageEntry | undefined {
    const entries = this.get(entry);
    return (
      entries.findLast(isCanonicalRealUser) ??
      entries.findLast((item) => !isRuntimeAttachmentEntry(item))
    );
  }
}

function isCanonicalRealUser(entry: RuntimeMessageEntry): boolean {
  return (
    !isRuntimeAttachmentEntry(entry) &&
    entry.queryScope !== "output_token_continuation" &&
    entry.message.role === "user" &&
    !entry.message.toolCallId &&
    !entry.message.toolName &&
    (!entry.metadata || entry.metadata.source === "real_user")
  );
}

export function isPresentedInput(entry: RuntimeMessageEntry): boolean {
  return parseRuntimeInputPresentation(entry.metadata?.inputPresentation) !== undefined;
}

export function inputRoleOf(entry: RuntimeMessageEntry): InputPresentationRole | undefined {
  const presentation = parseRuntimeInputPresentation(entry.metadata?.inputPresentation);
  return presentation && inputPresentationRole(presentation);
}

/**
 * Inputs that remain user messages after projection (real prompts, child tasks, new-turn
 * notifications). Only the projected entry itself counts: mid-turn messages projected into
 * attachments and MCS downgrade blocks do not. The source map is not consulted: a user_steer's
 * source is real_user, but once projected into an attachment it is not a prompt.
 */
export function isUserInputMessage(entry: RuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry) || entry.message.role !== "user") return false;
  // A mid-turn message with media can only keep its user message shape; merging rules stay the same as attachments.
  if (entry.metadata?.source === INCOMING_MESSAGE_SOURCE) return false;
  // A compact summary is an ordinary user message; the previous user text likewise ends with a newline.
  // Judge by compactBoundary, not by source: both the summary and old background notifications use legacy_synthetic.
  if (entry.metadata?.compactBoundary) return true;
  if (entry.metadata?.source === INTERRUPT_MARKER_SOURCE) return true;
  return isCanonicalRealUser(entry) || isPresentedInput(entry);
}

export function isMidTurnInput(entry: RuntimeMessageEntry): boolean {
  return inputRoleOf(entry) === "mid_turn";
}

/**
 * Inputs that open a user turn: entries in history that are ordinary user messages (real
 * prompts, child tasks, new-turn notifications, interruption markers, compact summaries).
 * Mid-turn messages are attachments and do not count. Reminder cadence counting and the
 * bubbling boundary for mid-turn messages are both divided by this.
 */
export function isUserTurnInput(entry: RuntimeMessageEntry): boolean {
  return isUserInputMessage(entry) && !isMidTurnInput(entry);
}

export function projectIncomingMessageEntries(
  entries: readonly RuntimeMessageEntry[],
  origins: ProviderEntryOrigins,
): RuntimeMessageEntry[] {
  return entries.map((entry, index) => {
    if (isRuntimeAttachmentEntry(entry) || entry.message.role !== "user") return entry;
    const presentation = parseRuntimeInputPresentation(entry.metadata?.inputPresentation);
    if (!presentation) return entry;
    const content = entry.message.content;
    const media =
      typeof content === "string" ? [] : content.filter((block) => block.type !== "text");
    const textBlocks =
      typeof content === "string"
        ? [content]
        : content.flatMap((block) => (block.type === "text" ? [block.text] : []));
    // New-turn notifications do not pass through Attachment wrapping; add labels and escaping at the same projection boundary while preserving user identity and original history.
    // Bug cause: the idle full batch used to be split back into individual notifications here by
    // the <task-notification> prefix; during a workflow run a notification does not start with it
    // and would be merged into the previous entry's wrapping. The full batch now stores each
    // notification as one text block, wrapped block by block here, with a trailing "\n" on all
    // but the last — identical to the content blocks after adjacent per-notification user
    // messages merge, matching live and cold restore.
    if (presentation === "task_notification" && media.length === 0 && textBlocks.length > 1) {
      const projected: RuntimeMessageEntry = {
        ...entry,
        message: {
          ...entry.message,
          content: textBlocks.map((notification, blockIndex) => ({
            type: "text",
            text: `${wrapSystemReminderForSource(
              INCOMING_MESSAGE_SOURCE,
              formatIncomingMessage(notification, presentation),
            )}${blockIndex < textBlocks.length - 1 ? TASK_NOTIFICATION_BLOCK_SEPARATOR : ""}`,
          })),
        },
      };
      origins.set(projected, [entry]);
      return projected;
    }
    const body = textBlocks.join("\n");
    // A single notification and old-version batches stored as one joined string are wrapped once, same as released versions.
    const text =
      presentation === "task_notification"
        ? wrapSystemReminderForSource(
            INCOMING_MESSAGE_SOURCE,
            formatIncomingMessage(body, presentation),
          )
        : formatIncomingMessage(body, presentation, {
            inHumanTurn:
              presentation === "task_notification_steer" && isInHumanTurn(entries, index),
          });
    // Mid-turn messages (including human guides) all go through attachments and merge into the run's system under MCS.
    // Bug cause: the human guide was once projected separately as user text under MCS and moved to the run's end,
    // unlike every other mid-turn message, unlike MCS off, and unlike released versions; a guide
    // is an in-turn hint and is projected by the same rule.
    const asAttachment = isMidTurnInputPresentation(presentation);
    // Mid-turn messages with images likewise need the prefix and explanation, or the model would read them as a new user turn.
    // Text blocks are newline-joined, wrapped once and placed in the first block; media follow in original order.
    // An attachment can only be a string, so keep the user message shape and add the wrapping here.
    const projected: RuntimeMessageEntry =
      media.length > 0
        ? {
            message: {
              ...entry.message,
              content: [
                {
                  type: "text",
                  text: asAttachment
                    ? wrapSystemReminderForSource(INCOMING_MESSAGE_SOURCE, text)
                    : text,
                },
                ...media,
              ],
            },
            metadata: asAttachment
              ? { source: INCOMING_MESSAGE_SOURCE, inputPresentation: presentation }
              : entry.metadata,
          }
        : asAttachment
          ? {
              kind: "attachment",
              content: text,
              metadata: { source: INCOMING_MESSAGE_SOURCE, inputPresentation: presentation },
            }
          : { ...entry, message: { ...entry.message, content: text } };
    origins.set(projected, [entry]);
    return projected;
  });
}

// Search backwards from the notification, skipping attachments, system entries, reminders and
// other mid-turn messages; the first real prompt found means the same turn. An assistant, tool
// result, or other user message (new-turn notification, child task, compact summary) means not.
function isInHumanTurn(entries: readonly RuntimeMessageEntry[], index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const entry = entries[cursor]!;
    if (isRuntimeAttachmentEntry(entry) || entry.message.role === "system") continue;
    if (entry.message.role !== "user" || entry.message.toolCallId || entry.message.toolName) {
      return false;
    }
    if (isMidTurnInput(entry) || isReminderMessage(entry)) continue;
    return isCanonicalRealUser(entry) && !isPresentedInput(entry);
  }
  return false;
}

export function isReminderMessage(entry: RuntimeMessageEntry): boolean {
  const source = entry.metadata?.source;
  if (!isKnownSystemReminderSource(source)) return false;
  const descriptor = getSystemReminderDescriptor(source);
  return descriptor.isMeta && descriptor.channel !== "real_user";
}
