import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import {
  SHORTCUT_COMMANDS,
  getDefaultShortcutBindings,
  type ShortcutCommandId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  buildShortcutOverridesAfterAppend,
  buildShortcutOverridesAfterSteal,
  buildShortcutOverridesWithBindingAt,
  checkShortcutBindingConflict,
  isSamePhysicalBinding,
} from "@/shortcuts/conflicts.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import {
  resolveEffectiveShortcutBindings,
  setShortcutRecordingActive,
} from "@/shortcuts/bindings.js";
import { ShortcutBindingRow, type RecordingState } from "@/settings/ShortcutBindingRow.js";
import { ShortcutSearchBar } from "@/settings/ShortcutSearchBar.js";
import { useShortcutKeySearch } from "@/settings/useShortcutKeySearch.js";
import { useShortcutRecording } from "@/settings/useShortcutRecording.js";

/**
 * Keyboard shortcut settings: read-only command table + key recording + conflict handling.
 * Only shortcutBindings override data is written; key semantics (matching/recording/conflicts/rebinding) all go through the shortcuts core.
 * System-reserved keys are rejected directly; conflicts with app commands identify the owner and allow a confirmed rebind.
 * Multiple bindings per row: one command per row, with keycaps stacked vertically in the binding column; each can be replaced or removed,
 * and the command-level “+” adds another. Physically equivalent duplicates for one command are rejected during recording.
 */
export function ShortcutSettingsSection({ isDesktop = false }: { isDesktop?: boolean }) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const platform = usePlatform();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const keySearch = useShortcutKeySearch();
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const overrides = settings?.shortcutBindings;
  const effective = useMemo(() => resolveEffectiveShortcutBindings(overrides), [overrides]);
  const commandLabel = useCallback(
    (commandId: ShortcutCommandId) =>
      intl.formatMessage({ id: `settings.shortcuts.command.${commandId}` }),
    [intl],
  );

  const visibleCommands = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    // Use a local variable because TypeScript cannot preserve keySearch.binding's non-null narrowing inside the some callback closure.
    const keyBinding = keySearch.binding;
    return SHORTCUT_COMMANDS.filter((entry) => {
      // Keep these shortcuts registered and included in conflict detection, but do not show them in the user-visible list.
      if (entry.id === "openOnboarding" || entry.id === "toggleInterfaceMode") return false;
      const matchesText =
        !keyword ||
        entry.id.toLowerCase().includes(keyword) ||
        commandLabel(entry.id).toLowerCase().includes(keyword);
      // Filter keys using the physical-equivalence rules used by conflict detection (win Ctrl+m ≡ CmdOrCtrl+m),
      // so the filter and “which command owns this shortcut” warnings use the same table.
      const matchesKey =
        keyBinding === null ||
        (effective[entry.id] ?? []).some((binding) => isSamePhysicalBinding(binding, keyBinding));
      return matchesText && matchesKey;
    });
  }, [commandLabel, effective, keySearch.binding, query]);

  const persistBindings = useCallback(
    async (next: Record<string, string[]>) => {
      if (savingRef.current) {
        return;
      }
      // 原因：仅用 ref 拦截会静默丢弃后续点击；保存态同步禁用入口，直到权威快照刷新完成。
      savingRef.current = true;
      setSaving(true);
      setSaveFailed(false);
      setRecording(null);
      try {
        await update({ shortcutBindings: next });
      } catch (error) {
        logger.error("[shortcuts] 保存快捷键绑定失败", { error: String(error) });
        setSaveFailed(true);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [update],
  );

  /** Append an entry (the placeholder row uses this for its first recording too; an empty effective list is equivalent to writing the first entry). */
  const appendBinding = useCallback(
    (commandId: ShortcutCommandId, binding: string) => {
      void persistBindings(buildShortcutOverridesAfterAppend(overrides, commandId, binding));
    },
    [overrides, persistBindings],
  );

  /** Replace the bindingIndex-th entry in the effective list (group replacement semantics; write the complete effective list). */
  const replaceBindingAt = useCallback(
    (commandId: ShortcutCommandId, bindingIndex: number, binding: string) => {
      void persistBindings(
        buildShortcutOverridesWithBindingAt(overrides, commandId, bindingIndex, binding),
      );
    },
    [overrides, persistBindings],
  );

  /**
   * After confirmation, take over the shortcut: write the new key to the target command using the row-level semantics from recording (replace a specific entry / append
   * the first entry for an unassigned command), and remove the conflicting key from the owning command. Taking over changes only conflict handling, not the row-level action
   * the user originally chose (taking over a multi-binding command must not silently delete its other bindings).
   */
  const stealBinding = useCallback(
    (commandId: ShortcutCommandId, binding: string) => {
      const next = buildShortcutOverridesAfterSteal(overrides, commandId, binding, {
        mode: recording?.mode,
        bindingIndex: recording?.bindingIndex,
      });
      void persistBindings(next);
    },
    [overrides, persistBindings, recording],
  );

  /** “Clear” (trash icon in the actions column) clears all bindings for the command, leaving it unassigned: write an explicit empty array, not the default
   * (including removing the menu-channel accelerator). This differs from “Restore default” on Backspace while recording. */
  const clearAllBindings = useCallback(
    (commandId: ShortcutCommandId) => {
      void persistBindings({ ...overrides, [commandId]: [] });
    },
    [overrides, persistBindings],
  );

  /**
   * “Restore default” with Backspace while recording removes the override. If the default key is used by another command in the same scope
   * (including physical equivalents such as win Ctrl+m ≡ CmdOrCtrl+m), show a conflict and do not persist. Restoring defaults and recording are two entry points to the same
   * one-shortcut-per-command invariant; per user intent, warn only and do not automatically clear the other command's binding.
   */
  const clearBinding = useCallback(
    (commandId: ShortcutCommandId) => {
      if (overrides?.[commandId] === undefined) {
        return;
      }
      const defaultBinding = getDefaultShortcutBindings(commandId)[0];
      if (defaultBinding) {
        const conflict = checkShortcutBindingConflict(commandId, defaultBinding, overrides, {
          menuChannelReserved: !isDesktop,
        });
        if (conflict?.kind === "occupied" && conflict.ownerCommandId) {
          toast(
            intl.formatMessage(
              { id: "settings.shortcuts.clearConflict" },
              { command: commandLabel(conflict.ownerCommandId) },
            ),
          );
          return;
        }
      }
      const next = { ...overrides };
      delete next[commandId];
      void persistBindings(next);
    },
    [overrides, persistBindings, isDesktop, intl, commandLabel],
  );

  // “Restore all defaults” is destructive (clears every custom shortcut override); reuse the shared Promise-based confirmation dialog to prevent accidental activation.
  const requestConfirmation = useConfirmDialogStore((state) => state.requestConfirmation);
  const resetAll = useCallback(async () => {
    if (!overrides || Object.keys(overrides).length === 0) {
      return;
    }
    const confirmed = await requestConfirmation({
      confirmVariant: "destructive",
      title: intl.formatMessage({ id: "settings.shortcuts.resetAllConfirmTitle" }),
      description: intl.formatMessage({ id: "settings.shortcuts.resetAllConfirmDescription" }),
    });
    if (confirmed) {
      void persistBindings({});
    }
  }, [overrides, persistBindings, requestConfirmation, intl]);

  // Suppress commands while recording: the recording listener registers after useAppKeyboard's capture listener (listeners in the same phase run in registration order).
  // Without suppression, the original command fires before the recorded shortcut and rebinding never succeeds.
  // The renderer channel uses an internal marker to bypass useAppKeyboard; the menu channel removes the menu accelerator in main
  // (on macOS, the system menu captures keys before the renderer and preventDefault cannot stop it).
  // Armed key search reuses the same keyboard exclusivity, capturing shortcuts on explicit intent without triggering commands.
  const keyboardExclusive = recording !== null || keySearch.armed;
  useEffect(() => {
    if (!keyboardExclusive) {
      return;
    }
    setShortcutRecordingActive(true);
    platform.setShortcutRecordingActive?.(true);
    return () => {
      setShortcutRecordingActive(false);
      platform.setShortcutRecordingActive?.(false);
    };
  }, [keyboardExclusive, platform]);

  useShortcutRecording({
    recording,
    setRecording,
    effective,
    overrides,
    isDesktop,
    clearBinding,
    appendBinding,
    replaceBindingAt,
  });

  const recordingCommandId = recording?.commandId ?? null;

  return (
    <div className="min-w-0 space-y-6" aria-busy={saving} data-testid="settings-shortcuts-section">
      <ShortcutSearchBar
        query={query}
        onQueryChange={setQuery}
        keySearch={keySearch}
        // Mutually exclusive with inline recording: cancel any active recording before arming so two window capture listeners do not coexist.
        onArmKeySearch={() => setRecording(null)}
        actions={
          <Button
            variant="outline"
            onClick={resetAll}
            disabled={saving || !settings || !overrides || Object.keys(overrides).length === 0}
            data-testid="settings-shortcut-reset-all"
          >
            <RotateCcw className="size-3.5" />
            {intl.formatMessage({ id: saving ? "common.saving" : "settings.shortcuts.resetAll" })}
          </Button>
        }
      />

      {saveFailed ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
          data-testid="settings-shortcut-save-error"
        >
          {intl.formatMessage({ id: "settings.shortcuts.saveFailed" })}
        </div>
      ) : null}
      <div className="min-w-0 rounded-xl border border-card-border">
        <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px_40px] rounded-t-xl bg-surface sm:grid px-4 py-3 text-ui-sm text-foreground-subtle">
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderCommand" })}</span>
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderBinding" })}</span>
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderScope" })}</span>
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderActions" })}</span>
        </div>
        {visibleCommands.map((entry) => (
          <ShortcutBindingRow
            key={entry.id}
            entry={entry}
            commandLabel={commandLabel(entry.id)}
            bindings={effective[entry.id] ?? []}
            saving={saving || !settings}
            isOverridden={overrides?.[entry.id] !== undefined}
            isRecording={recordingCommandId === entry.id}
            recording={recording}
            menuChannelUnavailable={entry.channel === "menu" && !isDesktop}
            onRecord={(bindingIndex) => {
              // Inline recording and armed key search are mutually exclusive; two window capture listeners would consume each other's keys.
              keySearch.disarm();
              setRecording({
                commandId: entry.id,
                mode: "replace",
                bindingIndex,
                preview: null,
                error: null,
                conflictBinding: null,
              });
            }}
            onSteal={(binding) => {
              stealBinding(entry.id, binding);
              setRecording(null);
            }}
            onClearAll={() => clearAllBindings(entry.id)}
          />
        ))}
        {visibleCommands.length === 0 ? (
          <div
            className="border-t border-border px-4 py-8 text-center text-ui-sm text-foreground-subtle"
            data-testid="settings-shortcut-search-empty"
          >
            {keySearch.binding !== null
              ? intl.formatMessage(
                  { id: "settings.shortcuts.keySearchEmpty" },
                  { keys: formatShortcutBindingLabel(keySearch.binding) },
                )
              : intl.formatMessage({ id: "settings.shortcuts.searchEmpty" })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
