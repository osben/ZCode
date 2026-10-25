// ── Legacy protocol compatibility surface (transitional) ──────────────────────────────
// Remaining 11 exports: goal-iteration/visible-message projection functions.
// Consumers: zcodeTaskServiceAdapter/zcodeSessionProjection/zcodeTaskIndexSyncer,
// and CLI bootstrap session-mapper. textFromZCodeMessageParts moved to
// zcode-protocol-legacy-types.ts (the surviving module). This file has the same lifecycle as the legacy projection stack.
import type { ZCodeSessionGoal } from "./zcode-protocol/index.js";
import { getConversationMessageProjectionPolicy } from "./conversation-message-projection-policy.js";
import {
  type ZCodeMessageWithParts,
  textFromZCodeMessageParts,
} from "./zcode-protocol-legacy-types.js";

const GOAL_CONTINUATION_REMINDER_PREFIX = '<system-reminder source="goal-continuation">';
const GOAL_CONTINUATION_TEXT_MARKER = "Continue working toward the active session goal.";
const GOAL_STATE_TEXT_MARKER = "Current session goal state";
const SUBAGENT_MESSAGE_SOURCE = "subagent_message";

export function isZCodeGoalContinuationReminderText(text: string): boolean {
  const normalized = text.trimStart();
  if (normalized.startsWith(GOAL_CONTINUATION_REMINDER_PREFIX)) {
    return true;
  }
  return (
    normalized.startsWith("<system-reminder>") && normalized.includes(GOAL_CONTINUATION_TEXT_MARKER)
  );
}

export function isZCodeGoalContinuationReminderMessage(message: ZCodeMessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    (message.info.source === "goal-continuation" ||
      String(message.info.metadata?.["source"] ?? "") === "goal-continuation" ||
      isZCodeGoalContinuationReminderText(textFromZCodeMessageParts(message.parts)))
  );
}

export function isZCodeGoalStateReminderText(text: string): boolean {
  const normalized = text.trimStart();
  return normalized.startsWith("<system-reminder>") && normalized.includes(GOAL_STATE_TEXT_MARKER);
}

export function isZCodeGoalModelOnlyReminderMessage(message: ZCodeMessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    (isZCodeGoalContinuationReminderMessage(message) ||
      isZCodeGoalStateReminderText(textFromZCodeMessageParts(message.parts)))
  );
}

export function isZCodeModelOnlySyntheticUserMessage(message: ZCodeMessageWithParts): boolean {
  if (
    message.info.role === "user" &&
    (String(message.info.source ?? "") === SUBAGENT_MESSAGE_SOURCE ||
      String(message.info.metadata?.["source"] ?? "") === SUBAGENT_MESSAGE_SOURCE ||
      message.parts.some(
        (part) =>
          part.type === "text" &&
          String(part.metadata?.["source"] ?? "") === SUBAGENT_MESSAGE_SOURCE,
      ))
  ) {
    return true;
  }
  const policy = getConversationMessageProjectionPolicy(message);
  return policy === "providerContextOnly" || policy === "hiddenSynthetic";
}

export function isZCodeCompactSummaryMessage(message: ZCodeMessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    message.parts.some((part) => {
      if (part.type !== "compaction") {
        return false;
      }
      const timelineStatus = part.metadata?.["timelineStatus"];
      // A compact summary user message is compressed model context, not user-visible input.
      // Lifecycle parts that should render in the timeline carry timelineStatus and are held by assistant messages.
      return typeof timelineStatus !== "string";
    })
  );
}

export function getZCodeUserVisibleMessages(
  messages: readonly ZCodeMessageWithParts[],
  _options: { target?: ZCodeSessionGoal | null } = {},
): ZCodeMessageWithParts[] {
  const visibleMessages: ZCodeMessageWithParts[] = [];
  for (const message of messages) {
    if (isZCodeModelOnlySyntheticUserMessage(message) || isZCodeCompactSummaryMessage(message)) {
      // /goal continuations, background tasks, subagents, rewind notifications, and compact summaries
      // are context injected by the runtime for the model to continue reasoning, not the user's actual query; the visible projection must filter them,
      // so snapshot/remote-control recovery does not render them as right-side user bubbles or take up timeline space.
      continue;
    }
    visibleMessages.push(message);
  }
  return visibleMessages;
}

export function getZCodeGoalIterationByAssistantMessageId(
  messages: readonly ZCodeMessageWithParts[],
  options: { maxGoalIteration?: number; target?: ZCodeSessionGoal | null } = {},
): Map<string, number> {
  const target = options.target ?? null;
  if (!target) {
    return new Map();
  }

  const iterationByAssistantId = new Map<string, number>();
  const sortedMessages = [...messages].sort(compareZCodeMessagesByCreatedTime);
  const inactiveAt = target.status === "active" ? null : target.updatedAt;
  let currentIteration = 0;
  let pendingVisibleGoalUserIteration = false;

  for (const message of sortedMessages) {
    if (message.info.role === "user") {
      if (isZCodeGoalContinuationReminderMessage(message)) {
        // Goal continuation boundaries come only from Continue/source=goal-continuation;
        // Current session goal state is a status hint injected repeatedly within one turn and must not advance the iteration number here.
        currentIteration += 1;
        pendingVisibleGoalUserIteration = false;
        continue;
      }
      if (isVisibleRealGoalUserMessage(message, target)) {
        // The new protocol persists both visible /goal input and the model-only continuation.
        // Visible input supplies the first boundary only when a legacy snapshot lacks continuation; do not count it together with the continuation as two turns.
        pendingVisibleGoalUserIteration = true;
      }
      continue;
    }

    if (message.info.role !== "assistant") {
      continue;
    }
    if (inactiveAt !== null && message.info.time.created > inactiveAt) {
      // Ordinary follow-up questions after a goal is stopped/completed remain in the same session and must not inherit the previous goal iteration.
      // Otherwise, after snapshot recovery, follow-up replies would appear in history as "iteration N" and seem folded under the old completion divider.
      continue;
    }
    if (pendingVisibleGoalUserIteration) {
      currentIteration += 1;
      pendingVisibleGoalUserIteration = false;
    }
    if (currentIteration === 0 && message.info.time.created >= target.createdAt) {
      // In legacy sessions, the goal-creation input may have no visible `/goal` bubble or may predate target.createdAt.
      // The assistant after the first goal still belongs to iteration 1; otherwise, history falls back to ordinary "Worked."
      currentIteration = 1;
    }
    if (currentIteration > 0) {
      // The assistant message bucket is used only to display historical state and must not advance the goal iteration to
      // the next iteration before the verifier timeline confirms it; new sessions pass maxGoalIteration to cap it at the verifier's limit.
      const boundedIteration =
        options.maxGoalIteration && options.maxGoalIteration > 0
          ? Math.min(currentIteration, options.maxGoalIteration)
          : currentIteration;
      iterationByAssistantId.set(message.info.messageId, boundedIteration);
    }
  }

  return iterationByAssistantId;
}

export interface ZCodeGoalIterationCountTimelineItem {
  goalIteration?: number;
  status: "started" | "completed" | "failed_closed" | "cancelled";
  verification?: { passed?: boolean | null } | null;
}

export function getZCodeGoalActiveIterationCount(input: {
  targetStatus?: string | null;
  timeline?: readonly ZCodeGoalIterationCountTimelineItem[] | null;
}): number {
  if (!input.targetStatus) {
    return 0;
  }
  const timeline = input.timeline ?? [];
  if (timeline.length === 0) {
    return 1;
  }
  const latest = timeline[timeline.length - 1];
  if (!latest) {
    return 1;
  }
  const latestIteration = latest.goalIteration ?? timeline.length;
  if (latest.status === "started") {
    return latestIteration;
  }
  if (
    (latest.status === "completed" && latest.verification?.passed === true) ||
    input.targetStatus === "complete"
  ) {
    return latestIteration;
  }
  if (input.targetStatus !== "active") {
    // stop first changes the target to paused, then finalizes the running verifier as cancelled.
    // Inactive goals do not resume automatically; do not pre-project a cancelled/failed verifier as the next iteration.
    return latestIteration;
  }
  return latestIteration + 1;
}

function compareZCodeMessagesByCreatedTime(
  left: ZCodeMessageWithParts,
  right: ZCodeMessageWithParts,
) {
  const diff = left.info.time.created - right.info.time.created;
  if (diff !== 0) {
    return diff;
  }
  return left.info.messageId.localeCompare(right.info.messageId);
}

function isVisibleRealGoalUserMessage(message: ZCodeMessageWithParts, target: ZCodeSessionGoal) {
  if (
    message.info.role !== "user" ||
    getConversationMessageProjectionPolicy(message) !== "realUserInput"
  ) {
    return false;
  }

  const createdAt = message.info.time.created;
  const nearGoalStart = createdAt >= target.createdAt - 30_000;
  if (!nearGoalStart) {
    return false;
  }

  return true;
}

export function resolveZCodeVisibleSessionTitle(input: {
  title?: string;
  messages: readonly ZCodeMessageWithParts[];
  target?: ZCodeSessionGoal | null;
  fallback?: string;
}): string {
  const normalizedTitle = input.title?.trim() ?? "";
  if (
    normalizedTitle &&
    !isZCodeGoalContinuationReminderText(normalizedTitle) &&
    !isZCodeGoalStateReminderText(normalizedTitle)
  ) {
    return normalizedTitle;
  }

  const firstUser = input.messages.find(
    (message) =>
      message.info.role === "user" &&
      getConversationMessageProjectionPolicy(message) === "realUserInput" &&
      !isZCodeGoalModelOnlyReminderMessage(message),
  );
  const firstUserText = textFromZCodeMessageParts(firstUser?.parts ?? []).trim();
  if (firstUserText) {
    return firstUserText.slice(0, 80);
  }

  const objective = input.target?.objective.trim() ?? "";
  if (objective) {
    return objective.slice(0, 80);
  }

  return input.fallback ?? "New session";
}

// Title seed sanitizer (specs/session-title-polish.md §2.1).
// The seed is the copy of the first user input used only for the first-input title and the title model request.
// The persisted message and the model-facing prompt are never changed.

// A mention link never directly follows a word character, so `handlers[type](payload)` in pasted code is left alone.
// Every repeated group has disjoint first characters (backslash is excluded from the character classes), so matching
// stays linear on adversarial input such as an unclosed link followed by many backslashes. One level of balanced
// parentheses is allowed in a plain destination because file mentions emit paths like `./Dir (copy)/a.ts` unescaped.
const LINK_MENTION_PATTERN =
  /(?<![A-Za-z0-9_\])])\[((?:\\.|[^\\\]])*)\]\((?:<((?:\\.|[^>\\])*)>|((?:\\.|[^()\\]|\((?:\\.|[^()\\])*\))*))\)/g;
// Destinations composer mentions produce: absolute or relative paths, Windows drive paths, plugin and session ids.
const MENTION_DESTINATION_PATTERN = /^(?:\/|\.{1,2}\/|[A-Za-z]:[\\/]|file:|plugin:\/\/|#sess_)/;
// Only the head of a long paste can reach a title, so the scan is bounded.
const MAX_TITLE_SEED_SCAN_CHARS = 8192;
const BARE_SESSION_TOKEN_PATTERN = /(^|\s)#sess_[a-zA-Z0-9._-]+(?=$|\s)/g;
// Mirrors buildManualSkillPrompt in apps/zcode-cli/packages/cli/src/command-center/slash-commands.ts.
// shared cannot import cli; when the template drifts this stops matching and the input passes through unchanged.
const MANUAL_SKILL_PROMPT_PATTERN =
  /^Use the skill named `([^`\n]+)` for this turn\.\nFirst call the `Skill` tool with name `\1` before doing the task\.\nAfter the skill content is loaded, follow its instructions and continue\.\n\n(?:User request:\n([\s\S]*)|No additional user request was provided\. Load the skill and respond according to its instructions\.)$/;

function unescapeMarkdownLabel(label: string): string {
  return label.replace(/\\(.)/g, "$1");
}

function linkLabelToSeed(match: string, rawLabel: string, destination: string): string {
  const label = unescapeMarkdownLabel(rawLabel);
  // Ordinary links (https URLs, code like `a[i](x)`) are not mentions and stay as typed.
  if (!label.startsWith("$") && !MENTION_DESTINATION_PATTERN.test(destination)) return match;
  if (destination.startsWith("plugin://")) {
    return label.startsWith("@") ? label.slice(1) : label;
  }
  if (/^#sess_[a-zA-Z0-9._-]+$/.test(destination)) {
    return label.startsWith("#") ? label.slice(1) : label;
  }
  if (label.startsWith("$")) return label;
  return label.startsWith("@") ? label.slice(1) : label;
}

export function sanitizeTitleSeed(input: string): string {
  const scanned =
    input.length > MAX_TITLE_SEED_SCAN_CHARS ? input.slice(0, MAX_TITLE_SEED_SCAN_CHARS) : input;
  const manualSkill = MANUAL_SKILL_PROMPT_PATTERN.exec(scanned.trim());
  const seedSource = manualSkill
    ? manualSkill[2] !== undefined && manualSkill[2].trim().length > 0
      ? manualSkill[2]
      : `$${manualSkill[1]}`
    : scanned;
  const sanitized = seedSource
    .replace(LINK_MENTION_PATTERN, (match, label: string, angled?: string, plain?: string) =>
      linkLabelToSeed(match, label, angled ?? plain ?? ""),
    )
    .replace(BARE_SESSION_TOKEN_PATTERN, "$1");
  return sanitized.trim().length > 0 ? sanitized : input;
}
