import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ShortcutCommandId } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { checkShortcutBindingConflict, isSamePhysicalBinding } from "@/shortcuts/conflicts.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import { recordShortcutBinding, type EffectiveShortcutBindings } from "@/shortcuts/bindings.js";
import type { RecordingState } from "./ShortcutBindingRow.js";

interface UseShortcutRecordingOptions {
  recording: RecordingState | null;
  setRecording: Dispatch<SetStateAction<RecordingState | null>>;
  /** Effective binding table (Section has already resolved overrides). */
  effective: EffectiveShortcutBindings;
  overrides: Record<string, readonly string[]> | undefined;
  isDesktop: boolean;
  /** Backspace during recording: restore default (preflight logic in Section). */
  clearBinding: (commandId: ShortcutCommandId) => void;
  appendBinding: (commandId: ShortcutCommandId, binding: string) => void;
  replaceBindingAt: (commandId: ShortcutCommandId, bindingIndex: number, binding: string) => void;
}

/**
 * Capture keyboard events while recording via window keydown capture. Escape cancels; Backspace restores the default;
 * all other keys go to the core recorder. Persist according to RecordingState.mode: add → append a binding; replace → replace
 * the binding at bindingIndex (null = record the first binding for an unassigned placeholder row, equivalent to append).
 * Reject physical duplicates for the same command at the recording entry point (add compares all entries; replace skips the target row).
 */
export function useShortcutRecording({
  recording,
  setRecording,
  effective,
  overrides,
  isDesktop,
  clearBinding,
  appendBinding,
  replaceBindingAt,
}: UseShortcutRecordingOptions): void {
  const { intl } = useZCodeIntl();

  useEffect(() => {
    if (!recording) {
      return;
    }
    function handleRecordingKeydown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      setRecording((current) => {
        if (!current) {
          return current;
        }
        if (event.key === "Escape") {
          return null;
        }
        if (event.key === "Backspace") {
          clearBinding(current.commandId);
          return null;
        }

        const result = recordShortcutBinding(event);
        if (result.kind === "pending") {
          // Stale conflict/invalid messages make users think the recorder is not listening for new keys — clear them as soon as a modifier is pressed,
          // so “press a second combination directly after a conflict” visibly works (the recorder was already listening).
          if (
            current.preview === null &&
            current.error === null &&
            current.conflictBinding === null
          ) {
            return current;
          }
          return { ...current, preview: null, error: null, conflictBinding: null };
        }
        if (result.kind === "invalid") {
          return {
            ...current,
            preview: null,
            conflictBinding: null,
            error: intl.formatMessage({
              id:
                result.reason === "no-modifier"
                  ? "settings.shortcuts.invalidNoModifier"
                  : "settings.shortcuts.invalidKey",
            }),
          };
        }

        // Physically equivalent duplicate for the same command: add compares against all active bindings; replace skips the
        // target binding being replaced. The same key combination has no meaning twice for one command, so mark it as an error and reject.
        const sameCommandBindings = effective[current.commandId] ?? [];
        const duplicate = sameCommandBindings.some((binding, index) =>
          current.mode === "replace" && index === current.bindingIndex
            ? false
            : isSamePhysicalBinding(binding, result.binding),
        );
        if (duplicate) {
          return {
            ...current,
            preview: formatShortcutBindingLabel(result.binding),
            conflictBinding: null,
            error: intl.formatMessage({ id: "settings.shortcuts.duplicateBinding" }),
          };
        }

        // Web menu-channel commands are not configurable, but the root fallback listener still consumes their default keys; reject reserved keys instead of stealing them.
        const conflict = checkShortcutBindingConflict(
          current.commandId,
          result.binding,
          overrides,
          {
            menuChannelReserved: !isDesktop,
          },
        );
        if (conflict) {
          return {
            ...current,
            preview: formatShortcutBindingLabel(result.binding),
            // Reject system-reserved keys directly (no confirmation flow); for app-command conflicts, show the current owner and allow a second confirmation to take over.
            conflictBinding: conflict.kind === "occupied" ? result.binding : null,
            error:
              conflict.kind === "reserved"
                ? intl.formatMessage({ id: "settings.shortcuts.conflictReserved" })
                : intl.formatMessage(
                    { id: "settings.shortcuts.conflictOccupied" },
                    {
                      command:
                        conflict.ownerCommandId !== undefined
                          ? intl.formatMessage({
                              id: `settings.shortcuts.command.${conflict.ownerCommandId}`,
                            })
                          : "",
                    },
                  ),
          };
        }

        if (current.mode === "add" || current.bindingIndex === null) {
          appendBinding(current.commandId, result.binding);
        } else {
          replaceBindingAt(current.commandId, current.bindingIndex, result.binding);
        }
        return null;
      });
    }

    window.addEventListener("keydown", handleRecordingKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleRecordingKeydown, true);
    };
  }, [
    appendBinding,
    clearBinding,
    effective,
    intl,
    isDesktop,
    overrides,
    recording,
    replaceBindingAt,
    setRecording,
  ]);
}
