import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { UpdateStatusDialog } from "@/UpdateStatusDialog.js";
import { formatUpdateReleaseDate, getLocalizedUpdateReleaseNotes } from "@/updateReleaseNotes.js";
import {
  deriveUpdateStatusViewModel,
  isUpdateActionCompleted,
  type UpdateActionInFlight,
  type UpdateStatusViewModel,
} from "@/updateStatusModel.js";

export function UpdateStatusDialogController({
  platform,
  version,
  updateState,
  open,
  onOpenChange,
  edgeToEdge = false,
  showOverlay = true,
}: {
  platform: IPlatformService;
  version: string | null;
  updateState: UpdateStatePayload | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  edgeToEdge?: boolean;
  showOverlay?: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const [autoDownloadAndInstallUpdates, setAutoDownloadAndInstallUpdates] = useState(false);
  const [updateActionInFlight, setUpdateActionInFlightState] = useState<UpdateActionInFlight>(null);
  const updateActionInFlightRef = useRef<typeof updateActionInFlight>(null);
  const releaseNotesCacheRef = useRef(
    new Map<
      string,
      {
        releaseDateLabel: string | null;
        releaseNotes: { title: string; markdown: string };
      }
    >(),
  );
  const setUpdateActionInFlight = useCallback((nextAction: typeof updateActionInFlight) => {
    updateActionInFlightRef.current = nextAction;
    setUpdateActionInFlightState(nextAction);
  }, []);
  const updateStatusViewModel = deriveUpdateStatusViewModel({
    legacyReadyVersion: version,
    updateState,
  });
  const lastVisibleUpdateStatusViewModelSelection = useRef<UpdateStatusViewModel | null>(null);
  const renderedUpdateStatusViewModel =
    updateStatusViewModel.displayVersion || updateActionInFlight === null
      ? updateStatusViewModel
      : (lastVisibleUpdateStatusViewModelSelection.current ?? updateStatusViewModel);
  const {
    dialogPhase,
    displayVersion,
    progressLabel,
    progressValue,
    releaseNotesPayload: updateReleaseNotesPayload,
    skippableVersion,
  } = renderedUpdateStatusViewModel;
  const localizedUpdateReleaseNotes = getLocalizedUpdateReleaseNotes(
    updateReleaseNotesPayload,
    locale,
  );
  const formattedReleaseDate = formatUpdateReleaseDate(
    updateReleaseNotesPayload?.releaseDate,
    locale,
  );
  const releaseNotesCacheKey = displayVersion ? `${locale}:${displayVersion}` : null;

  useEffect(() => {
    if (!updateStatusViewModel.displayVersion) {
      return;
    }

    // After “Download update” is clicked, actual download progress depends on asynchronous broadcasts from main.
    // If a transient state such as checking/idle arrives without a version, the entry point must not return null
    // and unmount the open dialog; while the command is active, reuse the last visible model until a progress state arrives.
    lastVisibleUpdateStatusViewModelSelection.current = updateStatusViewModel;
  }, [updateStatusViewModel]);

  useEffect(() => {
    let disposed = false;

    const refreshAutoUpdatePreferences = () => {
      void platform
        .getAutoUpdatePreferences?.()
        .then((preferences) => {
          if (!disposed) {
            setAutoDownloadAndInstallUpdates(preferences.autoDownloadAndInstallUpdates);
          }
        })
        .catch(() => {
          if (!disposed) {
            setAutoDownloadAndInstallUpdates(false);
          }
        });
    };

    refreshAutoUpdatePreferences();
    const disposeSettingsChanged =
      platform.onSettingsChanged?.(refreshAutoUpdatePreferences) ?? (() => {});

    return () => {
      disposed = true;
      disposeSettingsChanged();
    };
  }, [platform]);

  useEffect(() => {
    if (!releaseNotesCacheKey || !localizedUpdateReleaseNotes) {
      return;
    }

    // Release notes are hidden during download, but electron-updater's update-downloaded
    // event reliably includes only version on some platforms. Cache the current version's notes so they can be restored after download,
    // even if the ready state has no releaseNotes.
    releaseNotesCacheRef.current.set(releaseNotesCacheKey, {
      releaseDateLabel: formattedReleaseDate,
      releaseNotes: localizedUpdateReleaseNotes,
    });
    if (releaseNotesCacheRef.current.size > 8) {
      const oldestCacheKey = releaseNotesCacheRef.current.keys().next().value;
      if (oldestCacheKey) {
        releaseNotesCacheRef.current.delete(oldestCacheKey);
      }
    }
  }, [formattedReleaseDate, localizedUpdateReleaseNotes, releaseNotesCacheKey]);

  const cachedReleaseNotes = releaseNotesCacheKey
    ? releaseNotesCacheRef.current.get(releaseNotesCacheKey)
    : undefined;
  const restoredUpdateReleaseNotes =
    localizedUpdateReleaseNotes ?? cachedReleaseNotes?.releaseNotes ?? null;
  const restoredReleaseDate = formattedReleaseDate ?? cachedReleaseNotes?.releaseDateLabel ?? null;
  const visibleUpdateReleaseNotes =
    dialogPhase === "downloading" ? null : restoredUpdateReleaseNotes;
  const handleOpenReleaseNotesExternalUrl = useCallback(
    (url: string) => platform.openExternal(url),
    [platform],
  );
  const handleDownloadUpdate = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    // If electron-updater finds an already-downloaded local cache, main broadcasts
    // update-downloaded directly. The renderer must not optimistically switch to “downloading” around the IPC ACK, or it will flash
    // one meaningless frame at 0%/downloading; only lock the button here and follow main's broadcasts for the actual phase.
    setUpdateActionInFlight("download");
    try {
      await platform.downloadUpdate();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [platform, setUpdateActionInFlight]);
  const handleAutoDownloadAndInstallUpdatesChange = useCallback(
    async (enabled: boolean) => {
      setAutoDownloadAndInstallUpdates(enabled);
      await platform.setAutoDownloadAndInstallUpdates?.(enabled);
      if (enabled && updateState?.kind === "update-available") {
        // Behavior: when users enable automatic downloads in the “Update available” dialog, they expect the current version to enter the automatic flow too.
        // Trigger the same download entry point here; main still decides whether to download, use the cache, and broadcast status.
        await handleDownloadUpdate();
      }
    },
    [handleDownloadUpdate, platform, updateState?.kind],
  );
  const handleCancelDownload = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    setUpdateActionInFlight("cancel");
    try {
      await platform.cancelUpdateDownload();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [platform, setUpdateActionInFlight]);
  const handleSkipUpdate = useCallback(async () => {
    if (!skippableVersion || updateActionInFlightRef.current) {
      return;
    }
    setUpdateActionInFlight("skip");
    try {
      await platform.skipUpdateVersion(skippableVersion);
      onOpenChange(false);
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [onOpenChange, platform, setUpdateActionInFlight, skippableVersion]);
  const handleRestartUpdate = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    const activity = await platform.getDesktopSessionActivity?.();
    const runningTaskCount = activity?.runningAgentSessionCount ?? 0;
    if (runningTaskCount > 0) {
      const confirmed = await requestConfirmation({
        title: intl.formatMessage(
          { id: "updateReady.confirm.title" },
          {
            version: displayVersion ?? "",
          },
        ),
        description: intl.formatMessage({
          id: "updateReady.confirm.description",
        }),
        confirmLabel: intl.formatMessage({ id: "updateReady.confirm.ok" }),
        cancelLabel: intl.formatMessage({ id: "updateReady.confirm.cancel" }),
      });
      if (!confirmed) {
        return;
      }
    }

    // Restart installation used to be fire-and-forget, with the renderer closing the dialog as soon as it sent IPC.
    // In dev/mock, if the updater does not take over installation, users only see the dialog disappear and may think the button did nothing.
    setUpdateActionInFlight("restart");
    try {
      await platform.quitAndInstallUpdate();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [displayVersion, intl, platform, requestConfirmation, setUpdateActionInFlight]);

  useEffect(() => {
    if (!displayVersion && updateState !== null) {
      onOpenChange(false);
    }
  }, [displayVersion, onOpenChange, updateState]);

  useEffect(() => {
    if (!updateActionInFlight) {
      return;
    }

    if (isUpdateActionCompleted(updateActionInFlight, updateState)) {
      setUpdateActionInFlight(null);
      return;
    }

    // Exit preparation and handoff to the Windows installer can take more than 5 seconds; the old shared ACK timer restored “Restart to update”
    // before the app actually exited, making users think it failed and click again. Keep the successful restart path pending
    // until the app exits; only restore the button in the caller's catch when IPC explicitly fails.
    if (updateActionInFlight === "restart") {
      if (updateState !== null && updateState.kind !== "update-downloaded") {
        // Main broadcasts error/idle when exit preparation fails. Even if the IPC rejection is lost with the window lifecycle,
        // release the button once the state has left ready; do not leave the previous frame pending forever.
        setUpdateActionInFlight(null);
      }
      return;
    }

    // Download/cancel IPC is acknowledged immediately by main; subsequent broadcasts settle the actual state.
    // Lock the button against repeated clicks; if a broadcast is lost or main does nothing, release it after a short timeout so the UI does not remain stuck.
    const timeout = globalThis.setTimeout(() => {
      setUpdateActionInFlight(null);
    }, 1500);

    return () => {
      globalThis.clearTimeout(timeout);
    };
  }, [setUpdateActionInFlight, updateActionInFlight, updateState?.kind]);

  if (!displayVersion) return null;

  const releaseDateLabel = restoredReleaseDate
    ? intl.formatMessage({ id: "updateDialog.releaseDate" }, { date: restoredReleaseDate })
    : null;

  return (
    <UpdateStatusDialog
      autoDownloadAndInstallUpdates={autoDownloadAndInstallUpdates}
      displayVersion={displayVersion}
      edgeToEdge={edgeToEdge}
      intl={intl}
      isUpdateActionPending={updateActionInFlight !== null}
      localizedUpdateReleaseNotes={visibleUpdateReleaseNotes}
      onAutoDownloadAndInstallUpdatesChange={handleAutoDownloadAndInstallUpdatesChange}
      onCancelDownload={handleCancelDownload}
      onDownloadUpdate={handleDownloadUpdate}
      onOpenChange={onOpenChange}
      onOpenReleaseNotesExternalUrl={handleOpenReleaseNotesExternalUrl}
      onRestartUpdate={handleRestartUpdate}
      onSkipUpdate={handleSkipUpdate}
      open={open}
      phase={dialogPhase}
      progressLabel={progressLabel}
      progressValue={progressValue}
      releaseDateLabel={releaseDateLabel}
      showOverlay={showOverlay}
      skippableVersion={skippableVersion}
    />
  );
}
