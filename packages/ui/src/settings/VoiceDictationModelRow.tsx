import { Button } from "@/components/ui/button.js";
import { SettingsBadge, SettingsRow } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { VoiceModelListItem } from "@zcode/services";

interface VoiceModelRowProps {
  item: VoiceModelListItem;
  selected: boolean;
  onSelect: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onRemove: () => void;
}

/** 单个转写模型的一行：展示规格，并按状态给出下载 / 取消 / 选择 / 删除操作。 */
export function VoiceModelRow({
  item,
  selected,
  onSelect,
  onDownload,
  onCancel,
  onRemove,
}: VoiceModelRowProps) {
  const { intl } = useZCodeIntl();
  const { descriptor, state } = item;
  const ready = state.status === "ready";
  const downloading = state.status === "downloading";
  const percent =
    downloading && state.totalBytes > 0
      ? Math.floor((state.downloadedBytes / state.totalBytes) * 100)
      : 0;

  const control = downloading ? (
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
      <Button variant="ghost" size="sm" onClick={onRemove}>
        {intl.formatMessage({ id: "voiceDictation.models.remove" })}
      </Button>
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

export function formatVoiceModelSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}
