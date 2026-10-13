/* eslint-disable max-lines -- Voice dictation settings keeps microphone setup and model download/selection state together so their controls stay synchronized. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { VoiceDictationSettings, VoiceModelIdleUnloadMinutes } from "@zcode/shared";
import type { VoiceModelListItem } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Kbd, KbdGroup } from "@/components/ui/kbd.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { Slider } from "@/components/ui/slider.js";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useVoiceDictationRuntimeState } from "@/hooks/useVoiceDictationRuntimeState.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { listAudioInputDevices, VoiceDictationRecorder } from "@/lib/voiceDictationRecorder.js";
import { playVoiceDictationFeedbackSound } from "@/lib/voiceDictationFeedbackSound.js";
import { SettingsBadge, SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { VoiceModelRow } from "@/settings/VoiceDictationModelRow.js";

const MIC_TEST_DURATION_MS = 3000;
/** Peaks below this count as no valid sound (about -40 dBFS). */
const MIC_SILENT_PEAK = 0.01;
const MODEL_REFRESH_INTERVAL_MS = 500;
const DEFAULT_LANGUAGE = "auto";
const DEFAULT_FEEDBACK_VOLUME = 70;
const LANGUAGE_CODES = [
  "en",
  "zh",
  "ru",
  "uk",
  "de",
  "fr",
  "es",
  "it",
  "pt",
  "pl",
  "ja",
  "ko",
  "ar",
  "vi",
] as const;

/**
 * Voice input settings: input device, microphone test, shortcut and recording mode, transcription
 * models (download / select / remove). Model state and download progress are owned by the services'
 * IVoiceDictationService; this only polls for display and writes preferences.
 */
export function VoiceDictationSection({ isDesktop = false }: { isDesktop?: boolean }) {
  const { intl } = useZCodeIntl();
  if (!isDesktop) {
    return (
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "voiceDictation.webUnavailable.title" })}
          description={intl.formatMessage({ id: "voiceDictation.webUnavailable.description" })}
          control={
            <SettingsBadge>
              {intl.formatMessage({ id: "voiceDictation.webUnavailable.badge" })}
            </SettingsBadge>
          }
        />
      </SettingsGroupCard>
    );
  }
  return <DesktopVoiceDictationSection />;
}

function DesktopVoiceDictationSection() {
  const { intl, locale } = useZCodeIntl();
  const { voiceDictationService } = useServices();
  const { runtimeState } = useVoiceDictationRuntimeState();
  const { settings, update } = useSettings();
  const shortcutLabel = useShortcutCommandLabel("voiceDictation");
  const voice: VoiceDictationSettings = settings?.voiceDictation ?? {};
  // patchVoice is held for minutes by delayed callbacks such as download completion; merging must be
  // based on the latest settings, otherwise a microphone / language / push-to-talk change made during a
  // download would be rolled back by the stale snapshot captured at click time.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const modelId = voice.modelId ?? null;
  const microphoneDeviceId = voice.microphoneDeviceId ?? null;
  const language = voice.language ?? DEFAULT_LANGUAGE;
  const pushToTalk = voice.pushToTalk !== false;
  const idleUnloadMinutes = voice.idleUnloadMinutes ?? 5;
  const feedbackSounds = voice.feedbackSounds === true;
  const savedFeedbackVolume = voice.feedbackVolume ?? DEFAULT_FEEDBACK_VOLUME;
  const muteWhileRecording = voice.muteWhileRecording === true;

  const [models, setModels] = useState<VoiceModelListItem[]>([]);
  const [startingDownloadIds, setStartingDownloadIds] = useState<Set<string>>(() => new Set());
  const [pendingUseModelId, setPendingUseModelId] = useState<string | null>(null);
  const pendingUseModelIdRef = useRef<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micTesting, setMicTesting] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micPeak, setMicPeak] = useState<number | null>(null);
  const micRecorderRef = useRef<VoiceDictationRecorder | null>(null);
  // Volume while dragging: persisted only on commit (pointer release), so a drag does not write
  // setting.json on every step. The committed value stays on display until the settings write
  // settles, so the slider, percent label, and Test button never flash back to the stale value.
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const [committedVolume, setCommittedVolume] = useState<number | null>(null);
  const [feedbackTestPlaying, setFeedbackTestPlaying] = useState(false);
  const effectiveFeedbackVolume = volumeDraft ?? committedVolume ?? savedFeedbackVolume;

  const refreshModels = useCallback(async () => {
    if (!voiceDictationService) return;
    try {
      setModels(await voiceDictationService.listModels());
    } catch (error) {
      logger.warn("voice model list failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [voiceDictationService]);

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await listAudioInputDevices());
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    void refreshModels();
    void refreshDevices();
    const mediaDevices = navigator.mediaDevices;
    mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => {
      mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
      micRecorderRef.current?.cancel();
      // Clear the ref after cleanup: if microphone permission is only granted by the user at this point,
      // start() inside handleMicTest would begin capturing as usual; it must see "no longer active" right
      // after start() completes and cancel immediately, so recording does not continue after the user
      // leaves settings.
      micRecorderRef.current = null;
    };
  }, [refreshDevices, refreshModels]);

  const anyDownloading = models.some((item) => item.state.status === "downloading");
  const hasPendingDownloadRequests = startingDownloadIds.size > 0;
  useEffect(() => {
    if (!anyDownloading && !hasPendingDownloadRequests) return;
    const timer = window.setInterval(() => void refreshModels(), MODEL_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [anyDownloading, hasPendingDownloadRequests, refreshModels]);

  const patchVoice = useCallback(
    async (patch: Partial<VoiceDictationSettings>) => {
      // The merge must land in the ref synchronously: voiceRef is only refreshed during render, so two
      // rapid edits would share the same stale snapshot before the first update() completes, and the
      // later whole-object write of voiceDictation would silently roll back the earlier edit.
      const previous = voiceRef.current;
      const merged = { ...previous, ...patch };
      voiceRef.current = merged;
      try {
        await update({ voiceDictation: merged });
        if (patch.idleUnloadMinutes !== undefined) {
          await voiceDictationService?.setIdleUnloadMinutes(patch.idleUnloadMinutes);
        }
      } catch (error) {
        // Roll the ref back on save failure so subsequent edits do not accumulate on an unpersisted value.
        voiceRef.current = previous;
        logger.warn("voice dictation settings update failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "voiceDictation.saveFailed" }));
      }
    },
    [intl, update, voiceDictationService],
  );

  const languageNames = useMemo(() => {
    try {
      return new Intl.DisplayNames([locale], { type: "language" });
    } catch {
      return null;
    }
  }, [locale]);

  const languageOptions = useMemo(
    () => [
      {
        value: DEFAULT_LANGUAGE,
        label: intl.formatMessage({ id: "voiceDictation.language.auto" }),
      },
      ...LANGUAGE_CODES.map((code) => ({ value: code, label: languageNames?.of(code) ?? code })),
    ],
    [intl, languageNames],
  );

  const handleMicTest = async () => {
    if (micTesting) return;
    const recorder = new VoiceDictationRecorder();
    micRecorderRef.current = recorder;
    setMicTesting(true);
    setMicPeak(null);
    let peak = 0;
    try {
      await recorder.start({
        deviceId: microphoneDeviceId,
        onLevel: (level) => {
          peak = Math.max(peak, level);
          setMicLevel(level);
        },
      });
      // The user may have left settings while the permission dialog was open (cleanup nulled the ref);
      // cancel immediately in that case, otherwise the test would keep capturing for the full 3 seconds
      // after the user leaves.
      if (micRecorderRef.current !== recorder) {
        recorder.cancel();
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, MIC_TEST_DURATION_MS));
      recorder.stop();
      setMicPeak(peak);
      // Browsers only expose device names after permission is granted; refresh the list once after the test.
      void refreshDevices();
    } catch (error) {
      recorder.cancel();
      logger.warn("voice dictation mic test failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "voiceDictation.microphoneFailed" }));
    } finally {
      micRecorderRef.current = null;
      setMicLevel(0);
      setMicTesting(false);
    }
  };

  const handleTestFeedbackSounds = async () => {
    if (feedbackTestPlaying) return;
    setFeedbackTestPlaying(true);
    try {
      // The test ignores the enable toggle (Handy's play_test_sound): the volume must be
      // adjustable before turning the sounds on. It plays the freshest value: the drag draft or
      // the just-committed one, not the previous saved snapshot.
      const volume = volumeDraft ?? committedVolume ?? savedFeedbackVolume;
      await playVoiceDictationFeedbackSound("start", volume);
      await playVoiceDictationFeedbackSound("stop", volume);
    } finally {
      setFeedbackTestPlaying(false);
    }
  };

  const handleDownload = (id: string) => {
    if (!voiceDictationService) {
      toast(intl.formatMessage({ id: "voiceDictation.downloadFailed" }));
      return;
    }
    setStartingDownloadIds((current) => new Set(current).add(id));
    // The first listModels may run before the Host writes the download state; keep the starting state
    // during polling so the user does not think the click did nothing.
    void refreshModels();
    // Downloading is a long task: do not await; progress is refreshed by the refreshModels polling.
    void Promise.resolve()
      .then(() => voiceDictationService.downloadModel(id))
      .then(async () => {
        if (pendingUseModelIdRef.current === id) {
          // modelId must not be written before the download finishes, otherwise recording would hand an
          // unready model to the Host and transcription would fail.
          await patchVoice({ modelId: id });
          pendingUseModelIdRef.current = null;
          setPendingUseModelId(null);
        }
        toast(intl.formatMessage({ id: "voiceDictation.downloadComplete" }));
      })
      .catch((error: unknown) => {
        logger.warn("voice model download failed", {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
        if (pendingUseModelIdRef.current === id) {
          pendingUseModelIdRef.current = null;
          setPendingUseModelId(null);
        }
        toast(intl.formatMessage({ id: "voiceDictation.downloadFailed" }));
      })
      .finally(() => {
        setStartingDownloadIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        void refreshModels();
      });
  };

  const handleUseWhenReady = (id: string) => {
    const nextId = pendingUseModelIdRef.current === id ? null : id;
    pendingUseModelIdRef.current = nextId;
    setPendingUseModelId(nextId);
  };

  const handleSelectModel = (id: string) => {
    pendingUseModelIdRef.current = null;
    setPendingUseModelId(null);
    void patchVoice({ modelId: id });
  };

  const handleRemove = async (id: string) => {
    if (!voiceDictationService) return;
    try {
      await voiceDictationService.removeModel(id);
      if (modelId === id) await patchVoice({ modelId: null });
      await refreshModels();
    } catch (error) {
      logger.warn("voice model removal failed", {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "voiceDictation.saveFailed" }));
    }
  };

  const handleCancel = (id: string) => {
    if (pendingUseModelIdRef.current === id) {
      pendingUseModelIdRef.current = null;
      setPendingUseModelId(null);
    }
    // A failed cancel must stay visible: the download may still be running, and swallowing it silently would make the user think it stopped.
    void voiceDictationService
      ?.cancelDownload(id)
      .catch((error: unknown) => {
        logger.warn("voice model download cancellation failed", {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "voiceDictation.cancelDownloadFailed" }));
      })
      .finally(() => void refreshModels());
  };

  const deviceValue = microphoneDeviceId ?? "default";
  // Without microphone permission the browser only offers placeholder devices with an empty deviceId; Radix Select rejects empty values, so those items are skipped.
  const namedDevices = devices.filter((device) => device.deviceId);
  const hasSelectedDevice =
    microphoneDeviceId === null ||
    namedDevices.some((device) => device.deviceId === microphoneDeviceId);

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "voiceDictation.inputDevice.title" })}
            description={intl.formatMessage({ id: "voiceDictation.inputDevice.description" })}
            control={
              <Select
                value={deviceValue}
                onValueChange={(value) =>
                  void patchVoice({ microphoneDeviceId: value === "default" ? null : value })
                }
              >
                <SelectTrigger
                  aria-label={intl.formatMessage({ id: "voiceDictation.inputDevice.title" })}
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">
                    {intl.formatMessage({ id: "voiceDictation.inputDevice.default" })}
                  </SelectItem>
                  {namedDevices.map((device, index) => (
                    <SelectItem key={device.deviceId} value={device.deviceId}>
                      {device.label ||
                        intl.formatMessage(
                          { id: "voiceDictation.inputDevice.unnamed" },
                          { index: index + 1 },
                        )}
                    </SelectItem>
                  ))}
                  {!hasSelectedDevice && microphoneDeviceId ? (
                    <SelectItem value={microphoneDeviceId}>
                      {intl.formatMessage({ id: "voiceDictation.inputDevice.unavailable" })}
                    </SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            }
            detail={
              micTesting ? (
                <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden />
                  <span>{intl.formatMessage({ id: "voiceDictation.micTest.recording" })}</span>
                  <MicLevelBar level={micLevel} />
                </div>
              ) : micPeak !== null ? (
                <div className="text-ui-base text-foreground-subtle">
                  {micPeak < MIC_SILENT_PEAK
                    ? intl.formatMessage({ id: "voiceDictation.micTest.silent" })
                    : intl.formatMessage(
                        { id: "voiceDictation.micTest.result" },
                        { level: Math.round(micPeak * 100) },
                      )}
                </div>
              ) : undefined
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "voiceDictation.micTest.title" })}
            description={intl.formatMessage({ id: "voiceDictation.micTest.description" })}
            control={
              <Button
                variant="outline"
                size="sm"
                disabled={micTesting}
                onClick={() => void handleMicTest()}
              >
                {intl.formatMessage({ id: "voiceDictation.micTest.button" })}
              </Button>
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "voiceDictation.shortcut.title" })}
            description={intl.formatMessage({ id: "voiceDictation.shortcut.description" })}
            control={
              shortcutLabel ? (
                <KbdGroup>
                  <Kbd>{shortcutLabel}</Kbd>
                </KbdGroup>
              ) : (
                <span className="text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: "voiceDictation.shortcut.unassigned" })}
                </span>
              )
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "voiceDictation.pushToTalk.title" })}
            description={intl.formatMessage({ id: "voiceDictation.pushToTalk.description" })}
            control={
              <Switch
                aria-label={intl.formatMessage({ id: "voiceDictation.pushToTalk.title" })}
                checked={pushToTalk}
                onCheckedChange={(checked) => void patchVoice({ pushToTalk: checked })}
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "voiceDictation.feedback.title" })}
            description={intl.formatMessage({ id: "voiceDictation.feedback.description" })}
            control={
              <Switch
                aria-label={intl.formatMessage({ id: "voiceDictation.feedback.title" })}
                checked={feedbackSounds}
                onCheckedChange={(checked) => void patchVoice({ feedbackSounds: checked })}
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "voiceDictation.feedbackVolume.title" })}
            description={intl.formatMessage({ id: "voiceDictation.feedbackVolume.description" })}
            control={
              <div className="flex w-full items-center gap-3">
                <Slider
                  aria-label={intl.formatMessage({ id: "voiceDictation.feedbackVolume.title" })}
                  className="w-40"
                  min={0}
                  max={100}
                  step={1}
                  value={[effectiveFeedbackVolume]}
                  onValueChange={(values) => setVolumeDraft(values[0] ?? savedFeedbackVolume)}
                  onValueCommit={(values) => {
                    const committed = values[0];
                    setVolumeDraft(null);
                    if (committed === undefined || committed === savedFeedbackVolume) return;
                    setCommittedVolume(committed);
                    void patchVoice({ feedbackVolume: committed }).then(() => {
                      // Saved (or failed and toasted): defer to the settings value again.
                      setCommittedVolume((current) => (current === committed ? null : current));
                    });
                  }}
                />
                <span className="w-10 shrink-0 text-right text-ui-base text-foreground-subtle">
                  {Math.round(effectiveFeedbackVolume)}%
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={feedbackTestPlaying}
                  onClick={() => void handleTestFeedbackSounds()}
                >
                  {intl.formatMessage({ id: "voiceDictation.feedbackVolume.test" })}
                </Button>
              </div>
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "voiceDictation.muteWhileRecording.title" })}
            description={intl.formatMessage({
              id: "voiceDictation.muteWhileRecording.description",
            })}
            control={
              <Switch
                aria-label={intl.formatMessage({ id: "voiceDictation.muteWhileRecording.title" })}
                checked={muteWhileRecording}
                onCheckedChange={(checked) => void patchVoice({ muteWhileRecording: checked })}
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "voiceDictation.language.title" })}
            description={intl.formatMessage({ id: "voiceDictation.language.description" })}
            control={
              <Select
                value={language}
                onValueChange={(value) => void patchVoice({ language: value })}
              >
                <SelectTrigger
                  aria-label={intl.formatMessage({ id: "voiceDictation.language.title" })}
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {languageOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "voiceDictation.models.unloadDelay.title" })}
            description={intl.formatMessage({
              id: "voiceDictation.models.unloadDelay.description",
            })}
            control={
              <Select
                value={String(idleUnloadMinutes)}
                onValueChange={(value) =>
                  void patchVoice({
                    idleUnloadMinutes: Number(value) as VoiceModelIdleUnloadMinutes,
                  })
                }
              >
                <SelectTrigger
                  aria-label={intl.formatMessage({ id: "voiceDictation.models.unloadDelay.title" })}
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 5, 10, 15, 30].map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {intl.formatMessage(
                        { id: "voiceDictation.models.unloadDelay.option" },
                        { count: minutes },
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </SettingsGroupCard>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "voiceDictation.models.title" })}
          </h3>
          <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "voiceDictation.models.description" })}
          </p>
        </div>
        <div className="space-y-3">
          {models.map((item) => (
            <VoiceModelRow
              key={item.descriptor.id}
              item={item}
              selected={modelId === item.descriptor.id}
              runtimeState={runtimeState}
              startingDownload={startingDownloadIds.has(item.descriptor.id)}
              pendingUse={pendingUseModelId === item.descriptor.id}
              onSelect={() => handleSelectModel(item.descriptor.id)}
              onUseWhenReady={() => handleUseWhenReady(item.descriptor.id)}
              onDownload={() => handleDownload(item.descriptor.id)}
              onCancel={() => handleCancel(item.descriptor.id)}
              onRemove={() => void handleRemove(item.descriptor.id)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function MicLevelBar({ level }: { level: number }) {
  return (
    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface" aria-hidden>
      <div
        className="h-full bg-brand transition-[width] duration-75"
        style={{ width: `${Math.round(Math.min(1, level * 2) * 100)}%` }}
      />
    </div>
  );
}
