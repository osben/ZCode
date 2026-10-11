import { memo } from "react";
import { LoaderCircle, Mic, Square } from "lucide-react";
import { TID_V4_COMPOSER_VOICE_ENTRY } from "@zcode/shared";
import type { VoiceTranscriptionPreview } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import type { VoiceDictationPhase } from "@/hooks/useVoiceDictation.js";

interface V4ComposerVoiceButtonProps {
  phase: VoiceDictationPhase;
  level: number;
  preview: VoiceTranscriptionPreview | null;
  disabled?: boolean;
  onToggle: () => void;
}

/** 输入框内的语音输入按钮：点击开始/结束录音（与快捷键共用同一套录音状态）。 */
function V4ComposerVoiceButtonImpl({
  phase,
  level,
  preview,
  disabled,
  onToggle,
}: V4ComposerVoiceButtonProps) {
  const { intl } = useZCodeIntl();
  const shortcutLabel = useShortcutCommandLabel("voiceDictation");
  const recording = phase === "recording";
  const busy = phase === "loading" || phase === "transcribing";
  const label = intl.formatMessage({
    id:
      phase === "loading"
        ? "voiceDictation.composer.loading"
        : recording
          ? "voiceDictation.composer.stop"
          : "voiceDictation.composer.start",
  });
  const tooltip = shortcutLabel ? `${label} (${shortcutLabel})` : label;
  const Icon = recording ? Square : busy ? LoaderCircle : Mic;
  const levelPercent = Math.round(Math.max(0, Math.min(1, level)) * 100);

  return (
    <div
      className="relative inline-flex shrink-0 items-center"
      data-testid="voice-dictation-control"
    >
      {recording ? (
        <div
          className="pointer-events-none absolute right-full top-1/2 z-20 mr-2 flex h-8 w-44 -translate-y-1/2 items-center gap-1.5 overflow-hidden rounded-lg bg-popover px-2 text-popover-foreground shadow-md ring-1 ring-border/60 animate-in fade-in slide-in-from-right-2 duration-150 ease-out motion-reduce:animate-none"
          data-testid="voice-dictation-feedback"
        >
          <div
            className="inline-flex h-6 shrink-0 items-center gap-0.5 text-destructive"
            role="meter"
            aria-label={intl.formatMessage({ id: "voiceDictation.composer.level" })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={levelPercent}
            data-testid="voice-dictation-level"
          >
            {[0, 1, 2, 3, 4].map((index) => {
              const barLevel = Math.max(0.12, level - Math.abs(index - 2) * 0.08);
              return (
                <span
                  key={index}
                  className="w-0.5 rounded-full bg-current transition-[height] duration-100"
                  style={{ height: `${Math.max(2, Math.round(barLevel * 16))}px` }}
                />
              );
            })}
          </div>
          {preview && (preview.committed || preview.tentative) ? (
            <div
              className="min-w-0 truncate text-ui-sm text-muted-foreground"
              data-testid="voice-dictation-preview"
              role="status"
              aria-live="polite"
              title={`${preview.committed}${preview.tentative}`}
            >
              <span>{preview.committed}</span>
              <span className="italic opacity-70">{preview.tentative}</span>
            </div>
          ) : null}
        </div>
      ) : null}
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
          <Icon
            className={
              recording ? "size-3.5 fill-current" : busy ? "size-4 animate-spin" : "size-4"
            }
            aria-hidden
          />
        </Button>
      </ControlHintTooltip>
    </div>
  );
}

export const V4ComposerVoiceButton = memo(V4ComposerVoiceButtonImpl);
