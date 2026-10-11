/* eslint-disable max-lines -- The Lexical slash plugin's trigger, panel, and keyboard navigation form one protocol state machine; formatting puts it slightly over 400 lines. */
/**
 * SlashCommandPlugin — Lexical trigger-panel plugin
 *
 * Handles slash commands and subagents in the `/` panel:
 * 1. `/` displays the actual slash commands broadcast by ZCode Agent and adds available subagents.
 * 2. The panel renders through a portal into a separate mount above the input and overlays the message area when expanded.
 * 3. Supports closing with Esc, navigating with the arrow keys, selecting with Enter / Tab, and fuzzy search as the user types.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { createPortal } from "react-dom";
import {
  $createTextNode,
  BLUR_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
} from "lexical";
import { useSubagents } from "@/hooks/useSubagents.js";
import { useSkills } from "@/hooks/useSkills.js";
import { buildSlashApplyMentionPayload } from "@/lib/slashApplyMentionPayload.js";
import { filterSkillsForProvider } from "@/lib/skillSourceFilter.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { useSlashCommands } from "./hooks/useSlashCommands.js";
import { $createPromptMentionNode } from "./mentions/nodes/PromptMentionNode.js";
import {
  extractActivePromptInputTrigger,
  filterPromptInputSuggestions,
  getActivePromptInputTokenTailLength,
  getBestPromptInputSuggestionIndex,
  getPromptInputTriggerSignature,
  type ActivePromptInputTrigger,
  type PromptInputSuggestionItem,
} from "./lib/promptInputTriggers.js";
import { MentionPanel } from "./mentions/components/MentionPanel.js";
import {
  buildAppSlashCommandSuggestions,
  buildSkillSuggestions,
  buildSubagentSuggestions,
  buildSlashSuggestions,
  getTextAroundCursor,
  isAppSlashCommandSuggestion,
  normalizeSlashCommandValue,
  type SlashCommandPluginProps,
} from "./slashCommandHelpers.js";
import { useSlashCommandMentionPanelSections } from "./slashCommandPanelSections.js";
import { getCurrentTextNodeSelection } from "./mentions/mentionHelpers.js";
import {
  getActivePromptInputTokenReplacementRange,
  reconcileActivePromptInputTokenSnapshot,
  type ActivePromptInputTokenSnapshot,
} from "./mentions/activePromptInputToken.js";
import { shouldSlashPanelProcessUpdate } from "./lib/slashPanelUpdateFilter.js";

export function SlashCommandPlugin({
  workspacePath,
  workspaceIdentity,
  sessionId,
  provider,
  container,
  disabled = false,
  excludedCommandNames,
  appCommands,
}: SlashCommandPluginProps & { provider: ZCodeProvider }) {
  const [editor] = useLexicalComposerContext();
  const { intl, locale } = useZCodeIntl();
  const [activeTrigger, setActiveTrigger] = useState<ActivePromptInputTrigger | null>(null);
  // Slash commands for a remote workspace are stored in the workspaceIdentity bucket.
  // Reading only by workspacePath here would use the path bucket, making it appear that ZCode Agent received available_commands_update while the `/` panel stayed empty.
  const commands = useSlashCommands(workspacePath, workspaceIdentity);
  const {
    agents,
    loading: subagentsLoading,
    error: subagentsError,
  } = useSubagents(workspacePath, provider, workspaceIdentity);
  const {
    skills,
    loading: skillsLoading,
    error: skillsError,
  } = useSkills({
    workspacePath,
    workspaceIdentity,
    sessionId: sessionId ?? null,
    enabled: !disabled && activeTrigger?.trigger === "/",
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dismissedSignatureRef = useRef<string | null>(null);
  const activeSignatureRef = useRef<string | null>(null);
  const activeTokenRef = useRef<ActivePromptInputTokenSnapshot | null>(null);
  const commandSuggestions = useMemo(() => {
    const excluded = new Set((excludedCommandNames ?? []).map(normalizeSlashCommandValue));
    const cliSuggestions = buildSlashSuggestions(commands).filter(
      (item) => !excluded.has(item.value),
    );
    // Append app-level commands after the CLI catalog; when the CLI already provides a command with the same name, prefer the CLI to avoid masking it.
    const cliValues = new Set(cliSuggestions.map((item) => item.value));
    const appSuggestions = buildAppSlashCommandSuggestions(appCommands ?? []).filter(
      (item) => !cliValues.has(item.value) && !excluded.has(item.value),
    );
    return [...cliSuggestions, ...appSuggestions];
  }, [appCommands, commands, excludedCommandNames]);
  const subagentSuggestions = useMemo(() => buildSubagentSuggestions(agents), [agents]);
  const skillSuggestions = useMemo(
    () =>
      buildSkillSuggestions(
        filterSkillsForProvider(skills, provider).filter((skill) => skill.enabled),
        locale,
      ),
    [locale, provider, skills],
  );
  const filteredCommandSuggestions = useMemo(
    () => filterPromptInputSuggestions(commandSuggestions, activeTrigger?.query ?? null),
    [commandSuggestions, activeTrigger?.query],
  );
  const filteredSubagentSuggestions = useMemo(
    () => filterPromptInputSuggestions(subagentSuggestions, activeTrigger?.query ?? null),
    [subagentSuggestions, activeTrigger?.query],
  );
  const filteredSkillSuggestions = useMemo(
    () => filterPromptInputSuggestions(skillSuggestions, activeTrigger?.query ?? null),
    [skillSuggestions, activeTrigger?.query],
  );
  const filteredSuggestions = useMemo(
    () => [
      ...filteredCommandSuggestions,
      ...filteredSkillSuggestions,
      ...filteredSubagentSuggestions,
    ],
    [filteredCommandSuggestions, filteredSkillSuggestions, filteredSubagentSuggestions],
  );
  const activeSignature = useMemo(
    () => getPromptInputTriggerSignature(activeTrigger),
    [activeTrigger],
  );
  const isOpen = !disabled && activeTrigger !== null;

  useEffect(() => {
    activeSignatureRef.current = activeSignature;
  }, [activeSignature]);

  useEffect(() => {
    // The panel must preserve the commands/subagents group order, but the keyboard's default selection must not be fixed to the first group.
    // For example, with `/rev`, a weak match in a command description may appear before the subagent group and prevent the best subagent from being selected by default.
    // Use the shared fuzzy score to select the best item overall without changing the group display order.
    setSelectedIndex(
      getBestPromptInputSuggestionIndex(filteredSuggestions, activeTrigger?.query ?? null),
    );
  }, [activeSignature, activeTrigger?.query, filteredSuggestions]);

  useEffect(() => {
    setSelectedIndex((current) => {
      if (filteredSuggestions.length === 0) {
        return 0;
      }
      return Math.min(current, filteredSuggestions.length - 1);
    });
  }, [filteredSuggestions.length]);

  useEffect(() => {
    if (!disabled) {
      return;
    }

    setActiveTrigger(null);
    setSelectedIndex(0);
    activeTokenRef.current = null;
  }, [disabled]);

  useEffect(() => {
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState, tags }) => {
      editorState.read(() => {
        // When history navigation restores an entry containing `/`, the slash panel should not reopen,
        // or its COMMAND_PRIORITY_CRITICAL arrow-key handler will consume subsequent history-navigation keys.
        if (!shouldSlashPanelProcessUpdate(tags)) {
          activeTokenRef.current = null;
          setActiveTrigger(null);
          return;
        }

        if (disabled) {
          activeTokenRef.current = null;
          setActiveTrigger(null);
          return;
        }

        const selectionState = getCurrentTextNodeSelection();
        const cursorText = selectionState ?? getTextAroundCursor();
        if (!cursorText) {
          activeTokenRef.current = null;
          dismissedSignatureRef.current = null;
          setActiveTrigger(null);
          return;
        }

        const nextActiveToken = selectionState
          ? reconcileActivePromptInputTokenSnapshot(
              activeTokenRef.current,
              selectionState,
              dirtyElements.size === 0 && dirtyLeaves.size === 0,
            )
          : null;
        const nextActiveTrigger = selectionState
          ? nextActiveToken
          : extractActivePromptInputTrigger(cursorText.textBeforeCursor);
        if (!nextActiveTrigger || nextActiveTrigger.trigger !== "/") {
          activeTokenRef.current = null;
          dismissedSignatureRef.current = null;
          setActiveTrigger(null);
          return;
        }
        activeTokenRef.current = nextActiveToken;

        const nextSignature = getPromptInputTriggerSignature(nextActiveTrigger);
        if (
          dismissedSignatureRef.current !== null &&
          dismissedSignatureRef.current !== nextSignature
        ) {
          dismissedSignatureRef.current = null;
        }

        if (dismissedSignatureRef.current === nextSignature) {
          setActiveTrigger(null);
          return;
        }

        setActiveTrigger((current) => {
          if (
            current?.trigger === nextActiveTrigger.trigger &&
            current.query === nextActiveTrigger.query
          ) {
            return current;
          }

          return nextActiveTrigger;
        });
      });
    });
  }, [disabled, editor]);

  const applySuggestion = useCallback(
    (suggestion: PromptInputSuggestionItem) => {
      const isAppCommand = isAppSlashCommandSuggestion(suggestion);
      editor.update(() => {
        const selectionState = getCurrentTextNodeSelection();
        if (!selectionState) {
          return;
        }

        const snapshotRange = getActivePromptInputTokenReplacementRange(
          activeTokenRef.current,
          selectionState,
        );
        const activeSlashTrigger = snapshotRange
          ? activeTokenRef.current
          : extractActivePromptInputTrigger(selectionState.textBeforeCursor);
        if (!activeSlashTrigger || activeSlashTrigger.trigger !== "/") {
          return;
        }

        const tokenStart =
          snapshotRange?.start ?? selectionState.cursorOffset - activeSlashTrigger.query.length - 1;
        const tokenEnd =
          snapshotRange?.end ??
          selectionState.cursorOffset +
            getActivePromptInputTokenTailLength(
              activeSlashTrigger,
              selectionState.textAfterCursor,
              suggestion.value,
            );
        selectionState.selection.setTextNodeRange(
          selectionState.node,
          tokenStart,
          selectionState.node,
          tokenEnd,
        );

        if (isAppCommand) {
          // App-level commands that run on selection only remove the `/xxx` token from the input; they do not insert a mention or send a message.
          selectionState.selection.removeText();
          return;
        }

        const mentionNode = $createPromptMentionNode(buildSlashApplyMentionPayload(suggestion));
        const trailingWhitespace = $createTextNode(" ");
        selectionState.selection.insertNodes([mentionNode, trailingWhitespace]);
        trailingWhitespace.selectEnd();
      });

      dismissedSignatureRef.current = null;
      activeTokenRef.current = null;
      setActiveTrigger(null);
      setSelectedIndex(0);
      if (isAppCommand) {
        appCommands
          ?.find((command) => normalizeSlashCommandValue(command.value) === suggestion.value)
          ?.run();
        return;
      }
      requestAnimationFrame(() => {
        editor.focus();
      });
    },
    [appCommands, editor],
  );

  const selectSuggestion = useCallback(
    (index: number) => {
      const suggestion = filteredSuggestions[index];
      if (!suggestion) {
        return false;
      }

      applySuggestion(suggestion);
      return true;
    },
    [applySuggestion, filteredSuggestions],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (filteredSuggestions.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => Math.min(prev + 1, filteredSuggestions.length - 1));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (filteredSuggestions.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!selectSuggestion(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (!selectSuggestion(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        event?.preventDefault();
        event?.stopPropagation();

        // If Escape records only the query and does not distinguish `/` from `@`, matching queries from the two triggers can suppress each other's panels.
        // Store a combined trigger + query signature here and reopen only after the current token actually changes, preventing the panel from immediately returning after it closes.
        dismissedSignatureRef.current = activeSignatureRef.current;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        dismissedSignatureRef.current = null;
        activeTokenRef.current = null;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      unregisterDown();
      unregisterUp();
      unregisterEnter();
      unregisterTab();
      unregisterEscape();
      unregisterBlur();
    };
  }, [editor, filteredSuggestions.length, isOpen, selectSuggestion, selectedIndex]);

  const panelTitle = intl.formatMessage({ id: "chat.slash.title" });
  const hasActiveQuery = (activeTrigger?.query ?? "").trim().length > 0;
  const panelDescription = hasActiveQuery
    ? ""
    : intl.formatMessage({ id: "chat.slash.searchHint" });

  const panelSections = useSlashCommandMentionPanelSections(
    intl,
    commands.length,
    filteredCommandSuggestions,
    filteredSkillSuggestions,
    skillsLoading,
    skillsError,
    filteredSubagentSuggestions,
    subagentsLoading,
    subagentsError,
  );

  if (!isOpen || !container) {
    return null;
  }

  return createPortal(
    <MentionPanel
      title={panelTitle}
      description={panelDescription}
      trigger="/"
      sections={panelSections}
      emptyText=""
      selectedIndex={selectedIndex}
      hasActiveQuery={hasActiveQuery}
      onSelect={selectSuggestion}
    />,
    container,
  );
}
