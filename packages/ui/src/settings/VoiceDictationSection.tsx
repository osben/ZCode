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
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useVoiceDictationRuntimeState } from "@/hooks/useVoiceDictationRuntimeState.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { listAudioInputDevices, VoiceDictationRecorder } from "@/lib/voiceDictationRecorder.js";
import { SettingsBadge, SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { VoiceModelRow } from "@/settings/VoiceDictationModelRow.js";

const MIC_TEST_DURATION_MS = 3000;
/** 峰值低于该值视为没有有效声音（约 -40 dBFS）。 */
const MIC_SILENT_PEAK = 0.01;
const MODEL_REFRESH_INTERVAL_MS = 500;
const DEFAULT_LANGUAGE = "auto";
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
 * 语音输入设置：输入设备、麦克风测试、快捷键与录音方式、转写模型（下载/选择/删除）。
 * 模型状态与下载进度由 services 的 IVoiceDictationService 持有；这里只轮询展示并写入偏好。
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
  // patchVoice 会被下载完成等延迟回调持有数分钟；合并必须基于最新设置，
  // 否则下载期间用户改过的麦克风/语言/按键说话会被点击时的旧快照回滚。
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const modelId = voice.modelId ?? null;
  const microphoneDeviceId = voice.microphoneDeviceId ?? null;
  const language = voice.language ?? DEFAULT_LANGUAGE;
  const pushToTalk = voice.pushToTalk !== false;
  const idleUnloadMinutes = voice.idleUnloadMinutes ?? 5;

  const [models, setModels] = useState<VoiceModelListItem[]>([]);
  const [startingDownloadIds, setStartingDownloadIds] = useState<Set<string>>(() => new Set());
  const [pendingUseModelId, setPendingUseModelId] = useState<string | null>(null);
  const pendingUseModelIdRef = useRef<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micTesting, setMicTesting] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micPeak, setMicPeak] = useState<number | null>(null);
  const micRecorderRef = useRef<VoiceDictationRecorder | null>(null);

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
      try {
        await update({ voiceDictation: { ...voiceRef.current, ...patch } });
        if (patch.idleUnloadMinutes !== undefined) {
          await voiceDictationService?.setIdleUnloadMinutes(patch.idleUnloadMinutes);
        }
      } catch (error) {
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
      await new Promise((resolve) => window.setTimeout(resolve, MIC_TEST_DURATION_MS));
      recorder.stop();
      setMicPeak(peak);
      // 授权后浏览器才会给出设备名称，测试结束后刷新一次列表。
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

  const handleDownload = (id: string) => {
    if (!voiceDictationService) {
      toast(intl.formatMessage({ id: "voiceDictation.downloadFailed" }));
      return;
    }
    setStartingDownloadIds((current) => new Set(current).add(id));
    // 首次 listModels 可能早于 Host 写入下载状态；轮询期间保留启动态，避免用户误以为点击无效。
    void refreshModels();
    // 下载是长任务：不 await，进度由 refreshModels 轮询刷新。
    void Promise.resolve()
      .then(() => voiceDictationService.downloadModel(id))
      .then(async () => {
        if (pendingUseModelIdRef.current === id) {
          // 下载未完成时不能提前写入 modelId，否则录音会把未就绪的模型交给 Host 并导致转写失败。
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
    void voiceDictationService?.cancelDownload(id).finally(() => void refreshModels());
  };

  const deviceValue = microphoneDeviceId ?? "default";
  // 未授权麦克风时浏览器只给空 deviceId 的占位设备；Radix Select 不接受空值，这些项直接忽略。
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
