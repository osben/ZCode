/**
 * V4 Composer toolbar keyboard shortcuts (composer parity).
 *
 * Implemented as pure logic (no store/protocol dependencies; consumes only config catalog options and callbacks).
 * Bound callbacks modify only Composer:
 * - Ctrl+M        → open the model menu (increment openRequestKey for ModelConfigSelect)
 * - Ctrl+Shift+M  → cycle the mode for the next Submission
 * - Ctrl+T        → cycle the reasoning level for the next Submission
 *
 * These three shortcuts are now command-table commands (openModelMenu / cycleSessionMode /
 * cycleThoughtLevel, global window scope). Key matching reads the effective keymap and can be changed in Settings;
 * default keys retain their existing behavior.
 */
import { useEffect, useRef } from "react";
import type { ShortcutCommandId, ZCodeConfigOption } from "@zcode/shared";
import {
  isShortcutRecordingActive,
  matchesShortcutBinding,
  type EffectiveShortcutBindings,
} from "@/shortcuts/bindings.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { logger } from "@/logger.js";

type ChatToolbarShortcutKey = "m" | "ctrlShiftM" | "t" | null;

/** Resolves a toolbar shortcut slot by config category. */
function getChatToolbarShortcutKey(
  category: ZCodeConfigOption["category"],
): ChatToolbarShortcutKey {
  switch (category) {
    case "model":
      return "m";
    case "mode":
      return "ctrlShiftM";
    case "thought_level":
      return "t";
    default:
      return null;
  }
}

/** Computes the next cyclic select value (used to cycle modes). */
export function getNextConfigSelectValue(
  option: Pick<ZCodeConfigOption, "type" | "currentValue" | "options">,
): string | null {
  if (option.type !== "select" || !option.options?.length) {
    return null;
  }

  const currentValue = String(option.currentValue);
  const currentIndex = option.options.findIndex((candidate) => candidate.value === currentValue);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % option.options.length;

  return option.options[nextIndex]?.value ?? null;
}

interface ToolbarShortcutKeyboardEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  repeat: boolean;
  isComposing: boolean;
}

interface ToolbarShortcutState {
  hasAnyOption: boolean;
  toolbarDisabled: boolean;
  modelMenuDisabled: boolean;
  modelOption?: ZCodeConfigOption;
  modeOption?: ZCodeConfigOption;
  thoughtOption?: ZCodeConfigOption;
}

type ToolbarShortcutAction = "openModelMenu" | "cycleSessionMode" | "cycleThoughtLevel";

/**
 * Resolves toolbar actions from the effective keymap (toolbar shortcuts are now configurable commands).
 * Key matching uses the core command table + matcher with exact modifier matching, consistent with the old matchesCtrlShortcut behavior
 * for "Ctrl+m" / "Ctrl+Shift+m" / "Ctrl+t". Existing option ownership and disabled gates remain unchanged. The caller passes the event and effective keymap, so this pure function is independently testable.
 */
function resolveToolbarShortcutAction(
  event: ToolbarShortcutKeyboardEvent,
  effective: EffectiveShortcutBindings,
  {
    hasAnyOption,
    toolbarDisabled,
    modelMenuDisabled,
    modelOption,
    modeOption,
    thoughtOption,
  }: ToolbarShortcutState,
): ToolbarShortcutAction | null {
  if (
    !hasAnyOption ||
    toolbarDisabled ||
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing
  ) {
    return null;
  }

  const candidates: ReadonlyArray<{
    action: ToolbarShortcutAction;
    commandId: ShortcutCommandId;
    expectedKey: ChatToolbarShortcutKey;
    option?: ZCodeConfigOption;
    disabled?: boolean;
  }> = [
    {
      action: "openModelMenu",
      commandId: "openModelMenu",
      expectedKey: "m",
      option: modelOption,
      disabled: modelMenuDisabled,
    },
    {
      action: "cycleSessionMode",
      commandId: "cycleSessionMode",
      expectedKey: "ctrlShiftM",
      option: modeOption,
    },
    {
      action: "cycleThoughtLevel",
      commandId: "cycleThoughtLevel",
      expectedKey: "t",
      option: thoughtOption,
    },
  ];

  for (const candidate of candidates) {
    if (candidate.disabled) {
      continue;
    }
    if (
      !candidate.option ||
      getChatToolbarShortcutKey(candidate.option.category) !== candidate.expectedKey
    ) {
      continue;
    }
    for (const binding of effective[candidate.commandId] ?? []) {
      if (matchesShortcutBinding(event, binding)) {
        return candidate.action;
      }
    }
  }

  return null;
}

export function useToolbarShortcutBindings(params: {
  hasAnyOption: boolean;
  toolbarDisabled: boolean;
  modelMenuDisabled: boolean;
  modelOption?: ZCodeConfigOption;
  modeOption?: ZCodeConfigOption;
  thoughtOption?: ZCodeConfigOption;
  onOpenModelMenu: () => void;
  /** Ctrl+Shift+M: quickly cycle session mode in option order without opening a menu, following the thought-level shortcut. */
  onCycleSessionMode: () => void;
  /** Ctrl+T: keep the quick thought-level switch independent of the default select-menu interaction. */
  onCycleThoughtLevel: () => void;
}) {
  const {
    hasAnyOption,
    toolbarDisabled,
    modelMenuDisabled,
    modelOption,
    modeOption,
    thoughtOption,
    onOpenModelMenu,
    onCycleSessionMode,
    onCycleThoughtLevel,
  } = params;
  // Toolbar shortcuts are command-table commands now and read the effective keymap, so Settings rebinding takes effect immediately.
  const effectiveBindings = useEffectiveShortcutBindings();
  const effectiveRef = useRef(effectiveBindings);
  effectiveRef.current = effectiveBindings;

  useEffect(() => {
    if (!hasAnyOption) {
      return;
    }

    function handleWindowKeydown(event: KeyboardEvent) {
      // During key recording, the recorder owns keyboard input exclusively. This listener registers before the recorder (same capture phase);
      // without this early return, key previews during recording would trigger toolbar actions.
      if (isShortcutRecordingActive()) {
        return;
      }
      // On Windows/Linux, useAppKeyboard already binds Cmd/Ctrl+P to "Search
      // Files," conflicting with the old toolbar ⌃P shortcut. Mode cycling now uses Ctrl+Shift+M and still respects
      // defaultPrevented to avoid duplicate handling by other capture-phase shortcuts.
      const state = {
        hasAnyOption,
        toolbarDisabled,
        modelMenuDisabled,
        modelOption,
        modeOption,
        thoughtOption,
      };
      const action = resolveToolbarShortcutAction(event, effectiveRef.current, state);
      if (!action) {
        // Decouple diagnostic logging from the effective keymap—log "model menu did not open"
        // only when the pressed key is actually bound to openModelMenu (after rebinding, the old key should not log incorrectly, and failures on the new key are not silent).
        const openModelMenuBound = (effectiveRef.current.openModelMenu ?? []).some((binding) =>
          matchesShortcutBinding(event, binding),
        );
        if (openModelMenuBound) {
          logger.debug("[V4ComposerToolbar] 模型菜单热键未打开模型菜单", {
            hasModelOption: Boolean(modelOption),
            shortcutKey: getChatToolbarShortcutKey(modelOption?.category),
            modelMenuDisabled,
          });
        }
        return;
      }

      event.preventDefault();
      if (action === "openModelMenu") {
        logger.debug("[V4ComposerToolbar] Ctrl+M 打开模型菜单");
        onOpenModelMenu();
        return;
      }

      if (action === "cycleSessionMode") {
        onCycleSessionMode();
        return;
      }

      if (action === "cycleThoughtLevel") {
        onCycleThoughtLevel();
      }
    }

    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, [
    hasAnyOption,
    toolbarDisabled,
    modelMenuDisabled,
    modeOption,
    modelOption,
    onOpenModelMenu,
    onCycleSessionMode,
    onCycleThoughtLevel,
    thoughtOption,
  ]);
}
