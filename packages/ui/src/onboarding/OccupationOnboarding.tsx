import { useOnboardingTelemetry } from "@/onboarding/useOnboardingTelemetry.js";
import { OnboardingHeader } from "@/onboarding/OnboardingHeader.js";
import { OccupationOnboardingVisual } from "@/onboarding/OccupationOnboardingVisual.js";
import { occupations, type OccupationValue } from "@/onboarding/occupationOptions.js";
import { OnboardingModeSelector } from "@/onboarding/OnboardingModeSelector.js";
import { OnboardingOccupationGrid } from "@/onboarding/OnboardingOccupationGrid.js";
import { useOnboardingTrigger } from "@/onboarding/useOnboardingTrigger.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSettings } from "@/hooks/useSettingService.js";
import { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { matchesShortcutBinding } from "@/shortcuts/bindings.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import type { InterfaceMode } from "@/lib/interfaceMode.js";
import { logger } from "@/logger.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import type { OnboardingRecordEntry } from "@zcode/shared";

/** Append a local onboarding record (the host fills in userId); treat a missing channel that remains pending for 5 seconds as a write failure. */
async function appendOnboardingRecord(
  service: NonNullable<ReturnType<typeof useOnboardingRecordService>>,
  deviceMid: string,
  entry: Parameters<typeof service.appendRecord>[1],
): Promise<void> {
  await Promise.race([
    service.appendRecord(deviceMid, entry),
    new Promise((_, reject) => setTimeout(() => reject(new Error("appendRecord timeout")), 5000)),
  ]);
}

export function OccupationOnboarding({
  children,
  showWindowControls = false,
  showChildrenWhileLoading = false,
  isMacDesktop,
  isWindowsDesktop,
}: {
  children: ReactNode;
  /** Custom window controls on Windows/Linux: onboarding covers the full main window, including the title bar, so add minimize/maximize/close controls here. */
  showWindowControls?: boolean;
  /** The standalone settings page does not depend on onboarding settings loading, so the app-level onboarding overlay cannot cover its content. */
  showChildrenWhileLoading?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}) {
  const { settings, update } = useSettings();
  const platform = usePlatform();
  const onboardingRecord = useOnboardingRecordService();
  const shortcutBindings = useEffectiveShortcutBindings();
  const requested = useZCodeStore((state) => state.newUserOnboardingOpen);
  const setRequested = useZCodeStore((state) => state.setNewUserOnboardingOpen);
  // Re-evaluate whether to show onboarding for the userId when auth state changes (setUser after a successful login in useRootOAuthEffects).
  const userId = useZCodeStore((state) => state.user?.id) ?? null;
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `occupationOnboarding.${key}` });
  const [occupation, setOccupation] = useState<OccupationValue | null>("developer");
  const savedInterfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useZCodeStore((state) => state.setInterfaceMode);
  // A null mode means the mode page was “skipped” (skipping is an explicit answer, so keep null in the record rather than a fallback value).
  const [mode, setMode] = useState<InterfaceMode | null>(savedInterfaceMode);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const preferences = step === 2;
  const requestOnboardingDialog = useZCodeStore((state) => state.requestOnboardingDialog);
  const [migration, setMigration] = useState(false);
  const [memory, setMemory] = useState(savedInterfaceMode === "office");
  const [suggestions, setSuggestions] = useState(savedInterfaceMode === "office");
  const suggestionsEditedRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const loadDeviceMid = useCallback(() => platform.getDeviceId(), [platform]);
  const [needsOnboarding, markOnboarded] = useOnboardingTrigger({
    onboardingRecord,
    userId,
    loadDeviceMid,
    update,
  });
  const onboardingVisible = requested || (needsOnboarding === true && !dismissed);
  const captureEnd = useOnboardingTelemetry({
    platform,
    visible:
      Boolean(settings) &&
      onboardingVisible &&
      (requested || needsOnboarding !== null || Boolean(settings?.onboardingOccupation)),
    step,
    occupation,
    mode,
    memory,
    suggestions,
    migration,
  });
  const closeOnboarding = useCallback(() => {
    if (savingRef.current) return;
    captureEnd("close", intl.formatMessage({ id: "occupationOnboarding.close" }))();
    setStep(0);
    setDismissed(true);
    setRequested(false);
    if (onboardingRecord) {
      void onboardingRecord.dismissOnboarding(platform.getDeviceId()).catch((cause: unknown) => {
        logger.warn("[occupation-onboarding] 写入关闭决策失败", { error: String(cause) });
      });
    }
  }, [captureEnd, intl, onboardingRecord, platform, setRequested]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        shortcutBindings.toggleInterfaceMode.some((binding) =>
          matchesShortcutBinding(event, binding),
        )
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (saving) return;
        const nextMode = savedInterfaceMode === "office" ? "coding" : "office";
        setInterfaceMode(nextMode);
        setMode(nextMode);
        if (nextMode !== mode) {
          setMemory(nextMode === "office");
          if (nextMode === "office" && !suggestionsEditedRef.current) setSuggestions(true);
        }
        return;
      }
      if (event.key === "Escape" && onboardingVisible && !saving) {
        // Exiting directly does not change preferences; persist dismissed for first-run onboarding to avoid showing it again at next startup.
        event.preventDefault();
        event.stopImmediatePropagation();
        closeOnboarding();
        return;
      }
      if (
        !shortcutBindings.openOnboarding.some((binding) => matchesShortcutBinding(event, binding))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (saving) return;
      // Closing debug onboarding does not save preferences or mark first-run onboarding complete.
      if (onboardingVisible) {
        closeOnboarding();
      } else {
        setRequested(true);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    closeOnboarding,
    shortcutBindings,
    setRequested,
    onboardingVisible,
    saving,
    savedInterfaceMode,
    setInterfaceMode,
    mode,
  ]);
  // When onboarding opens again (after an account switch or by keyboard shortcut), prefill from the user's latest answers in the record
  // instead of starting from hard-coded defaults each time; use defaults for fields recorded as null from skipped pages.
  const [latestEntry, setLatestEntry] = useState<OnboardingRecordEntry | null>(null);
  // A late async prefill must not overwrite a choice the user has already made.
  const userEditedRef = useRef(false);
  useEffect(() => {
    if (!onboardingRecord) return;
    let cancelled = false;
    onboardingRecord.getLatestEntry().then(
      (entry) => {
        if (!cancelled) setLatestEntry(entry);
      },
      (cause) => {
        logger.warn("[occupation-onboarding] 读取预填作答失败", { error: String(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [onboardingRecord, userId]);
  const markUserEdited = () => {
    userEditedRef.current = true;
  };

  const applyLatestEntry = () => {
    const entry = latestEntry;
    setStep(0);
    setOccupation(
      entry?.occupation && (occupations as readonly string[]).includes(entry.occupation)
        ? (entry.occupation as OccupationValue)
        : "developer",
    );
    const initialMode = entry?.interfaceMode ?? savedInterfaceMode;
    setMode(initialMode);
    // Proactive work memory is off by default in coding mode; restore the user's previous choice only in office mode.
    setMemory(initialMode === "office" && (entry?.memoryEnabled ?? true));
    setSuggestions(entry?.proactiveSuggestionsEnabled ?? initialMode === "office");
    setMigration(false);
    setError(false);
  };
  useEffect(() => {
    if (!requested) return;
    userEditedRef.current = false;
    suggestionsEditedRef.current = false;
    applyLatestEntry();
    // If latestEntry arrives asynchronously while onboarding is open, prefill again and override defaults until the user interacts.
  }, [requested]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!onboardingVisible || userEditedRef.current) return;
    applyLatestEntry();
    // eslint-disable-line react-hooks/exhaustive-deps
  }, [latestEntry]);
  if (!settings) return showChildrenWhileLoading ? <>{children}</> : null;
  // Render nothing while deciding to avoid a brief onboarding flash before it disappears or before entering the main view.
  // Wait for the record check only for a suspected first run (no occupation in settings). Existing users (with
  // onboardingOccupation) enter the main view without waiting for RPC, avoiding a black screen.
  if (!requested && needsOnboarding === null && !settings.onboardingOccupation) return null;
  if (!onboardingVisible) return <>{children}</>;
  const save = async (skip = false) => {
    if (savingRef.current) return;
    savingRef.current = true;
    const reportEnd = captureEnd(skip ? "skip" : "start", t(skip ? "skip" : "start"));
    setSaving(true);
    setError(false);
    try {
      if (mode) setInterfaceMode(mode);
      logger.info("[occupation-onboarding] 保存偏好", { interfaceMode: mode });
      await update({
        // Keep the existing settings behavior: skipped pages use conservative defaults (occupation other / preferences off).
        // The distinction that “skip is still an answer” is recorded only in onboarding-record.json.
        onboardingOccupation: occupation ?? "other",
        memoryEnabled: skip ? false : memory,
        proactiveSuggestionsEnabled: !skip && mode === "office" && suggestions,
      });
      reportEnd();
      // Successful save ends this onboarding run; a local record failure must not leave a page that can be submitted again.
      setStep(0);
      setDismissed(true);
      setRequested(false);
      if (!skip && migration) requestOnboardingDialog();
      logger.info("[occupation-onboarding] 偏好保存完成", { interfaceMode: mode });
      if (onboardingRecord) {
        try {
          // Append the onboarding record locally (Host fills userId from login state) for later server upload.
          // appendRecord uses RPC; protect against a missing channel hanging and leaving the save button spinning forever.
          // Skipping is an explicit answer: store null for a skipped page (occupation is already null when step 1 is skipped,
          // mode becomes null when step 2 is skipped, and both booleans are null when the whole preferences page is skipped).
          await appendOnboardingRecord(onboardingRecord, platform.getDeviceId(), {
            occupation,
            interfaceMode: mode,
            memoryEnabled: skip ? null : memory,
            proactiveSuggestionsEnabled: skip ? null : mode === "office" && suggestions,
            completedAt: new Date().toISOString(),
          });
          markOnboarded();
        } catch (cause) {
          // Preferences are saved; if writing the record fails, log a warning without interrupting the user. The record will trigger onboarding again at next startup.
          logger.warn("[occupation-onboarding] 写入引导记录失败", { error: String(cause) });
        }
      }
    } catch (cause) {
      logger.warn("[occupation-onboarding] 保存偏好失败", { error: String(cause) });
      setError(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <main
      aria-label={t("title")}
      data-testid="onboarding-page"
      className="relative flex h-dvh w-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-12 [app-region:drag]" />
      {/* As in Settings, account for Workspace’s 4px outer spacing, 1px border, and 8px padding. */}
      {showWindowControls ? (
        <div className="absolute right-1 top-1 z-30 mt-px mr-px flex h-12 items-center px-2">
          <DesktopWindowControls />
        </div>
      ) : null}
      <div className="relative grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-2 lg:gap-1 lg:p-1">
        <div className="flex min-h-0 flex-col pt-12 [@media(max-height:740px)]:pt-10">
          <OnboardingHeader
            step={step}
            saving={saving}
            t={t}
            onBack={() => setStep(step === 2 ? 1 : 0)}
            onClose={closeOnboarding}
          />
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4 sm:px-10">
            {/* Automatic margins center short content while long content scrolls normally from the top, without affecting fixed navigation. */}
            <div className="mx-auto my-auto w-full max-w-lg shrink-0">
              <section className="flex w-full flex-col">
                <div className="w-full">
                  <h1 className="text-ui-xl font-semibold tracking-tight text-center">
                    {t(preferences ? "preferences" : step === 1 ? "modeTitle" : "title")}
                  </h1>
                  <p className="mx-auto mt-3 max-w-md text-center text-ui-base leading-relaxed text-foreground-subtle">
                    {t(
                      preferences
                        ? "preferencesDescription"
                        : step === 1
                          ? "modeDescription"
                          : "description",
                    )}
                  </p>
                  {step === 1 ? (
                    <OnboardingModeSelector
                      mode={mode}
                      saving={saving}
                      onSelect={(value) => {
                        markUserEdited();
                        // Reselecting the current coding mode should also clear the default checkboxes from the old record.
                        setMemory(value === "office");
                        if (value !== mode) {
                          if (value === "office" && !suggestionsEditedRef.current)
                            setSuggestions(true);
                        }
                        setMode(value);
                      }}
                      label={t("modeTitle")}
                      formatLabel={(key) => t(key)}
                    />
                  ) : preferences ? (
                    <div className="mt-8 space-y-3">
                      {(["suggestions", "memory", "migration"] as const)
                        .filter((key) => key !== "suggestions" || mode === "office")
                        .map((key) => (
                          <label
                            key={key}
                            className="grid cursor-pointer grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 rounded-xl border border-card-border bg-card dark:bg-surface/40 p-5 text-ui-base transition-colors hover:bg-surface-hover"
                          >
                            <Checkbox
                              checked={
                                key === "migration"
                                  ? migration
                                  : key === "memory"
                                    ? memory
                                    : suggestions
                              }
                              disabled={saving}
                              onCheckedChange={(checked) => {
                                markUserEdited();
                                if (key === "migration") setMigration(checked === true);
                                else if (key === "memory") setMemory(checked === true);
                                else {
                                  suggestionsEditedRef.current = true;
                                  setSuggestions(checked === true);
                                }
                              }}
                            />
                            <span className="font-medium">{t(key)}</span>
                            <span className="col-start-2 text-ui-sm font-normal text-foreground-subtle">
                              {t(`${key}Description`)}
                            </span>
                          </label>
                        ))}
                    </div>
                  ) : (
                    <OnboardingOccupationGrid
                      occupation={occupation}
                      saving={saving}
                      onSelect={(value) => {
                        markUserEdited();
                        setOccupation(value);
                      }}
                      label={t("title")}
                      formatLabel={(value) => t(value)}
                    />
                  )}
                  {error ? (
                    <p role="alert" className="mt-4 text-ui-sm text-destructive">
                      {t("error")}
                    </p>
                  ) : null}
                </div>
                <footer className="mt-6 flex flex-col gap-3 [@media(max-height:740px)]:mt-4 [@media(max-height:740px)]:gap-1">
                  <Button
                    variant="link"
                    disabled={saving}
                    className="order-2 h-9 self-center rounded-xl px-3 text-ui-base text-foreground-subtle"
                    onClick={() => {
                      markUserEdited();
                      if (preferences) void save(true);
                      else {
                        if (step === 0) setOccupation(null);
                        else setMode(null);
                        setStep(step === 0 ? 1 : 2);
                      }
                    }}
                  >
                    {t("skip")}
                  </Button>
                  <div className="flex w-full gap-3">
                    <Button
                      disabled={saving || (step === 0 && !occupation)}
                      className="h-11 flex-1 rounded-xl px-5 text-ui-base"
                      onClick={() => {
                        if (!preferences) setStep(step === 0 ? 1 : 2);
                        else void save();
                      }}
                    >
                      {t(saving ? "saving" : preferences ? "start" : "continue")}
                    </Button>
                  </div>
                </footer>
              </section>
            </div>
          </div>
        </div>
        <OccupationOnboardingVisual
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
        />
      </div>
    </main>
  );
}
