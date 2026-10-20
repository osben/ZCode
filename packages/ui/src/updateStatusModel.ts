import type {
  ElectronReleaseChannel,
  PostUpdateReleaseNotesPayload,
  UpdateStatePayload,
} from "@zcode/shared";

export type UpdateStatusDialogPhase = "before-download" | "downloading" | "downloaded";

export type UpdateActionInFlight = "download" | "cancel" | "skip" | "restart" | null;

export type UpdateStatusViewModel = {
  dialogPhase: UpdateStatusDialogPhase;
  displayVersion: string | null;
  progressLabel: string | null;
  progressValue: number;
  releaseNotesPayload: PostUpdateReleaseNotesPayload | undefined;
  skippableVersion: string | null;
  updateChannel: ElectronReleaseChannel | undefined;
};

export function deriveUpdateStatusViewModel({
  legacyReadyVersion,
  updateState,
}: {
  legacyReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
}): UpdateStatusViewModel {
  const isDownloadingUpdate = updateState?.kind === "download-progress";
  const readyVersion = resolveReadyVersion({ legacyReadyVersion, updateState });
  const progressVersion = isDownloadingUpdate ? updateState.version : null;
  const availableVersion = updateState?.kind === "update-available" ? updateState.version : null;
  const displayVersion =
    readyVersion ??
    progressVersion ??
    availableVersion ??
    // download-progress.version is optional in the protocol. Keep the UI for download states based on kind,
    // or a frame without a version could unmount the entry and close an open dialog.
    (isDownloadingUpdate ? "…" : null);

  return {
    dialogPhase: readyVersion
      ? "downloaded"
      : isDownloadingUpdate
        ? "downloading"
        : "before-download",
    displayVersion,
    progressLabel: getUpdateDownloadProgressLabel(updateState),
    progressValue: getUpdateDownloadProgressValue(updateState),
    releaseNotesPayload: getUpdateReleaseNotesPayload(updateState),
    skippableVersion:
      updateState?.kind === "update-available" || updateState?.kind === "download-progress"
        ? (updateState.version ?? null)
        : null,
    updateChannel:
      updateState?.kind === "update-available" ||
      updateState?.kind === "download-progress" ||
      updateState?.kind === "update-downloaded"
        ? updateState.channel
        : undefined,
  };
}

export function isUpdateActionCompleted(
  action: UpdateActionInFlight,
  updateState: UpdateStatePayload | null,
) {
  return (
    // After Download is clicked, main may first broadcast transitional states such as checking/idle.
    // These states do not mean the download has entered an observable phase, so do not release the button lock and unmount the dialog;
    // the download command is complete only after download progress begins or the download finishes.
    (action === "download" &&
      (updateState?.kind === "download-progress" || updateState?.kind === "update-downloaded")) ||
    (action === "cancel" && updateState?.kind !== "download-progress") ||
    (action === "skip" &&
      updateState?.kind !== "update-available" &&
      updateState?.kind !== "download-progress")
  );
}

export function getUpdateDownloadProgressLabel(updateState: UpdateStatePayload | null) {
  if (updateState?.kind !== "download-progress") {
    return null;
  }

  const { totalBytes, transferredBytes } = updateState;
  if (
    typeof transferredBytes === "number" &&
    Number.isFinite(transferredBytes) &&
    transferredBytes >= 0 &&
    typeof totalBytes === "number" &&
    Number.isFinite(totalBytes) &&
    totalBytes > 0
  ) {
    return `${formatMegabytes(transferredBytes)} / ${formatMegabytes(totalBytes)}`;
  }

  // Download progress now shows downloaded/total size. Showing only a percentage would conflict with
  // the new size format, and the initial download state could leave a stale 0% visible.
  return null;
}

function resolveReadyVersion({
  legacyReadyVersion,
  updateState,
}: {
  legacyReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
}) {
  if (updateState?.kind === "update-downloaded") {
    return updateState.version;
  }

  // Legacy UpdateReady is only a cached indication that the update was once ready.
  // Once a new UpdateState has reached the renderer, idle/checking/error must take precedence;
  // do not keep showing a "Restart to update" button based on the old version.
  return updateState === null ? legacyReadyVersion : null;
}

function getUpdateDownloadProgressValue(updateState: UpdateStatePayload | null) {
  const rawProgressValue =
    updateState?.kind === "download-progress" ? Number(updateState.progress) : 0;
  return Number.isFinite(rawProgressValue) ? Math.max(0, Math.min(100, rawProgressValue)) : 0;
}

function getUpdateReleaseNotesPayload(updateState: UpdateStatePayload | null) {
  return updateState?.kind === "update-available" ||
    updateState?.kind === "download-progress" ||
    updateState?.kind === "update-downloaded"
    ? updateState.releaseNotes
    : undefined;
}

function formatMegabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
