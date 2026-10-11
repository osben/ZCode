/**
 * slashCommandHelpers — pure helper functions used by SlashCommandPlugin.tsx
 */
import { $getRoot, $getSelection, $isRangeSelection, $isTextNode } from "lexical";
import type { AgentSummary, Locale, SkillSummary, ZCodeSlashCommand } from "@zcode/shared";
import type { MentionItem } from "@/mentions/mentionTypes.js";
import { mapSubagentsToMentionItemsForTest } from "@/mentions/providers/subagentsMentionProvider.js";
import { mapSkillsToMentionItemsForTest } from "@/mentions/providers/skillsMentionProvider.js";
import {
  extractActivePromptInputTrigger,
  getActivePromptInputTokenTailLength,
} from "./lib/promptInputTriggers.js";
import type { PromptInputSuggestionItem } from "./lib/promptInputTriggers.js";

export interface SlashCommandPluginProps {
  container?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  /** ID of an existing Session; null/undefined means a new draft and determines Skill catalog authority. */
  sessionId?: string | null;
  disabled?: boolean;
  excludedCommandNames?: readonly string[];
  /**
   * App-level local commands (such as `/side`). The CLI catalog remains authoritative; only rendering-layer commands are allowed here
   * that “run a UI action on selection”; they are not sent and are not written back to the CLI command list.
   */
  appCommands?: readonly AppSlashCommand[];
}

/** App-level slash command: selecting it runs a UI action (no mention insertion or message send). */
export interface AppSlashCommand {
  /** Command value (without `/`), such as "side". */
  value: string;
  /** Localized description displayed directly in the `/` panel. */
  description: string;
  /** Extra search keywords; include both Chinese and English aliases so either input convention can find the command. */
  keywords?: readonly string[];
  /** UI action to run immediately after the command is selected. */
  run: () => void;
}

const APP_SLASH_SUGGESTION_ID_PREFIX = "app-slash:";

export function buildAppSlashCommandSuggestions(
  commands: readonly AppSlashCommand[],
): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    const value = normalizeSlashCommandValue(command.value);
    if (!value) {
      return [];
    }
    return [
      {
        id: `${APP_SLASH_SUGGESTION_ID_PREFIX}${value}`,
        trigger: "/",
        value,
        label: `/${value}`,
        description: command.description,
        keywords: [...new Set([value, command.description, ...(command.keywords ?? [])])],
      },
    ];
  });
}

export function isAppSlashCommandSuggestion(suggestion: PromptInputSuggestionItem): boolean {
  return suggestion.id.startsWith(APP_SLASH_SUGGESTION_ID_PREFIX);
}

/**
 * `/side` gate: drafts have no parent session to attach a child to, and auxiliary conversations cannot open another auxiliary conversation.
 * Hide the command consistently for read-only contexts, mobile viewports, and fixed entry points.
 */
export function shouldOfferSideSlashCommand(options: {
  isDraft: boolean;
  selectionSideChat: boolean;
  readOnly: boolean;
  isMobileViewport: boolean;
}): boolean {
  return (
    !options.isDraft && !options.selectionSideChat && !options.readOnly && !options.isMobileViewport
  );
}

export function normalizeSlashCommandValue(name: string): string {
  // A remote ZCode Agent may return "/init" directly as the command name.
  // Strip the leading slash from the UI value; otherwise Markdown insertion produces "//init" and interferes with slash-panel matching.
  return name.trim().replace(/^\/+/, "");
}

export function buildSlashSuggestions(commands: ZCodeSlashCommand[]): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    const value = normalizeSlashCommandValue(command.name);
    // The UI used to maintain a built-in allowlist, a GLM `/goal` fallback, and a v4 appended catalog.
    // If the CLI catalog was missing, some commands still appeared, hiding missing `/init` and custom commands. Command discovery
    // now treats the CLI protocol catalog as authoritative; the UI no longer appends commands or maintains a built-in allowlist.
    if (!value) {
      return [];
    }
    return [
      {
        id: `slash:${value}`,
        trigger: "/",
        value,
        label: command.inputHint?.trim() || `/${value}`,
        description: command.description,
        keywords: [...new Set([value, command.name, command.description, command.inputHint ?? ""])],
      },
    ];
  });
}

export function buildSubagentSuggestions(
  agents: Array<
    Pick<
      AgentSummary,
      "id" | "name" | "description" | "path" | "scope" | "source" | "enabled" | "modelSelection"
    >
  >,
): PromptInputSuggestionItem[] {
  return mapSubagentsToMentionItemsForTest(agents).map((item) =>
    mapSubagentMentionItemToSuggestion(item),
  );
}

export function buildSkillSuggestions(
  skills: Array<
    Pick<SkillSummary, "id" | "name" | "description" | "path" | "scope" | "pluginName">
  >,
  locale?: Locale,
): PromptInputSuggestionItem[] {
  return mapSkillsToMentionItemsForTest(skills, locale).map((item) => ({
    id: item.id,
    trigger: "/",
    value: item.value,
    label: `$${item.value}`,
    description: item.description,
    keywords: [...new Set([...(item.keywords ?? []), "skill", "skills", item.value])],
    data: item.data,
  }));
}

function mapSubagentMentionItemToSuggestion(item: MentionItem): PromptInputSuggestionItem {
  return {
    id: item.id,
    trigger: "/",
    value: item.value,
    label: item.label,
    description: item.description,
    keywords: [...new Set([...(item.keywords ?? []), "subagent", "agent"])],
    data: item.data,
  };
}

export function replaceActiveSlashToken(
  textBeforeCursor: string,
  textAfterCursor: string,
  replacementToken: string,
) {
  const activeTrigger = extractActivePromptInputTrigger(textBeforeCursor);
  if (!activeTrigger || activeTrigger.trigger !== "/") {
    return null;
  }

  const tokenStart = textBeforeCursor.length - activeTrigger.query.length - 1;
  const tailLength = getActivePromptInputTokenTailLength(
    activeTrigger,
    textAfterCursor,
    replacementToken,
  );
  const prefix = textBeforeCursor.slice(0, tokenStart);
  const suffix = textAfterCursor.slice(tailLength);
  return {
    cursorOffset: prefix.length + replacementToken.length + 1,
    text: `${prefix}${replacementToken} ${suffix}`,
  };
}

export function getTextAroundCursor() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return null;
  }

  const anchor = selection.anchor;
  if (anchor.type !== "text") {
    return {
      textAfterCursor: "",
      textBeforeCursor: $getRoot().getTextContent(),
    };
  }

  const node = anchor.getNode();
  if (!$isTextNode(node)) {
    return null;
  }

  const textContent = node.getTextContent();
  return {
    textAfterCursor: textContent.slice(anchor.offset),
    textBeforeCursor: textContent.slice(0, anchor.offset),
  };
}
