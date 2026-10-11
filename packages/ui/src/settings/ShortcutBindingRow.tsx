import { Keyboard, Pencil, Trash2 } from "lucide-react";
import type { ShortcutCommandEntry, ShortcutCommandId } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Kbd, KbdGroup } from "@/components/ui/kbd.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatShortcutBindingLabelParts } from "@/shortcuts/label.js";

export interface RecordingState {
  commandId: ShortcutCommandId;
  /** Recording mode: replace = replace one binding (bindingIndex points to an existing entry; null = record the first unassigned slot); add = append a binding to the command. */
  mode: "replace" | "add";
  /** Target index in replace mode; null in add mode. */
  bindingIndex: number | null;
  /** Live preview label while recording; null means there is not yet a complete combination. */
  preview: string | null;
  /** Conflict/invalid hint (localized copy), shown in red. */
  error: string | null;
  /** Binding awaiting confirmation because another app command uses it; "Bind anyway" takes it over after confirmation (system-reserved keys have no confirmation path). */
  conflictBinding: string | null;
}

interface ShortcutBindingRowProps {
  entry: ShortcutCommandEntry;
  /** Localized command name (formatted by the main component). */
  commandLabel: string;
  bindings: readonly string[];
  /** Whether the command has a user override (when true, keycaps use the brand color to indicate customization). */
  isOverridden: boolean;
  isRecording: boolean;
  recording: RecordingState | null;
  /** Web menu-channel command: disable recording (the root fallback listener always consumes the default key). */
  menuChannelUnavailable: boolean;
  /** Replace one binding (index = position in the effective list; null = record the first unassigned slot). */
  onRecord: (bindingIndex: number | null) => void;
  onSteal: (binding: string) => void;
  /** Clear all bindings = unassigned (explicit empty array; do not fall back to defaults). */
  onClearAll: () => void;
}

/**
 * Command row in shortcut settings: the command name in the left column is vertically centered across all bindings; the right column shows
 * that command's bindings—one per row, with per-key keycaps + pencil (click to record a replacement for that entry). Recording is embedded at the corresponding
 * entry's position. Adding/removing individual bindings is not supported yet (replace only); the action column has a trash button to clear all.
 */
export function ShortcutBindingRow({
  entry,
  commandLabel,
  bindings,
  isOverridden,
  isRecording,
  recording,
  menuChannelUnavailable,
  onRecord,
  onSteal,
  onClearAll,
}: ShortcutBindingRowProps) {
  const { intl } = useZCodeIntl();
  const conflictBinding = isRecording ? recording?.conflictBinding : null;

  // Inline recording block: appears in place of the entry being replaced / the appended entry (the preview kbd captures focus).
  function renderRecorder() {
    return (
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2">
          <Keyboard className="size-4 text-foreground-subtle" />
          <kbd
            ref={(el) => {
              // Capture focus as soon as recording starts to pull it away from editable elements (such as the search box above).
              // Otherwise a CJK IME may consume Shift+letter as composition input, and the recorder sees only
              // isComposing/229 noise events, appearing unable to recognize Shift combinations.
              el?.focus();
            }}
            tabIndex={-1}
            className="w-fit rounded-md bg-surface px-2 py-1 font-mono text-ui-sm outline-none"
          >
            {recording?.preview ?? intl.formatMessage({ id: "settings.shortcuts.recording" })}
          </kbd>
        </span>
        {recording?.error ? (
          <span
            className="text-ui-sm text-destructive"
            data-testid={`settings-shortcut-error-${entry.id}`}
          >
            {recording.error}
          </span>
        ) : (
          <span className="text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "settings.shortcuts.recordingHint" })}
          </span>
        )}
        {conflictBinding ? (
          <Button
            variant="outline"
            size="xs"
            className="w-fit"
            data-testid={`settings-shortcut-steal-${entry.id}`}
            onClick={() => onSteal(conflictBinding)}
          >
            {intl.formatMessage({ id: "settings.shortcuts.stealConfirm" })}
          </Button>
        ) : null}
      </span>
    );
  }

  /**
   * Single-binding row: per-key keycaps (same as shadcn Kbd, centered h-5/min-w-5, symbols and letters use the same size) +
   * pencil (clicking the keycap or pencil replaces this entry). Keycaps override only text color (custom = brand color), not bg:
   * bg-inherit would override Kbd's base bg-muted through cn/tailwind-merge while the ancestor chain is transparent,
   * making the chip background disappear.
   */
  function renderBinding(binding: string, index: number) {
    return (
      <span key={binding} className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={menuChannelUnavailable}
          className="w-fit rounded-lg px-0 py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-60"
          aria-label={intl.formatMessage(
            { id: "settings.shortcuts.rebindAria" },
            { command: commandLabel },
          )}
          data-testid={`settings-shortcut-bind-${entry.id}-${index}`}
          onClick={() => onRecord(index)}
        >
          <KbdGroup>
            {formatShortcutBindingLabelParts(binding).map((part, partIndex) => (
              <Kbd key={`${part}-${partIndex}`} className={isOverridden ? "text-brand" : undefined}>
                {part}
              </Kbd>
            ))}
          </KbdGroup>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={menuChannelUnavailable}
          aria-label={intl.formatMessage(
            { id: "settings.shortcuts.rebindAria" },
            { command: commandLabel },
          )}
          data-testid={`settings-shortcut-edit-${entry.id}-${index}`}
          onClick={() => onRecord(index)}
        >
          <Pencil className="size-3.5" />
        </Button>
      </span>
    );
  }

  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px_72px] items-center border-t border-border px-4 py-3 text-ui-base"
      data-testid={`settings-shortcut-row-${entry.id}`}
    >
      <span className="flex min-w-0 items-center">
        <span className="truncate">{commandLabel}</span>
      </span>
      <span className="flex min-w-0 flex-col items-start gap-1.5">
        {bindings.map((binding, index) =>
          isRecording && recording?.mode === "replace" && recording.bindingIndex === index
            ? renderRecorder()
            : renderBinding(binding, index),
        )}
        {/* For an unassigned command, record the first binding; when bindings is empty, recording
            fills the whole shortcut cell. */}
        {isRecording && recording?.mode === "replace" && recording?.bindingIndex === null
          ? renderRecorder()
          : null}
        {bindings.length === 0 && !isRecording ? (
          <button
            type="button"
            disabled={menuChannelUnavailable}
            className="w-fit rounded-lg px-0 py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label={intl.formatMessage(
              { id: "settings.shortcuts.rebindAria" },
              { command: commandLabel },
            )}
            data-testid={`settings-shortcut-bind-${entry.id}-unassigned`}
            onClick={() => onRecord(null)}
          >
            <Kbd>{intl.formatMessage({ id: "settings.shortcuts.notSet" })}</Kbd>
          </button>
        ) : null}
      </span>
      {/* Show scope in its own column: global applies everywhere; composer applies only in the chat
            input. */}
      <span
        className="text-ui-sm text-foreground-subtle"
        data-testid={`settings-shortcut-scope-${entry.id}`}
      >
        {entry.scope === "composer"
          ? intl.formatMessage({ id: "settings.shortcuts.scopeComposer" })
          : intl.formatMessage({ id: "settings.shortcuts.scopeGlobal" })}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={intl.formatMessage(
          { id: "settings.shortcuts.clearAria" },
          { command: commandLabel },
        )}
        // Disable recording for Web menu-channel commands too: the root fallback listener always consumes their default key,
        // so clearing them to unassigned would not actually disable them and would create a split state where the UI says unassigned but the shortcut still fires.
        disabled={menuChannelUnavailable || bindings.length === 0}
        onClick={onClearAll}
        data-testid={`settings-shortcut-clear-${entry.id}`}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}
