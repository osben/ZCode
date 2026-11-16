import { memo, useEffect, useState } from "react";
import { LoaderCircle, Mic, Square, X } from "lucide-react";
import { DesktopCommandIds, TID_V4_COMPOSER_VOICE_ENTRY } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import type {
  VoiceDictationPhase,
  VoiceLevelListener,
  VoicePermissionGuidePhase,
} from "@/hooks/useVoiceDictation.js";
import { peakToWaveformLevel } from "@/lib/voiceDictationAudio.js";
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
  /** Chunk-peak subscription for the waveform; updates re-render only the waveform component. */
  subscribeLevel: (listener: VoiceLevelListener) => () => void;
  /** i18n id for the loading phase; desktop loads a model, the web engine only starts the recognizer. */
  loadingLabelId?: string;
  disabled?: boolean;
  onToggle: () => void;
  /** Selected model's load state, shown as a small dot (Desktop only; omitted elsewhere). */
  modelStatus?: VoiceModelStatus;
  /** Abandons the recording without transcribing; the Cancel button renders only when provided. */
  onCancel?: () => void;
  /** Open microphone permission guide (null closes it); Desktop only. */
  permissionGuide?: VoicePermissionGuidePhase | null;
  /** Runs the macOS re-authorize flow; absent hides the Re-authorize button. */
  onReauthorizeMicrophone?: () => void;
}

const WAVEFORM_BARS = 10;
const SILENT_WAVE_LEVELS: readonly number[] = Array.from({ length: WAVEFORM_BARS }, () => 0);

/**
 * Rolling peak-history waveform (specs/voice-dictation.md): one bar per recorder chunk, the last
 * WAVEFORM_BARS chunks visible, new data entering from the right. Bars map −50…−10 dBFS to 3–14 px.
 * Owns the level state so composer re-renders never depend on audio cadence.
 */
const VoiceWaveform = memo(function VoiceWaveform({
  subscribeLevel,
}: {
  subscribeLevel: (listener: VoiceLevelListener) => () => void;
}) {
  const [levels, setLevels] = useState<number[]>(SILENT_WAVE_LEVELS as number[]);
  useEffect(
    () =>
      subscribeLevel((peak) =>
        setLevels((previous) => [...previous.slice(1), peakToWaveformLevel(peak)]),
      ),
    [subscribeLevel],
  );
  return (
    <span
      aria-hidden
      data-testid="voice-dictation-waveform"
      data-voice-active-bars={levels.filter((level) => level > 0).length}
      className="flex h-3.5 shrink-0 items-center gap-1"
    >
      {levels.map((level, index) => (
        <span
          key={index}
          className="w-0.75 rounded-full bg-voice-input-wave transition-[height] duration-100 ease-out motion-reduce:transition-none"
          style={{ height: `${3 + 11 * level}px` }}
        />
      ))}
    </span>
  );
});

/**
 * Voice input button inside the composer: click to start/stop recording (shares the same recording
 * state as the shortcut). While recording, the peak-history waveform and Cancel sit in a capsule to
 * the left of the stop button. The transcript preview is drawn in the editor (ghost preview), not here.
 */
/**
 * Microphone permission guide anchored to the voice button (specs/voice-dictation.md). macOS can
 * re-authorize (tccutil-backed) and relaunch; Windows only links to its settings page. Opening or
 * closing the popover never moves focus out of the editor, matching the capsule's rule.
 */
function VoicePermissionGuideContent({
  phase,
  onReauthorize,
}: {
  phase: VoicePermissionGuidePhase;
  onReauthorize?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const mac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
  const restart = phase === "restart-required";
  const bodyId = restart
    ? "voiceDictation.permission.restart"
    : mac
      ? "voiceDictation.permission.macDenied"
      : "voiceDictation.permission.windowsDenied";
  return (
    <PopoverContent
      side="top"
      align="end"
      className="w-80 gap-3"
      onOpenAutoFocus={(event) => event.preventDefault()}
      data-testid="voice-permission-guide"
      data-voice-permission-phase={phase}
    >
      <PopoverHeader>
        <PopoverTitle>{intl.formatMessage({ id: "voiceDictation.permission.title" })}</PopoverTitle>
        <PopoverDescription>{intl.formatMessage({ id: bodyId })}</PopoverDescription>
      </PopoverHeader>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void platform?.openSystemSettings?.("microphone-privacy")}
        >
          {intl.formatMessage({ id: "voiceDictation.permission.openSettings" })}
        </Button>
        {!restart && mac && onReauthorize ? (
          <Button type="button" size="sm" onClick={onReauthorize}>
            {intl.formatMessage({ id: "voiceDictation.permission.reauthorize" })}
          </Button>
        ) : null}
        {restart ? (
          <Button
            type="button"
            size="sm"
            onClick={() =>
              void platform
                ?.executeDesktopCommand(DesktopCommandIds.RelaunchApp)
                .catch(() => undefined)
            }
          >
            {intl.formatMessage({ id: "voiceDictation.permission.relaunch" })}
          </Button>
        ) : null}
      </div>
    </PopoverContent>
  );
}

function V4ComposerVoiceButtonImpl({
  phase,
  subscribeLevel,
  loadingLabelId,
  disabled,
  onToggle,
  modelStatus,
  onCancel,
  permissionGuide = null,
  onReauthorizeMicrophone,
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
  // Persistent polite live region: announces phase changes even when focus is elsewhere
  // (e.g. while recording); it is not the ghost preview, so transcript words are never announced.
  const statusAnnouncement = intl.formatMessage({ id: phaseStatusId(phase, loadingLabelId) });

  return (
    <Popover open={permissionGuide !== null}>
      <PopoverAnchor asChild>
        <div
          className="relative inline-flex shrink-0 items-center"
          data-testid="voice-dictation-control"
        >
          {recording ? (
            // Recording capsule (VD-CLU-*): in the toolbar flow, never an overlay, so no covered actions.
            // The mousedown default is prevented so pressing it never moves focus out of the editor,
            // which the composer-scoped dictation shortcut depends on.
            <div
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-voice-input-surface py-0.5 pl-3 pr-1 text-voice-input-wave animate-in fade-in slide-in-from-left-1 duration-200 ease-out motion-reduce:animate-none"
              data-testid="voice-dictation-cluster"
              onMouseDown={(event) => event.preventDefault()}
            >
              <VoiceWaveform subscribeLevel={subscribeLevel} />
              {onCancel ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-voice-input-wave hover:text-voice-input-wave"
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
              className={recording ? "text-voice-input-wave" : undefined}
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
      </PopoverAnchor>
      {permissionGuide !== null ? (
        <VoicePermissionGuideContent
          phase={permissionGuide}
          onReauthorize={onReauthorizeMicrophone}
        />
      ) : null}
    </Popover>
  );
}

export const V4ComposerVoiceButton = memo(V4ComposerVoiceButtonImpl);
