/* eslint-disable max-lines -- Voice dictation settings keeps microphone setup and model download/selection state together so their controls stay synchronized. */
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { VoiceDictationSettings, VoiceModelIdleUnloadMinutes } from "@zcode/shared";
import {
  filterVoiceModels,
  languageSettingsPatch,
  missingVoiceLanguages,
  recommendVoiceModel,
  resolveVoiceLanguages,
  sortVoiceModels,
  type VoiceModelListItem,
} from "@zcode/services";
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
import { useOpenKeyboardShortcutSettings } from "@/hooks/useOpenVoiceDictationSettings.js";
import { useServices } from "@/hooks/useServices.js";
import { useVoiceDictationRuntimeState } from "@/hooks/useVoiceDictationRuntimeState.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useShortcutCommandLabelParts } from "@/shortcuts/useShortcutBindings.js";
import { listAudioInputDevices, VoiceDictationRecorder } from "@/lib/voiceDictationRecorder.js";
import { playVoiceDictationFeedbackSound } from "@/lib/voiceDictationFeedbackSound.js";
import { applyIdleUnloadPreference } from "@/lib/voiceIdleUnload.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { VoiceDictationPostProcessCard } from "@/settings/VoiceDictationPostProcessCard.js";
import { VoiceDictationLanguagePicker } from "@/settings/VoiceDictationLanguagePicker.js";
import { VoiceModelRow } from "@/settings/VoiceDictationModelRow.js";
import {
  DEFAULT_VOICE_MODEL_FILTER,
  VoiceModelFilterBar,
  type VoiceModelFilterState,
} from "@/settings/VoiceModelFilterBar.js";

const MIC_TEST_DURATION_MS = 3000;
/** Peaks below this count as no valid sound (about -40 dBFS). */
const MIC_SILENT_PEAK = 0.01;
const MODEL_REFRESH_INTERVAL_MS = 500;
const DEFAULT_FEEDBACK_VOLUME = 70;

/**
 * Voice input settings in five cards: Dictation, Microphone, Transcription models (with Memory),
 * Output, and Post-processing. Model state and download progress are owned by the services'
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
            <span className="rounded-md bg-surface px-2.5 py-1 text-ui-base font-medium text-foreground-subtle">
              {intl.formatMessage({ id: "voiceDictation.webUnavailable.badge" })}
            </span>
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
  const shortcutParts = useShortcutCommandLabelParts("voiceDictation");
  const openKeyboardShortcuts = useOpenKeyboardShortcutSettings();
  const voice: VoiceDictationSettings = settings?.voiceDictation ?? {};
  // patchVoice is held for minutes by delayed callbacks such as download completion; merging must be
  // based on the latest settings, otherwise a microphone / language / push-to-talk change made during a
  // download would be rolled back by the stale snapshot captured at click time.
  // useSettings publishes a refreshed snapshot only after a write lands, while renders happen
  // continuously (model/device polling). The optimistic overlay keeps the merged object visible to
  // later edits across those renders, so a pending write cannot be erased by the next
  // whole-object patch; it clears once the last in-flight write settles.
  const voiceRef = useRef(voice);
  const optimisticVoiceRef = useRef<VoiceDictationSettings | null>(null);
  const pendingVoiceWritesRef = useRef(0);
  /** True once useSettings published the first non-null snapshot; edits must not merge before that. */
  const settingsLoadedRef = useRef(false);
  if (settings != null) {
    settingsLoadedRef.current = true;
  }
  // The optimistic overlay survives renders until the published snapshot actually reflects it:
  // useSettingService deduplicates overlapping refreshes, so the snapshot published after a write
  // can still be pre-write; clearing early would let a later whole-object patch persist stale data.
  const optimisticVoice = optimisticVoiceRef.current;
  if (optimisticVoice) {
    const published = Object.entries(optimisticVoice).every(([key, value]) =>
      isSameVoiceSettingValue(voice[key as keyof VoiceDictationSettings], value),
    );
    if (published) {
      optimisticVoiceRef.current = null;
    }
  }
  voiceRef.current = optimisticVoiceRef.current ?? voice;
  const selectedLanguagesKey = resolveVoiceLanguages(voiceRef.current).join(",");
  const selectedLanguages = useMemo(
    () => (selectedLanguagesKey ? selectedLanguagesKey.split(",") : []),
    [selectedLanguagesKey],
  );
  const modelId = voice.modelId ?? null;
  const microphoneDeviceId = voice.microphoneDeviceId ?? null;
  const pushToTalk = voice.pushToTalk !== false;
  const idleUnloadMinutes = voice.idleUnloadMinutes ?? 5;
  const feedbackSounds = voice.feedbackSounds === true;
  const savedFeedbackVolume = voice.feedbackVolume ?? DEFAULT_FEEDBACK_VOLUME;
  const muteWhileRecording = voice.muteWhileRecording === true;
  const copyToClipboard = voice.copyToClipboard === true;
  const warmUpOnFocus = voice.warmUpOnFocus !== false;

  const [models, setModels] = useState<VoiceModelListItem[]>([]);
  const [startingDownloadIds, setStartingDownloadIds] = useState<Set<string>>(() => new Set());
  const [pendingUseModelId, setPendingUseModelId] = useState<string | null>(null);
  const pendingUseModelIdRef = useRef<string | null>(null);
  const [, setOptimisticTick] = useState(0);
  const [modelFilter, setModelFilter] = useState<VoiceModelFilterState>(DEFAULT_VOICE_MODEL_FILTER);
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

  /**
   * Writes a preference. Resolves true when the write was saved, false when it failed; a failure is
   * toasted here, and callers that keep unsaved input (the prompt editor) use the result to keep it.
   */
  const patchVoice = useCallback(
    async (patch: Partial<VoiceDictationSettings>): Promise<boolean> => {
      // useSettings publishes settings === null until the initial load resolves; merging against
      // the empty fallback would persist a voiceDictation object containing only the clicked
      // field and erase every stored preference. Edits wait for the first real snapshot.
      if (!settingsLoadedRef.current) {
        logger.warn("voice dictation settings edit ignored: initial settings not loaded yet");
        toast(intl.formatMessage({ id: "voiceDictation.saveFailed" }));
        return false;
      }
      // The merge must land in the ref synchronously: voiceRef is only refreshed during render, so two
      // rapid edits would share the same stale snapshot before the first update() completes, and the
      // later whole-object write of voiceDictation would silently roll back the earlier edit.
      const previous = optimisticVoiceRef.current ?? voiceRef.current;
      const merged = { ...previous, ...patch };
      optimisticVoiceRef.current = merged;
      voiceRef.current = merged;
      pendingVoiceWritesRef.current += 1;
      // The language picker and the post-processing card read the optimistic overlay; show it right away instead of waiting
      // for the settings snapshot to republish (other controls read the published value).
      if (
        patch.languages !== undefined ||
        patch.language !== undefined ||
        patch.postProcessEnabled !== undefined ||
        patch.postProcessProvider !== undefined ||
        // Reset writes undefined on purpose (the key is removed), so test presence, not value.
        "postProcessPrompt" in patch
      ) {
        setOptimisticTick((tick) => tick + 1);
      }
      try {
        await update({ voiceDictation: merged });
        if (patch.idleUnloadMinutes !== undefined && voiceDictationService) {
          // Settings are already saved; an older Host without the method keeps its default delay
          // instead of reporting a save failure (see applyIdleUnloadPreference).
          await applyIdleUnloadPreference(voiceDictationService, patch.idleUnloadMinutes);
        }
        return true;
      } catch (error) {
        // A failed write is not rolled back here: any newer pending write re-persists the whole
        // merged object (healing this failure), and once no writes remain the overlay clears and
        // renders fall back to the persisted snapshot. The toast keeps the failure visible.
        logger.warn("voice dictation settings update failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "voiceDictation.saveFailed" }));
        // The published snapshot will never match a write that failed: drop the overlay when this
        // is the last in-flight write so later edits re-read the persisted state.
        if (pendingVoiceWritesRef.current === 1) {
          optimisticVoiceRef.current = null;
          // Re-render so controls fall back to the persisted value instead of the failed edit.
          setOptimisticTick((tick) => tick + 1);
        }
        return false;
      } finally {
        pendingVoiceWritesRef.current -= 1;
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
  const languageName = useCallback(
    (code: string) => {
      try {
        return languageNames?.of(code) ?? code;
      } catch {
        return code;
      }
    },
    [languageNames],
  );

  // One language catalog: every language any catalog model supports, plus whatever is already
  // selected (so a stale saved code stays visible and removable).
  const optionCodesKey = [
    ...new Set([...selectedLanguages, ...models.flatMap((item) => item.descriptor.languages)]),
  ]
    .sort()
    .join(",");
  const languageOptions = useMemo(() => {
    const collator = new Intl.Collator(locale);
    return optionCodesKey
      .split(",")
      .filter(Boolean)
      .map((code) => ({ code, label: languageName(code) }))
      .sort((a, b) => collator.compare(a.label, b.label));
  }, [languageName, locale, optionCodesKey]);

  // A handful of models: cheap per render. Depend on the id (a string) downstream, because the
  // polled model list hands out new descriptor objects every tick.
  const recommendedModel = recommendVoiceModel(
    models.map((item) => item.descriptor),
    selectedLanguages,
  );
  const recommendedId = recommendedModel?.id ?? null;
  const visibleModels = useMemo(() => {
    const matching = filterVoiceModels(
      models,
      { ...modelFilter, languages: modelFilter.matchLanguages ? selectedLanguages : [] },
      languageName,
    );
    // Filters are view-only: the selected model and anything mid-download or marked "use when ready"
    // always stay visible, so a filter can never hide the Active card or a running download's Cancel.
    const pinned = (item: VoiceModelListItem) =>
      item.descriptor.id === modelId ||
      item.descriptor.id === pendingUseModelId ||
      item.state.status === "downloading" ||
      startingDownloadIds.has(item.descriptor.id);
    return sortVoiceModels(
      models.filter((item) => matching.includes(item) || pinned(item)),
      recommendedId,
    );
  }, [
    languageName,
    modelFilter,
    modelId,
    models,
    pendingUseModelId,
    recommendedId,
    selectedLanguages,
    startingDownloadIds,
  ]);
  const activeModelItem = models.find((item) => item.descriptor.id === modelId);
  const missingLanguages = activeModelItem
    ? missingVoiceLanguages(activeModelItem.descriptor, selectedLanguages)
    : [];

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

  const handleToggleLanguage = (code: string) => {
    // Read the latest value, not the rendered one: voiceRef already holds a pending optimistic edit.
    const current = resolveVoiceLanguages(voiceRef.current);
    const next = current.includes(code) ? current.filter((c) => c !== code) : [...current, code];
    void patchVoice(languageSettingsPatch(next));
  };

  const handleUseRecommended = () => {
    if (!recommendedModel) return;
    const item = models.find((candidate) => candidate.descriptor.id === recommendedModel.id);
    if (item?.state.status === "ready") {
      handleSelectModel(recommendedModel.id);
      return;
    }
    // Not downloaded: download it and switch once it is ready (the current model stays active until then).
    pendingUseModelIdRef.current = recommendedModel.id;
    setPendingUseModelId(recommendedModel.id);
    if (item?.state.status !== "downloading") handleDownload(recommendedModel.id);
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
    <div className="space-y-6">
      <VoiceSettingsGroup
        title={intl.formatMessage({ id: "voiceDictation.group.dictation.title" })}
      >
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "voiceDictation.shortcut.title" })}
            description={intl.formatMessage({ id: "voiceDictation.shortcut.description" })}
            control={
              shortcutParts.length > 0 ? (
                <KbdGroup>
                  {shortcutParts.map((part, partIndex) => (
                    <Kbd key={`${part}-${partIndex}`}>{part}</Kbd>
                  ))}
                </KbdGroup>
              ) : (
                <span className="text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: "voiceDictation.shortcut.unassigned" })}
                </span>
              )
            }
            detail={
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0"
                onClick={openKeyboardShortcuts}
              >
                {intl.formatMessage({ id: "voiceDictation.shortcut.open" })}
              </Button>
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
            controlLayout="wide"
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
                    // Compare against the value currently being persisted, not the stale saved
                    // snapshot: reverting to the saved number while a write is pending must still
                    // issue the compensating write, or the pending write would win.
                    const baseline = committedVolume ?? savedFeedbackVolume;
                    if (committed === undefined || committed === baseline) return;
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
        </SettingsGroupCard>
      </VoiceSettingsGroup>

      <VoiceSettingsGroup
        title={intl.formatMessage({ id: "voiceDictation.group.microphone.title" })}
      >
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
          />
          <SettingsRow
            label={intl.formatMessage({ id: "voiceDictation.micTest.title" })}
            description={intl.formatMessage({ id: "voiceDictation.micTest.description" })}
            controlLayout="wide"
            control={
              <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-3">
                <MicTestResult testing={micTesting} level={micLevel} peak={micPeak} />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={micTesting}
                  onClick={() => void handleMicTest()}
                >
                  {intl.formatMessage({ id: "voiceDictation.micTest.button" })}
                </Button>
              </div>
            }
          />
        </SettingsGroupCard>
      </VoiceSettingsGroup>

      <VoiceSettingsGroup
        title={intl.formatMessage({ id: "voiceDictation.models.title" })}
        description={intl.formatMessage({ id: "voiceDictation.models.description" })}
      >
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "voiceDictation.language.title" })}
            description={intl.formatMessage({ id: "voiceDictation.language.description" })}
            control={
              <VoiceDictationLanguagePicker
                selected={selectedLanguages}
                options={languageOptions}
                ariaLabel={intl.formatMessage({ id: "voiceDictation.language.title" })}
                onToggle={handleToggleLanguage}
                onClear={() => void patchVoice(languageSettingsPatch([]))}
              />
            }
            detail={
              missingLanguages.length > 0 && activeModelItem ? (
                <div
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-base text-warning"
                  data-testid="voice-language-model-mismatch"
                  role="status"
                >
                  <span>
                    {intl.formatMessage(
                      { id: "voiceDictation.language.modelMismatch" },
                      {
                        model: activeModelItem.descriptor.name,
                        languages: missingLanguages.map(languageName).join(", "),
                      },
                    )}
                  </span>
                  {recommendedModel && recommendedModel.id !== modelId ? (
                    <Button variant="outline" size="sm" onClick={handleUseRecommended}>
                      {intl.formatMessage(
                        { id: "voiceDictation.language.useModel" },
                        { model: recommendedModel.name },
                      )}
                    </Button>
                  ) : null}
                </div>
              ) : undefined
            }
          />
          <div className="space-y-3 border-t border-border bg-surface p-4">
            <VoiceModelFilterBar
              value={modelFilter}
              onChange={setModelFilter}
              hasSelectedLanguages={selectedLanguages.length > 0}
            />
            {visibleModels.length === 0 && models.length > 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-card-border bg-card p-6 text-center text-ui-base text-foreground-subtle">
                <p>{intl.formatMessage({ id: "voiceDictation.models.filter.empty" })}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setModelFilter(DEFAULT_VOICE_MODEL_FILTER)}
                >
                  {intl.formatMessage({ id: "voiceDictation.models.filter.reset" })}
                </Button>
              </div>
            ) : null}
            {visibleModels.map((item) => (
              <VoiceModelRow
                key={item.descriptor.id}
                item={item}
                selected={modelId === item.descriptor.id}
                runtimeState={runtimeState}
                startingDownload={startingDownloadIds.has(item.descriptor.id)}
                pendingUse={pendingUseModelId === item.descriptor.id}
                recommended={recommendedId === item.descriptor.id}
                selectedLanguages={selectedLanguages}
                languageName={languageName}
                onSelect={() => handleSelectModel(item.descriptor.id)}
                onUseWhenReady={() => handleUseWhenReady(item.descriptor.id)}
                onDownload={() => handleDownload(item.descriptor.id)}
                onCancel={() => handleCancel(item.descriptor.id)}
                onRemove={() => void handleRemove(item.descriptor.id)}
              />
            ))}
          </div>
          <div className="border-t border-border px-4 pb-1 pt-3">
            <h4 className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "voiceDictation.memory.title" })}
            </h4>
          </div>
          <SettingsRow
            label={intl.formatMessage({ id: "voiceDictation.warmUp.title" })}
            description={intl.formatMessage({ id: "voiceDictation.warmUp.description" })}
            control={
              <Switch
                aria-label={intl.formatMessage({ id: "voiceDictation.warmUp.title" })}
                checked={warmUpOnFocus}
                onCheckedChange={(checked) => void patchVoice({ warmUpOnFocus: checked })}
              />
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
      </VoiceSettingsGroup>

      <VoiceSettingsGroup title={intl.formatMessage({ id: "voiceDictation.group.output.title" })}>
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "voiceDictation.copyToClipboard.title" })}
            description={intl.formatMessage({ id: "voiceDictation.copyToClipboard.description" })}
            control={
              <Switch
                aria-label={intl.formatMessage({ id: "voiceDictation.copyToClipboard.title" })}
                checked={copyToClipboard}
                onCheckedChange={(checked) => void patchVoice({ copyToClipboard: checked })}
              />
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
        </SettingsGroupCard>
      </VoiceSettingsGroup>

      <VoiceSettingsGroup
        title={intl.formatMessage({ id: "voiceDictation.postProcess.title" })}
        description={intl.formatMessage({ id: "voiceDictation.postProcess.description" })}
      >
        <VoiceDictationPostProcessCard voice={voiceRef.current} patchVoice={patchVoice} />
      </VoiceSettingsGroup>
    </div>
  );
}

/** A titled group of settings cards: the heading and optional description sit above the card. */
function VoiceSettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-ui-base font-medium text-foreground">{title}</h3>
        {description ? (
          <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** Status beside the Test microphone button: recording with a live level, the peak, or a silence hint. */
function MicTestResult({
  testing,
  level,
  peak,
}: {
  testing: boolean;
  level: number;
  peak: number | null;
}) {
  const { intl } = useZCodeIntl();
  if (testing) {
    return (
      <div role="status" className="flex items-center gap-2 text-ui-base text-foreground-subtle">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        <span>{intl.formatMessage({ id: "voiceDictation.micTest.recording" })}</span>
        <MicLevelBar level={level} />
      </div>
    );
  }
  if (peak === null) return null;
  return (
    <div role="status" className="min-w-0 text-right text-ui-base text-foreground-subtle">
      {peak < MIC_SILENT_PEAK
        ? intl.formatMessage({ id: "voiceDictation.micTest.silent" })
        : intl.formatMessage(
            { id: "voiceDictation.micTest.result" },
            { level: Math.round(peak * 100) },
          )}
    </div>
  );
}

/** Structural equality for settings values: `languages` is an array that is re-read as a new reference. */
export function isSameVoiceSettingValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  return a === b;
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
