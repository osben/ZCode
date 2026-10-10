import { memo } from "react";
import { Mic, Square } from "lucide-react";
import { TID_V4_COMPOSER_VOICE_ENTRY } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import type { VoiceDictationPhase } from "@/hooks/useVoiceDictation.js";

interface V4ComposerVoiceButtonProps {
  phase: VoiceDictationPhase;
  disabled?: boolean;
  onToggle: () => void;
}

/** 输入框内的语音输入按钮：点击开始/结束录音（与快捷键共用同一套录音状态）。 */
function V4ComposerVoiceButtonImpl({ phase, disabled, onToggle }: V4ComposerVoiceButtonProps) {
  const { intl } = useZCodeIntl();
  const shortcutLabel = useShortcutCommandLabel("voiceDictation");
  const recording = phase === "recording";
  const busy = phase === "transcribing";
  const label = intl.formatMessage({
    id: recording ? "voiceDictation.composer.stop" : "voiceDictation.composer.start",
  });
  const tooltip = shortcutLabel ? `${label} (${shortcutLabel})` : label;
  const Icon = recording ? Square : Mic;

  return (
    <ControlHintTooltip title={tooltip}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid={TID_V4_COMPOSER_VOICE_ENTRY}
        data-voice-phase={phase}
        aria-label={label}
        aria-pressed={recording}
        aria-disabled={busy || disabled || undefined}
        className={recording ? "text-destructive" : undefined}
        onClick={busy || disabled ? undefined : onToggle}
      >
        <Icon className={recording ? "size-3.5 fill-current" : "size-4"} aria-hidden />
      </Button>
    </ControlHintTooltip>
  );
}

export const V4ComposerVoiceButton = memo(V4ComposerVoiceButtonImpl);
