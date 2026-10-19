import { memo } from "react";
import { LoaderCircle, Mic, Square, X } from "lucide-react";
import { TID_V4_COMPOSER_VOICE_ENTRY } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import type { VoiceDictationPhase } from "@/hooks/useVoiceDictation.js";
import type { VoiceModelStatus } from "@/lib/voiceModelStatus.js";

/** i18n id of the button label: the action the button performs in this phase. */
function phaseLabelId(phase: VoiceDictationPhase, loadingLabelId: string | undefined): string {
  if (phase === "loading") return loadingLabelId ?? "voiceDictation.composer.loading";
  if (phase === "recording") return "voiceDictation.composer.stop";
  if (phase === "processing") return "voiceDictation.composer.processing";
  return "voiceDictation.composer.start";
}

/** i18n id of the live-region status: the same phases worded as state, not as an action. */
function phaseStatusId(phase: VoiceDictationPhase, loadingLabelId: string | undefined): string {
  if (phase === "loading") return loadingLabelId ?? "voiceDictation.composer.loading";
  if (phase === "recording") return "voiceDictation.composer.listening";
  if (phase === "processing") return "voiceDictation.composer.status.processing";
  if (phase === "transcribing") return "voiceDictation.composer.status.transcribing";
  return "voiceDictation.composer.status.idle";
}

interface V4ComposerVoiceButtonProps {
  phase: VoiceDictationPhase;
  level: number;
  /** i18n id for the loading phase; desktop loads a model, the web engine only starts the recognizer. */
  loadingLabelId?: string;
  disabled?: boolean;
  onToggle: () => void;
  /** Selected model's load state, shown as a small dot (Desktop only; omitted elsewhere). */
  modelStatus?: VoiceModelStatus;
  /** Abandons the recording without transcribing; the Cancel button renders only when provided. */
  onCancel?: () => void;
}

/**
 * Voice input button inside the composer: click to start/stop recording (shares the same recording
 * state as the shortcut). While recording, the level meter and Cancel sit in a toolbar cluster to
 * the left of the stop button. The transcript preview is drawn in the editor (ghost preview), not here.
 */
function V4ComposerVoiceButtonImpl({
  phase,
  level,
  loadingLabelId,
  disabled,
  onToggle,
  modelStatus,
  onCancel,
}: V4ComposerVoiceButtonProps) {
  const { intl } = useZCodeIntl();
  const shortcutLabel = useShortcutCommandLabel("voiceDictation");
  const recording = phase === "recording";
  const busy = phase === "loading" || phase === "transcribing" || phase === "processing";
  const label = intl.formatMessage({ id: phaseLabelId(phase, loadingLabelId) });
  // The dot only adds information while the button is otherwise idle.
  const statusDot =
    phase === "idle" && (modelStatus === "loading" || modelStatus === "loaded")
      ? modelStatus
      : null;
  // Only the loading dot has tooltip/aria text. The loaded dot is a non-essential hint: it is
  // decorative (aria-hidden) and carries no text, so the tooltip and description stay silent.
  const statusText =
    statusDot === "loading"
      ? intl.formatMessage({ id: "voiceDictation.composer.modelStatus.loading" })
      : null;
  const Icon = recording ? Square : busy ? LoaderCircle : Mic;
  const levelPercent = Math.round(Math.max(0, Math.min(1, level)) * 100);
  // Persistent polite live region: announces phase changes even when focus is elsewhere
  // (e.g. while recording); it is not the ghost preview, so transcript words are never announced.
  const statusAnnouncement = intl.formatMessage({ id: phaseStatusId(phase, loadingLabelId) });

  return (
    <div
      className="relative inline-flex shrink-0 items-center"
      data-testid="voice-dictation-control"
    >
      {recording ? (
        // Toolbar cluster (VD-CLU-*): in the toolbar flow, never an overlay, so no covered actions.
        // The mousedown default is prevented so pressing it never moves focus out of the editor,
        // which the composer-scoped dictation shortcut depends on.
        <div
          className="inline-flex shrink-0 items-center gap-1.5 pr-1 text-destructive animate-in fade-in duration-150 ease-out motion-reduce:animate-none"
          data-testid="voice-dictation-cluster"
          onMouseDown={(event) => event.preventDefault()}
        >
          <div
            className="inline-flex h-6 shrink-0 items-center gap-0.5"
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
          {onCancel ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label={intl.formatMessage({ id: "voiceDictation.composer.cancel" })}
              data-testid="voice-dictation-cancel"
              onClick={onCancel}
            >
              <X aria-hidden />
            </Button>
          ) : null}
        </div>
      ) : null}
      <ControlHintTooltip
        title={statusText ? `${label} · ${statusText}` : label}
        shortcut={shortcutLabel || undefined}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          data-testid={TID_V4_COMPOSER_VOICE_ENTRY}
          data-voice-phase={phase}
          aria-label={label}
          aria-describedby={statusText ? "voice-model-status-text" : undefined}
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
      {statusDot ? (
        <span
          aria-hidden
          data-testid="voice-model-status-dot"
          data-status={statusDot}
          className={`pointer-events-none absolute right-1 top-1 size-1.5 rounded-full ${
            statusDot === "loading"
              ? "animate-pulse bg-warning motion-reduce:animate-none"
              : "bg-success"
          }`}
        />
      ) : null}
      {statusText ? (
        <span id="voice-model-status-text" className="sr-only">
          {statusText}
        </span>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {statusAnnouncement}
      </span>
    </div>
  );
}

export const V4ComposerVoiceButton = memo(V4ComposerVoiceButtonImpl);
