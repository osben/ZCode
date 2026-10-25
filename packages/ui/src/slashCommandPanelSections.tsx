import { useMemo } from "react";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { PromptInputSuggestionItem } from "@/lib/promptInputTriggers.js";
import { isAppSlashCommandSuggestion } from "@/slashCommandHelpers.js";
import {
  type MentionPanelOption,
  type MentionPanelSection,
} from "@/mentions/components/MentionPanel.js";

/**
 * Flat keyboard list in panel order. A loading or failed section renders a status row instead of its options
 * (buildVirtualRows), so its cached options must not be counted either, or Enter picks a different item than the
 * highlighted row.
 */
export function buildSlashFlatSuggestions(input: {
  commands: PromptInputSuggestionItem[];
  skills: PromptInputSuggestionItem[];
  skillsLoading: boolean;
  skillsError: string | null;
  subagents: PromptInputSuggestionItem[];
  subagentsLoading: boolean;
  subagentsError: string | null;
  quickPrompts?: PromptInputSuggestionItem[];
}): PromptInputSuggestionItem[] {
  const skillsShown = !input.skillsLoading && !input.skillsError;
  const subagentsShown = !input.subagentsLoading && !input.subagentsError;
  return [
    ...input.commands,
    ...(skillsShown ? input.skills : []),
    ...(subagentsShown ? input.subagents : []),
    ...(input.quickPrompts ?? []),
  ];
}

export function useSlashCommandMentionPanelSections(
  intl: IntlInstance,
  commandsLength: number,
  filteredCommandSuggestions: PromptInputSuggestionItem[],
  filteredSkillSuggestions: PromptInputSuggestionItem[],
  skillsLoading: boolean,
  skillsError: string | null,
  filteredSubagentSuggestions: PromptInputSuggestionItem[],
  subagentsLoading: boolean,
  subagentsError: string | null,
  /** Omitted (undefined) hides the section entirely; the flat keyboard index must match the same order. */
  filteredQuickPromptSuggestions?: PromptInputSuggestionItem[],
): MentionPanelSection[] {
  return useMemo(
    () => [
      {
        id: "commands",
        title: intl.formatMessage({ id: "chat.slash.commands.title" }),
        options: filteredCommandSuggestions.map<MentionPanelOption>((suggestion) => ({
          id: suggestion.id,
          label: isAppSlashCommandSuggestion(suggestion)
            ? suggestion.label
            : `/${suggestion.value}`,
          description: suggestion.description,
          content: (
            <span className="min-w-0 flex-1 flex items-center gap-2">
              <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                {isAppSlashCommandSuggestion(suggestion)
                  ? suggestion.label
                  : `/${suggestion.value}`}
              </span>
              <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                {suggestion.description}
              </span>
            </span>
          ),
        })),
        loading: false,
        emptyText:
          commandsLength === 0
            ? intl.formatMessage({ id: "chat.slash.emptyUnavailable" })
            : intl.formatMessage({ id: "chat.slash.emptyResults" }),
      },
      {
        id: "skills",
        title: intl.formatMessage({ id: "chat.slash.skills.title" }),
        options: filteredSkillSuggestions.map<MentionPanelOption>((suggestion) => ({
          id: suggestion.id,
          label: `$${suggestion.value}`,
          description: suggestion.description,
          content: (
            <span className="min-w-0 flex-1 flex items-center gap-2">
              <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                {`$${suggestion.value}`}
              </span>
              <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                {suggestion.description}
              </span>
            </span>
          ),
        })),
        loading: skillsLoading,
        loadingText: intl.formatMessage({ id: "chat.mention.category.loading" }),
        emptyText: intl.formatMessage({ id: "chat.slash.skills.empty" }),
        errorText: skillsError,
      },
      {
        id: "subagents",
        title: intl.formatMessage({ id: "chat.slash.subagents.title" }),
        options: filteredSubagentSuggestions.map<MentionPanelOption>((suggestion) => ({
          id: suggestion.id,
          label: suggestion.value,
          description: suggestion.description,
          content: (
            <span className="min-w-0 flex-1 flex items-center gap-2">
              <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                {suggestion.value}
              </span>
              <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                {suggestion.description}
              </span>
            </span>
          ),
        })),
        loading: subagentsLoading,
        emptyText: intl.formatMessage({ id: "chat.slash.subagents.empty" }),
        errorText: subagentsError,
      },
      ...(filteredQuickPromptSuggestions
        ? [
            {
              id: "quick-prompts",
              title: intl.formatMessage({ id: "quickPrompts.slash.title" }),
              options: filteredQuickPromptSuggestions.map<MentionPanelOption>((suggestion) => ({
                id: suggestion.id,
                label: suggestion.label,
                description: suggestion.description,
                content: (
                  <span className="min-w-0 flex-1 flex items-center gap-2">
                    <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                      {suggestion.label}
                    </span>
                    <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                      {suggestion.description}
                    </span>
                  </span>
                ),
              })),
              loading: false,
              emptyText: intl.formatMessage({ id: "quickPrompts.slash.empty" }),
            },
          ]
        : []),
    ],
    [
      commandsLength,
      filteredCommandSuggestions,
      filteredSkillSuggestions,
      filteredSubagentSuggestions,
      filteredQuickPromptSuggestions,
      intl,
      skillsError,
      skillsLoading,
      subagentsError,
      subagentsLoading,
    ],
  );
}
