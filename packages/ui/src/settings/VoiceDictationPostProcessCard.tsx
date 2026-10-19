import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { LoaderCircle } from "lucide-react";
import {
  DEFAULT_POST_PROCESS_PROMPT,
  POST_PROCESS_PROMPT_MAX_LENGTH,
  POST_PROCESS_TEXT_VARIABLE,
  type VoicePostProcessAvailability,
} from "@zcode/services";
import type { VoiceDictationSettings } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { runPostProcess } from "@/lib/voicePostProcess.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

interface VoiceDictationPostProcessCardProps {
  voice: VoiceDictationSettings;
  /** Resolves true when the write was saved; false when it failed (already reported by the owner). */
  patchVoice: (patch: Partial<VoiceDictationSettings>) => Promise<boolean>;
}

const UNAVAILABLE: VoicePostProcessAvailability = { status: "unavailable", reason: "unknown" };
/** Reasons that have a localized message; a Host from another version may report others. */
const KNOWN_UNAVAILABLE_REASONS = new Set<string>([
  "unsupportedPlatform",
  "helperMissing",
  "deviceNotEligible",
  "appleIntelligenceNotEnabled",
  "modelNotReady",
  "unsupportedOS",
  "unknown",
]);
/** Fixed sample for the Try-it control; it is user-visible test input, not localized copy. */
const POST_PROCESS_TRY_IT_SAMPLE = "um so can you explain why this test fails";

/**
 * Post-processing settings: the enable switch with its availability status, the single provider
 * (read-only), and the prompt editor (draft until Save, Esc/Cancel with a discard guard, Reset clears
 * the stored prompt, and Try it). The Host stays authoritative for availability and execution; this
 * card only edits preferences. TODO: more providers and a model choice from ZCode's configured providers.
 */
export function VoiceDictationPostProcessCard({
  voice,
  patchVoice,
}: VoiceDictationPostProcessCardProps) {
  const { intl } = useZCodeIntl();
  const { voiceDictationService } = useServices();
  const confirm = useConfirmDialog();
  const counterId = useId();
  const hintId = useId();
  // null while the first answer is pending: the switch stays disabled and no reason is shown, so
  // a guessed state never flashes before the Host answers.
  const [availability, setAvailability] = useState<VoicePostProcessAvailability | null>(null);

  // Saved text, as the runtime reads it: a blank stored value means the default prompt.
  const storedPrompt = voice.postProcessPrompt?.trim() ? voice.postProcessPrompt : undefined;
  const savedText = storedPrompt ?? DEFAULT_POST_PROCESS_PROMPT;
  const hasCustomPrompt =
    storedPrompt !== undefined && storedPrompt !== DEFAULT_POST_PROCESS_PROMPT;
  // The draft is null while there are no unsaved edits, so the editor follows the saved value
  // (including a write from elsewhere). Only an edit makes the draft a separate value.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = draft ?? savedText;
  const dirty = draft !== null && draft !== savedText;
  const overLimit = editing.length > POST_PROCESS_PROMPT_MAX_LENGTH;
  const blank = editing.trim() === "";
  const hasVariable = editing.includes(POST_PROCESS_TEXT_VARIABLE);
  const canSave = dirty && !blank && hasVariable && !overLimit && !saving;
  const canReset = hasCustomPrompt || editing !== DEFAULT_POST_PROCESS_PROMPT;

  const [tryItSample, setTryItSample] = useState(POST_PROCESS_TRY_IT_SAMPLE);
  const [tryItRunning, setTryItRunning] = useState(false);
  const [tryItOutput, setTryItOutput] = useState<string | null>(null);
  const [tryItError, setTryItError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const next = (await voiceDictationService?.getPostProcessAvailability()) ?? UNAVAILABLE;
        if (!disposed) setAvailability(next);
      } catch (error) {
        // An older Host without the method simply has no provider to offer.
        logger.warn("voice post-processing availability failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!disposed) setAvailability(UNAVAILABLE);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [voiceDictationService]);

  const available = availability?.status === "available";
  const enabled = voice.postProcessEnabled === true && available;

  const discardDraft = async (): Promise<boolean> =>
    confirm({
      title: intl.formatMessage({ id: "voiceDictation.postProcess.discard.title" }),
      description: intl.formatMessage({ id: "voiceDictation.postProcess.discard.description" }),
      confirmLabel: intl.formatMessage({ id: "voiceDictation.postProcess.discard.confirm" }),
      confirmVariant: "destructive",
      showKeyboardHints: false,
    });

  const cancelEdit = async () => {
    if (dirty && !(await discardDraft())) return;
    setDraft(null);
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Esc only cancels an unsaved edit; with nothing to cancel it keeps its normal meaning.
    if (event.key !== "Escape" || !dirty) return;
    event.preventDefault();
    void cancelEdit();
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      // Saving the default text stores no custom prompt, so the default keeps following future changes.
      const ok = await patchVoice({
        postProcessPrompt: editing === DEFAULT_POST_PROCESS_PROMPT ? undefined : editing,
      });
      if (ok) setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  const resetPrompt = async () => {
    if (!canReset) return;
    const confirmed = await confirm({
      title: intl.formatMessage({ id: "voiceDictation.postProcess.reset.title" }),
      description: intl.formatMessage({ id: "voiceDictation.postProcess.reset.description" }),
      confirmLabel: intl.formatMessage({ id: "voiceDictation.postProcess.prompt.reset" }),
      confirmVariant: "destructive",
      showKeyboardHints: false,
    });
    if (!confirmed) return;
    // Same in-flight lock as Save: the editor is disabled while the write runs, so the success clear
    // below cannot discard text typed during it.
    setSaving(true);
    try {
      // Removing the key (not writing the default text) lets the runtime's default apply.
      const ok = await patchVoice({ postProcessPrompt: undefined });
      if (ok) setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  const runTryIt = async () => {
    if (!voiceDictationService || !available || tryItRunning || !tryItSample.trim()) return;
    setTryItRunning(true);
    setTryItOutput(null);
    setTryItError(null);
    try {
      // The editor draft (saved or not) is what the user is testing, so it is used here.
      const text = await runPostProcess(voiceDictationService, {
        text: tryItSample,
        prompt: editing,
        provider: "apple-fm",
      });
      setTryItOutput(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("voice post-processing try-it failed", { error: message });
      setTryItError(message);
    } finally {
      setTryItRunning(false);
    }
  };

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "voiceDictation.postProcess.enabled.title" })}
        description={intl.formatMessage({ id: "voiceDictation.postProcess.enabled.description" })}
        control={
          <Switch
            aria-label={intl.formatMessage({ id: "voiceDictation.postProcess.enabled.title" })}
            aria-busy={availability === null || undefined}
            checked={enabled}
            disabled={!available}
            onCheckedChange={(checked) => void patchVoice({ postProcessEnabled: checked })}
          />
        }
        detail={
          <p className="text-ui-base text-foreground-subtle" role="status">
            {availability === null
              ? intl.formatMessage({ id: "voiceDictation.postProcess.status.checking" })
              : availability.status === "available"
                ? intl.formatMessage({ id: "voiceDictation.postProcess.status.available" })
                : intl.formatMessage({
                    id: `voiceDictation.postProcess.unavailable.${
                      KNOWN_UNAVAILABLE_REASONS.has(availability.reason)
                        ? availability.reason
                        : "unknown"
                    }`,
                  })}
          </p>
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "voiceDictation.postProcess.provider.title" })}
        description={intl.formatMessage({ id: "voiceDictation.postProcess.provider.description" })}
        control={
          <span className="text-right text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "voiceDictation.postProcess.provider.appleFm" })}
          </span>
        }
      />
      <div className="space-y-3 border-t border-border px-4 py-3">
        <div>
          <label
            htmlFor={`${counterId}-prompt`}
            className="block text-ui-base font-medium text-foreground"
          >
            {intl.formatMessage({ id: "voiceDictation.postProcess.prompt.title" })}
          </label>
          <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage(
              { id: "voiceDictation.postProcess.prompt.description" },
              { variable: POST_PROCESS_TEXT_VARIABLE },
            )}
          </p>
        </div>
        <Textarea
          id={`${counterId}-prompt`}
          rows={8}
          spellCheck={false}
          className="min-h-40 max-h-96 resize-y font-mono"
          aria-describedby={`${counterId} ${hintId}`}
          aria-invalid={overLimit || undefined}
          value={editing}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleEditorKeyDown}
        />
        <div className="flex flex-col gap-2 text-ui-sm text-foreground-subtle">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span
              id={counterId}
              className={`tabular-nums ${overLimit ? "text-warning" : ""}`}
              data-testid="voice-prompt-counter"
            >
              {intl.formatMessage(
                { id: "voiceDictation.postProcess.prompt.counter" },
                { count: editing.length, max: POST_PROCESS_PROMPT_MAX_LENGTH },
              )}
            </span>
            {dirty ? (
              <span className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "voiceDictation.postProcess.prompt.unsaved" })}
              </span>
            ) : null}
          </div>
          <p id={hintId} className={overLimit || blank || !hasVariable ? "text-warning" : ""}>
            {overLimit
              ? intl.formatMessage(
                  { id: "voiceDictation.postProcess.prompt.tooLong" },
                  { max: POST_PROCESS_PROMPT_MAX_LENGTH },
                )
              : blank
                ? intl.formatMessage({ id: "voiceDictation.postProcess.prompt.blank" })
                : hasVariable
                  ? null
                  : intl.formatMessage(
                      { id: "voiceDictation.postProcess.prompt.noVariable" },
                      { variable: POST_PROCESS_TEXT_VARIABLE },
                    )}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!canReset || saving}
            onClick={() => void resetPrompt()}
          >
            {intl.formatMessage({ id: "voiceDictation.postProcess.prompt.reset" })}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={!dirty || saving}
              onClick={() => void cancelEdit()}
            >
              {intl.formatMessage({ id: "voiceDictation.postProcess.prompt.cancel" })}
            </Button>
            <Button size="sm" disabled={!canSave} onClick={() => void save()}>
              {intl.formatMessage({ id: "voiceDictation.postProcess.prompt.save" })}
            </Button>
          </div>
        </div>
      </div>
      <div className="space-y-3 border-t border-border px-4 py-3">
        <div>
          <h4 className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "voiceDictation.postProcess.tryIt.title" })}
          </h4>
          <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "voiceDictation.postProcess.tryIt.description" })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="h-8 min-w-0 flex-1"
            value={tryItSample}
            aria-label={intl.formatMessage({ id: "voiceDictation.postProcess.tryIt.sample" })}
            onChange={(event) => setTryItSample(event.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!available || tryItRunning || !tryItSample.trim()}
            onClick={() => void runTryIt()}
          >
            {tryItRunning ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
            {intl.formatMessage({
              id: tryItRunning
                ? "voiceDictation.postProcess.tryIt.running"
                : "voiceDictation.postProcess.tryIt.run",
            })}
          </Button>
        </div>
        {tryItOutput !== null ? (
          <p
            role="status"
            className="rounded-md bg-surface px-3 py-2 text-ui-base whitespace-pre-wrap text-foreground"
          >
            {tryItOutput}
          </p>
        ) : null}
        {tryItError !== null ? (
          <p role="alert" className="text-ui-base text-warning">
            {intl.formatMessage(
              { id: "voiceDictation.postProcess.tryIt.failed" },
              { reason: tryItError },
            )}
          </p>
        ) : null}
      </div>
    </SettingsGroupCard>
  );
}
