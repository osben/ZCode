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
  /** i18n id for the loading phase; desktop loads a model, the web engine only starts the recognizer. */
  loadingLabelId?: string;
  disabled?: boolean;
  onToggle: () => void;
}

/** Voice input button inside the composer: click to start/stop recording (shares the same recording state as the shortcut). */
function V4ComposerVoiceButtonImpl({
  phase,
  level,
  preview,
  loadingLabelId,
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
        ? (loadingLabelId ?? "voiceDictation.composer.loading")
        : recording
          ? "voiceDictation.composer.stop"
          : "voiceDictation.composer.start",
  });
  const tooltip = shortcutLabel ? `${label} (${shortcutLabel})` : label;
  const Icon = recording ? Square : busy ? LoaderCircle : Mic;
  const levelPercent = Math.round(Math.max(0, Math.min(1, level)) * 100);
  // Persistent polite live region: announces phase changes even when focus is elsewhere
  // (e.g. while recording); the preview panel only renders while recording with text, so it
  // cannot cover the idle/transcribing announcements.
  const statusAnnouncement = intl.formatMessage({
    id:
      phase === "loading"
        ? (loadingLabelId ?? "voiceDictation.composer.loading")
        : recording
          ? "voiceDictation.composer.listening"
          : phase === "transcribing"
            ? "voiceDictation.composer.status.transcribing"
            : "voiceDictation.composer.status.idle",
  });

  return (
    <div
      className="relative inline-flex shrink-0 items-center"
      data-testid="voice-dictation-control"
    >
      {recording ? (
        <div
          className="pointer-events-none absolute right-full top-1/2 z-20 mr-2 w-56 -translate-y-1/2 overflow-hidden rounded-xl bg-popover p-2 text-popover-foreground shadow-lg ring-1 ring-border/60 animate-in fade-in slide-in-from-right-2 duration-150 ease-out motion-reduce:animate-none"
          data-testid="voice-dictation-feedback"
        >
          <div className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <Mic className="size-3.5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 truncate text-ui-sm font-medium">
              {intl.formatMessage({ id: "voiceDictation.composer.listening" })}
            </span>
            <div
              className="inline-flex h-6 shrink-0 items-center gap-0.5 text-destructive"
              role="meter"
              aria-label={intl.formatMessage({ id: "voiceDictation.composer.level" })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={levelPercent}
              data-testid="voice-dictation-level"
            >
              {[0, 1, 2, 3, 4, 5, 6].map((index) => {
                const barLevel = Math.max(0.1, level - Math.abs(index - 3) * 0.055);
                return (
                  <span
                    key={index}
                    className="w-0.5 rounded-full bg-current transition-[height] duration-100"
                    style={{ height: `${Math.max(2, Math.round(barLevel * 20))}px` }}
                  />
                );
              })}
            </div>
          </div>
          {preview && (preview.committed || preview.tentative) ? (
            <div
              className="mt-2 border-t border-border/70 pt-1.5 text-ui-sm leading-5 text-muted-foreground"
              data-testid="voice-dictation-preview"
              role="status"
              aria-live="polite"
              title={`${preview.committed}${preview.tentative}`}
            >
              <span className="line-clamp-2">{preview.committed}</span>
              <span className="line-clamp-1 italic opacity-70">{preview.tentative}</span>
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
      <span className="sr-only" role="status" aria-live="polite">
        {statusAnnouncement}
      </span>
    </div>
  );
}

export const V4ComposerVoiceButton = memo(V4ComposerVoiceButtonImpl);
