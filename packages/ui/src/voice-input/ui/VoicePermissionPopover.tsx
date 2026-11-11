import {
  TID_V4_COMPOSER_VOICE_PERMISSION_GUIDE,
  TID_V4_COMPOSER_VOICE_PERMISSION_OPEN_SETTINGS,
  TID_V4_COMPOSER_VOICE_PERMISSION_REAUTHORIZE,
  TID_V4_COMPOSER_VOICE_PERMISSION_RELAUNCH,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import {
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { VoicePermissionGuide } from "@/voice-input/contract.js";

/**
 * 麦克风权限被拒绝时显示在语音按钮上方。macOS 提供「重新授权」（清除旧授权后再请求）；
 * 重置后仍需重启才生效时只显示「重启 ZCode」。Windows 只给系统设置入口。
 */
export function VoicePermissionPopover(props: { guide: VoicePermissionGuide }) {
  const { guide } = props;
  const { intl } = useZCodeIntl();
  const restartRequired = guide.phase === "restart-required";
  const isMac = guide.os === "mac";
  return (
    <PopoverContent
      side="top"
      align="end"
      className="w-80 gap-3"
      data-testid={TID_V4_COMPOSER_VOICE_PERMISSION_GUIDE}
      data-voice-permission-phase={guide.phase ?? undefined}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
    >
      <PopoverHeader>
        <PopoverTitle>
          {intl.formatMessage({
            id: restartRequired
              ? "voiceInput.permission.restartTitle"
              : "voiceInput.permission.title",
          })}
        </PopoverTitle>
        <PopoverDescription className="text-ui-sm">
          {intl.formatMessage({
            id: restartRequired
              ? "voiceInput.permission.restartDescription"
              : `voiceInput.permission.description.${guide.os}`,
          })}
        </PopoverDescription>
      </PopoverHeader>
      <div className="flex flex-wrap justify-end gap-2">
        {restartRequired ? (
          <Button
            type="button"
            size="sm"
            data-testid={TID_V4_COMPOSER_VOICE_PERMISSION_RELAUNCH}
            onClick={guide.relaunch}
          >
            {intl.formatMessage({ id: "voiceInput.permission.relaunch" })}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              variant={isMac ? "outline" : "default"}
              data-testid={TID_V4_COMPOSER_VOICE_PERMISSION_OPEN_SETTINGS}
              onClick={guide.openSettings}
            >
              {intl.formatMessage({
                id: "voiceInput.action.openPrivacySettings",
              })}
            </Button>
            {isMac ? (
              <Button
                type="button"
                size="sm"
                disabled={guide.busy}
                data-testid={TID_V4_COMPOSER_VOICE_PERMISSION_REAUTHORIZE}
                onClick={() => void guide.reauthorize()}
              >
                {guide.busy ? <Spinner className="size-3.5" /> : null}
                {intl.formatMessage({
                  id: "voiceInput.permission.reauthorize",
                })}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </PopoverContent>
  );
}
