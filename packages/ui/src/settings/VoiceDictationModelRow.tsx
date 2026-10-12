import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { AudioLines, Globe2, HardDrive, LoaderCircle, Trash2 } from "lucide-react";
import { SettingsBadge } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import type { VoiceDictationRuntimeState, VoiceModelListItem } from "@zcode/services";

interface VoiceModelRowProps {
  item: VoiceModelListItem;
  selected: boolean;
  runtimeState: VoiceDictationRuntimeState;
  startingDownload?: boolean;
  pendingUse?: boolean;
  onSelect: () => void;
  onUseWhenReady: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onRemove: () => void;
}

/**
 * Catalog descriptions are written in English; the UI is localized (spec VD-11 requires localized
 * descriptions), so known models are mapped to an i18n key. Unknown models (a new catalog with an
 * older UI) fall back to the catalog's English text.
 */
const MODEL_DESCRIPTION_MESSAGE_IDS: Readonly<Record<string, string>> = {
  "whisper-tiny": "voiceDictation.models.description.whisper",
  "whisper-base": "voiceDictation.models.description.whisper",
  "whisper-small": "voiceDictation.models.description.whisper",
  "whisper-large-v3-turbo": "voiceDictation.models.description.whisper",
  "parakeet-unified-en-0.6b": "voiceDictation.models.description.parakeetLive",
  "parakeet-tdt-0.6b-v3": "voiceDictation.models.description.parakeetMultilingual",
  "canary-180m-flash": "voiceDictation.models.description.canary",
  "nemotron-speech-streaming-en-0.6b": "voiceDictation.models.description.nemotron",
};

/** Card for a single transcription model: shows specs and offers download, cancel, select, and remove actions by state. */
export function VoiceModelRow({
  item,
  selected,
  runtimeState,
  startingDownload = false,
  pendingUse = false,
  onSelect,
  onUseWhenReady,
  onDownload,
  onCancel,
  onRemove,
}: VoiceModelRowProps) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const { descriptor, state } = item;
  const ready = state.status === "ready";
  const downloading = state.status === "downloading";
  const showDownloadProgress = downloading || startingDownload;
  const active = runtimeState.activeModelId === descriptor.id;
  const loaded = runtimeState.loadedModelId === descriptor.id;
  const downloadedBytes = downloading ? state.downloadedBytes : null;
  const totalBytes = downloading ? state.totalBytes : null;
  const hasKnownProgress = downloading && totalBytes !== null && totalBytes > 0;
  const percent = hasKnownProgress
    ? Math.max(0, Math.min(100, Math.floor(((downloadedBytes ?? 0) / totalBytes) * 100)))
    : 0;
  const downloadSampleRef = useRef<{ bytes: number; sampledAt: number } | null>(null);
  const [downloadSpeed, setDownloadSpeed] = useState<number | null>(null);
  const descriptionMessageId = MODEL_DESCRIPTION_MESSAGE_IDS[descriptor.id];

  useEffect(() => {
    if (!downloading || downloadedBytes === null) {
      downloadSampleRef.current = null;
      setDownloadSpeed(null);
      return;
    }

    const sampledAt = Date.now();
    const previousSample = downloadSampleRef.current;
    downloadSampleRef.current = { bytes: downloadedBytes, sampledAt };
    if (!previousSample || sampledAt <= previousSample.sampledAt) return;
    const bytesPerSecond =
      ((downloadedBytes - previousSample.bytes) * 1000) / (sampledAt - previousSample.sampledAt);
    if (bytesPerSecond > 0) setDownloadSpeed(bytesPerSecond);
    else if (bytesPerSecond < 0) setDownloadSpeed(null);
  }, [downloadedBytes, downloading]);
  const cardActionId = selected
    ? "voiceDictation.models.selected"
    : downloading || startingDownload
      ? pendingUse
        ? "voiceDictation.models.cancelUseWhenReady"
        : "voiceDictation.models.useWhenReady"
      : ready
        ? "voiceDictation.models.use"
        : "voiceDictation.models.download";
  const handleCardAction = () => {
    if (ready) {
      if (!selected) onSelect();
    } else if (downloading || startingDownload) {
      onUseWhenReady();
    } else {
      onDownload();
    }
  };
  const confirmRemove = async () => {
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "voiceDictation.models.removeConfirm.title" }),
      description: intl.formatMessage(
        { id: "voiceDictation.models.removeConfirm.description" },
        { model: descriptor.name },
      ),
      confirmLabel: intl.formatMessage({ id: "voiceDictation.models.remove" }),
      confirmVariant: "destructive",
      showKeyboardHints: false,
    });
    if (confirmed) onRemove();
  };

  const control = showDownloadProgress ? null : ready ? (
    <div className="flex items-center gap-2">
      {!selected && (
        <Button variant="outline" size="sm" onClick={onSelect}>
          {intl.formatMessage({ id: "voiceDictation.models.use" })}
        </Button>
      )}
      {state.source === "handy" ? null : (
        <Button variant="ghost" size="sm" onClick={() => void confirmRemove()}>
          <Trash2 className="size-3" aria-hidden />
          {intl.formatMessage({ id: "voiceDictation.models.remove" })}
        </Button>
      )}
    </div>
  ) : (
    <Button variant="outline" size="sm" onClick={onDownload}>
      {intl.formatMessage({ id: "voiceDictation.models.download" })}
    </Button>
  );

  return (
    <article
      data-selected={selected}
      className={`relative rounded-xl border p-4 transition-colors ${
        selected
          ? "border-brand/40 bg-card-selected ring-1 ring-brand/15"
          : "cursor-pointer border-card-border bg-card hover:border-border-hover hover:bg-surface-hover"
      }`}
    >
      <button
        type="button"
        aria-label={`${descriptor.name}: ${intl.formatMessage({ id: cardActionId })}`}
        disabled={ready && selected}
        onClick={handleCardAction}
        className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      />
      <div className="relative z-10 min-w-0 pointer-events-none">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-ui-lg font-semibold text-foreground">{descriptor.name}</h4>
          {selected ? (
            <SettingsBadge>
              {intl.formatMessage({ id: "voiceDictation.models.selected" })}
            </SettingsBadge>
          ) : null}
          {active ? (
            <SettingsBadge>
              {intl.formatMessage({
                id:
                  runtimeState.activePhase === "loading"
                    ? "voiceDictation.models.loading"
                    : runtimeState.activePhase === "streaming"
                      ? "voiceDictation.models.streamingActive"
                      : "voiceDictation.models.transcribing",
              })}
            </SettingsBadge>
          ) : loaded ? (
            <SettingsBadge>
              {intl.formatMessage({ id: "voiceDictation.models.loaded" })}
            </SettingsBadge>
          ) : null}
          {ready && state.source === "handy" ? (
            <SettingsBadge>
              {intl.formatMessage({ id: "voiceDictation.models.fromHandy" })}
            </SettingsBadge>
          ) : null}
          {(downloading || startingDownload) && pendingUse ? (
            <SettingsBadge>
              {intl.formatMessage({ id: "voiceDictation.models.willUseWhenReady" })}
            </SettingsBadge>
          ) : null}
        </div>
        <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
          {descriptionMessageId
            ? intl.formatMessage(
                { id: descriptionMessageId },
                { languages: descriptor.languageCount },
              )
            : descriptor.description}
        </p>
      </div>

      <div className="relative z-10 mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 pointer-events-none">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-ui-base text-foreground-subtle">
          <span className="inline-flex items-center gap-1.5">
            <Globe2 className="size-4" aria-hidden />
            {intl.formatMessage(
              { id: "voiceDictation.models.languages" },
              { count: descriptor.languageCount },
            )}
          </span>
          {/* The runtime gate allows streaming only for models with a Parakeet stream slot
              (supportsStreaming && accepts parakeet); the catalog also marks Nemotron as streaming,
              but it always runs one-shot — advertising Streaming on that card would contradict the spec. */}
          {descriptor.streaming && descriptor.family === "parakeet" ? (
            <span className="inline-flex items-center gap-1.5">
              <AudioLines className="size-4" aria-hidden />
              {intl.formatMessage({ id: "voiceDictation.models.streaming" })}
            </span>
          ) : null}
          <span>
            {intl.formatMessage(
              { id: "voiceDictation.models.license" },
              { license: descriptor.license },
            )}
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="inline-flex items-center gap-1.5 text-ui-base text-foreground-subtle">
            <HardDrive className="size-4" aria-hidden />
            {formatVoiceModelSize(descriptor.sizeBytes)}
          </span>
          <div className="pointer-events-auto">{control}</div>
        </div>
      </div>

      {showDownloadProgress ? (
        <div className="relative z-10 mt-3 space-y-2 border-t border-border pt-3 pointer-events-none">
          <div
            className="h-3 w-full overflow-hidden rounded-full bg-surface"
            role="progressbar"
            aria-label={
              startingDownload && !downloading
                ? intl.formatMessage({ id: "voiceDictation.models.startingDownload" })
                : intl.formatMessage({ id: "voiceDictation.models.downloading" }, { percent })
            }
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={hasKnownProgress ? percent : undefined}
            data-testid="voice-model-download-progress"
          >
            <div
              className={`h-full rounded-full bg-brand transition-[width] ${hasKnownProgress ? "" : "w-1/3 animate-pulse"}`}
              style={hasKnownProgress ? { width: `${percent}%` } : undefined}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3 text-ui-base text-foreground-subtle">
            <span className="inline-flex min-w-0 flex-1 items-center gap-2">
              {startingDownload && !downloading ? (
                <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />
              ) : null}
              {downloading
                ? intl.formatMessage({ id: "voiceDictation.models.downloading" }, { percent })
                : intl.formatMessage({ id: "voiceDictation.models.startingDownload" })}
            </span>
            {downloadSpeed !== null ? (
              <span className="shrink-0 tabular-nums">
                {formatVoiceModelDownloadSpeed(downloadSpeed)}
              </span>
            ) : null}
            {showDownloadProgress ? (
              <Button
                className="pointer-events-auto shrink-0"
                variant="ghost"
                size="sm"
                onClick={onCancel}
              >
                {intl.formatMessage({ id: "voiceDictation.models.cancel" })}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function formatVoiceModelDownloadSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1_000_000) return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1_000) return `${Math.round(bytesPerSecond / 1_000)} KB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
}

export function formatVoiceModelSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}
