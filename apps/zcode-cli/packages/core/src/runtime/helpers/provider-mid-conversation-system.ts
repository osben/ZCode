import type {
  ModelInputMessage,
  RuntimeMessageEntry,
  RuntimeMessageMessageEntry,
} from "../../agent/message-history.js";
import {
  isRuntimeAttachmentEntry,
  isKnownSystemReminderSource,
} from "../../agent/message-history.js";
import {
  isMidConversationSystemSource,
  sanitizeSystemReminderBody,
  wrapSystemReminder,
} from "../../system-reminder/source.js";
import { isMidTurnInput, type ProviderEntryOrigins } from "./provider-entry-origins.js";

interface PendingMidSystemEntry {
  entry: RuntimeMessageEntry;
  text: string;
}

interface MidSystemProjection {
  fallbackBody: string;
}

interface ProjectedMidSystemMessageEntry extends RuntimeMessageMessageEntry {
  midSystemProjection: MidSystemProjection;
}

export type ProjectedRuntimeMessageEntry = RuntimeMessageEntry | ProjectedMidSystemMessageEntry;

interface MidSystemProjectionResult {
  entries: ProjectedRuntimeMessageEntry[];
}

export function projectMidConversationSystemEntries(
  entries: readonly RuntimeMessageEntry[],
  origins: ProviderEntryOrigins,
): MidSystemProjectionResult {
  const projected: ProjectedRuntimeMessageEntry[] = [];
  const pending: PendingMidSystemEntry[] = [];

  const flushPending = (): void => {
    if (pending.length === 0) return;
    const pendingItems = pending.splice(0);
    const body = pendingItems.map((item) => item.text).join("\n\n");
    const previous = projected.at(-1);

    if (previous && isProjectedMidSystemEntry(previous)) {
      origins.set(previous, [previous, ...pendingItems.map((item) => item.entry)]);
      previous.message = {
        ...previous.message,
        content: `${previous.message.content}\n\n${body}`,
      };
      previous.midSystemProjection.fallbackBody = `${previous.midSystemProjection.fallbackBody}\n\n${body}`;
      return;
    }

    if (previous && canAnchorMidConversationSystemAfter(previous)) {
      const systemEntry: ProjectedMidSystemMessageEntry = {
        message: {
          role: "system",
          content: body,
        },
        midSystemProjection: { fallbackBody: body },
      };
      origins.set(
        systemEntry,
        pendingItems.map((item) => item.entry),
      );
      projected.push(systemEntry);
      return;
    }

    // With no legal anchor, the whole group degrades to a single user reminder, wrapped once.
    projected.push(
      midSystemFallbackEntry(
        body,
        pendingItems.map((item) => item.entry),
        origins,
      ),
    );
  };

  // MCS text of the same user run lands only before an assistant/system entry or at the end,
  // so it may pass over user inputs inside the run.
  // Fix rationale: when splitting before every marked input, announcements preceding a
  // notification stayed before it, putting the landing point in the wrong place.
  for (const entry of entries) {
    const projectedText = midConversationSystemText(entry);
    if (projectedText !== undefined) {
      pending.push({ entry, text: projectedText });
      continue;
    }

    if (pending.length > 0 && shouldFlushMidConversationSystemBefore(entry)) {
      flushPending();
    }

    projected.push(entry);
  }

  flushPending();

  return { entries: validateMidConversationSystemPositions(projected, origins) };
}

function midConversationSystemText(entry: RuntimeMessageEntry): string | undefined {
  if (isRuntimeAttachmentEntry(entry)) {
    const source = entry.metadata.source;
    if (!isKnownSystemReminderSource(source)) return undefined;
    if (!isMidConversationSystemSource(source)) return undefined;
    return entry.content;
  }
  return undefined;
}

function shouldFlushMidConversationSystemBefore(entry: RuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) return false;
  // A pending system reminder must wait for an assistant or system boundary,
  // avoiding an invalid provider-visible order by inserting it in the middle of a tool-result group.
  return entry.message.role === "assistant" || entry.message.role === "system";
}

function canAnchorMidConversationSystemAfter(entry: ProjectedRuntimeMessageEntry): boolean {
  // Attachments kept on the user side render as user messages and can serve as anchors.
  if (isRuntimeAttachmentEntry(entry)) return true;
  const message = entry.message;
  // A valid mid-conversation system anchor follows the provider-visible role.
  // A model-only user (such as goal continuation) is still a user message and must not be incorrectly downgraded because of internal source metadata.
  if (message.role === "tool") return true;
  return message.role === "user";
}

function validateMidConversationSystemPositions(
  entries: readonly ProjectedRuntimeMessageEntry[],
  origins: ProviderEntryOrigins,
): ProjectedRuntimeMessageEntry[] {
  const projected: ProjectedRuntimeMessageEntry[] = [];

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (!isProjectedMidSystemEntry(entry)) {
      projected.push(entry);
      continue;
    }

    const previous = projected.at(-1);
    const next = entries[index + 1];
    if (previous && canKeepMidConversationSystemBetween(previous, next)) {
      projected.push(entry);
      continue;
    }

    // Keep a mid-conversation system message only at a provider-valid boundary;
    // elsewhere, downgrade it to the legacy user system-reminder to avoid an invalid role order in the request body.
    projected.push(
      midSystemFallbackEntry(entry.midSystemProjection.fallbackBody, [entry], origins),
    );
  }

  return projected;
}

function midSystemFallbackEntry(
  body: string,
  inputs: readonly RuntimeMessageEntry[],
  origins: ProviderEntryOrigins,
): RuntimeMessageEntry {
  const fallback: RuntimeMessageEntry = {
    message: {
      role: "user",
      // MCS bodies are not user-wrapped; the downgrade must sanitize itself and cannot assume
      // the producer already did.
      content: wrapSystemReminder(sanitizeSystemReminderBody(body)),
    },
    metadata: { source: "legacy_synthetic" },
  };
  origins.set(fallback, inputs);
  return fallback;
}

function canKeepMidConversationSystemBetween(
  previous: ProjectedRuntimeMessageEntry,
  next: ProjectedRuntimeMessageEntry | undefined,
): boolean {
  if (!canAnchorMidConversationSystemAfter(previous)) return false;
  if (!next) return true;
  if (isProjectedMidSystemEntry(next)) return true;
  if (isRuntimeAttachmentEntry(next)) return false;
  return next.message.role === "assistant";
}

function isProjectedMidSystemEntry(
  entry: ProjectedRuntimeMessageEntry | undefined,
): entry is ProjectedMidSystemMessageEntry {
  return Boolean(entry && "midSystemProjection" in entry && entry.midSystemProjection);
}

export function moveLegacySystemRemindersAfterToolResultRun(
  entries: readonly ProjectedRuntimeMessageEntry[],
): ProjectedRuntimeMessageEntry[] {
  // The legacy/fallback system-reminder is ordinary user text.
  // If inserted in the middle of a tool-result group, Anthropic serialization only merges roles; it does not move tool_result before the text.
  const projected: ProjectedRuntimeMessageEntry[] = [];
  const pendingLegacyReminders: ProjectedRuntimeMessageEntry[] = [];

  const flushPendingLegacyReminders = (): void => {
    if (pendingLegacyReminders.length === 0) return;
    projected.push(...pendingLegacyReminders.splice(0));
  };

  for (const entry of entries) {
    if (
      isLegacySystemReminderEntry(entry) &&
      (pendingLegacyReminders.length > 0 || isToolResultEntry(projected.at(-1)))
    ) {
      pendingLegacyReminders.push(entry);
      continue;
    }

    if (pendingLegacyReminders.length > 0) {
      if (isToolResultEntry(entry)) {
        projected.push(entry);
        continue;
      }
      flushPendingLegacyReminders();
    }

    projected.push(entry);
  }

  flushPendingLegacyReminders();
  return projected;
}

function isLegacySystemReminderEntry(entry: ProjectedRuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) return true;
  if (entry.message.role !== "user") return false;
  // Mid-turn messages carrying media are user messages; they likewise must not split the same
  // group of tool results.
  return entry.metadata?.source === "legacy_synthetic" || isMidTurnInput(entry);
}

function isToolResultEntry(entry: ProjectedRuntimeMessageEntry | undefined): boolean {
  if (!entry || isRuntimeAttachmentEntry(entry)) return false;
  return entry.message.role === "tool" || isToolResultUserMessage(entry.message);
}

export function isToolResultUserMessage(message: ModelInputMessage): boolean {
  return message.role === "user" && Boolean(message.toolCallId || message.toolName);
}
