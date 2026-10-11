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
  now: number;
  startingDownload?: boolean;
  pendingUse?: boolean;
  onSelect: () => void;
  onUseWhenReady: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onRemove: () => void;
}

/** 单个转写模型的卡片：展示规格，并按状态提供下载、取消、选择和删除操作。 */
export function VoiceModelRow({
  item,
  selected,
  runtimeState,
  now,
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
  const active = runtimeState.activeModelId === descriptor.id;
  const loaded = runtimeState.loadedModelId === descriptor.id;
  const percent =
    downloading && state.totalBytes > 0
      ? Math.floor((state.downloadedBytes / state.totalBytes) * 100)
      : 0;
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

  const control =
    startingDownload && !downloading ? (
      <Button variant="outline" size="sm" disabled>
        <LoaderCircle className="size-3 animate-spin" aria-hidden />
        {intl.formatMessage({ id: "voiceDictation.models.startingDownload" })}
      </Button>
    ) : downloading ? (
      <Button variant="ghost" size="sm" onClick={onCancel}>
        {intl.formatMessage({ id: "voiceDictation.models.cancel" })}
      </Button>
    ) : ready ? (
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
              {runtimeState.idleUnloadAt === null
                ? intl.formatMessage({ id: "voiceDictation.models.loaded" })
                : intl.formatMessage(
                    { id: "voiceDictation.models.loadedWithCountdown" },
                    { time: formatRemainingTime(runtimeState.idleUnloadAt, now) },
                  )}
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
          {descriptor.description}
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
          {descriptor.streaming ? (
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

      {downloading ? (
        <div className="relative z-10 mt-3 space-y-2 border-t border-border pt-3 pointer-events-none">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface">
            <div className="h-full bg-brand transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "voiceDictation.models.downloading" }, { percent })}
            </div>
            <Button
              className="pointer-events-auto"
              variant="outline"
              size="sm"
              onClick={onUseWhenReady}
            >
              {intl.formatMessage({
                id: pendingUse
                  ? "voiceDictation.models.cancelUseWhenReady"
                  : "voiceDictation.models.useWhenReady",
              })}
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function formatRemainingTime(deadline: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatVoiceModelSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}
