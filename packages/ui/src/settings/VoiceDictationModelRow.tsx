import { Button } from "@/components/ui/button.js";
import { LoaderCircle } from "lucide-react";
import { SettingsBadge, SettingsRow } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import type { VoiceDictationRuntimeState, VoiceModelListItem } from "@zcode/services";

interface VoiceModelRowProps {
  item: VoiceModelListItem;
  selected: boolean;
  runtimeState: VoiceDictationRuntimeState;
  now: number;
  startingDownload?: boolean;
  onSelect: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onRemove: () => void;
}

/** 单个转写模型的一行：展示规格，并按状态给出下载 / 取消 / 选择 / 删除操作。 */
export function VoiceModelRow({
  item,
  selected,
  runtimeState,
  now,
  startingDownload = false,
  onSelect,
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
        {selected ? (
          <SettingsBadge>
            {intl.formatMessage({ id: "voiceDictation.models.selected" })}
          </SettingsBadge>
        ) : (
          <Button variant="outline" size="sm" onClick={onSelect}>
            {intl.formatMessage({ id: "voiceDictation.models.use" })}
          </Button>
        )}
        {state.source === "handy" ? null : (
          <Button variant="ghost" size="sm" onClick={() => void confirmRemove()}>
            {intl.formatMessage({ id: "voiceDictation.models.remove" })}
          </Button>
        )}
      </div>
    ) : (
      <Button variant="outline" size="sm" onClick={onDownload}>
        {intl.formatMessage({ id: "voiceDictation.models.download" })}
      </Button>
    );

  const specs = [
    descriptor.description,
    formatVoiceModelSize(descriptor.sizeBytes),
    intl.formatMessage(
      { id: "voiceDictation.models.languages" },
      { count: descriptor.languageCount },
    ),
    intl.formatMessage({ id: "voiceDictation.models.license" }, { license: descriptor.license }),
  ];

  return (
    <SettingsRow
      label={
        <span className="flex flex-wrap items-center gap-2">
          {descriptor.name}
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
          {descriptor.streaming ? (
            <SettingsBadge>
              {intl.formatMessage({ id: "voiceDictation.models.streaming" })}
            </SettingsBadge>
          ) : null}
        </span>
      }
      description={specs.join(" · ")}
      control={control}
      detail={
        downloading ? (
          <div className="space-y-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface">
              <div
                className="h-full bg-brand transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "voiceDictation.models.downloading" }, { percent })}
            </div>
          </div>
        ) : undefined
      }
    />
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
