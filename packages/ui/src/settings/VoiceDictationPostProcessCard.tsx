import { useEffect, useState } from "react";
import {
  DEFAULT_POST_PROCESS_PROMPT,
  POST_PROCESS_PROMPT_MAX_LENGTH,
  POST_PROCESS_TEXT_VARIABLE,
  type VoicePostProcessAvailability,
} from "@zcode/services";
import type { VoiceDictationSettings } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

interface VoiceDictationPostProcessCardProps {
  voice: VoiceDictationSettings;
  patchVoice: (patch: Partial<VoiceDictationSettings>) => Promise<void>;
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

/**
 * Post-processing settings: enable toggle (only when the Host reports the provider available),
 * provider, and the prompt. The Host stays authoritative for availability; this only edits
 * preferences. TODO: more providers and a model choice from ZCode's configured providers.
 */
export function VoiceDictationPostProcessCard({
  voice,
  patchVoice,
}: VoiceDictationPostProcessCardProps) {
  const { intl } = useZCodeIntl();
  const { voiceDictationService } = useServices();
  const [availability, setAvailability] = useState<VoicePostProcessAvailability | null>(null);
  const savedPrompt = voice.postProcessPrompt?.trim()
    ? voice.postProcessPrompt
    : DEFAULT_POST_PROCESS_PROMPT;
  // Typing stays local; the value is written once on blur so a keystroke never rewrites settings.
  const [promptDraft, setPromptDraft] = useState(savedPrompt);
  useEffect(() => setPromptDraft(savedPrompt), [savedPrompt]);

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
  const commitPrompt = () => {
    if (promptDraft !== savedPrompt) void patchVoice({ postProcessPrompt: promptDraft });
  };

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "voiceDictation.postProcess.enabled.title" })}
        description={intl.formatMessage({ id: "voiceDictation.postProcess.enabled.description" })}
        control={
          <Switch
            aria-label={intl.formatMessage({ id: "voiceDictation.postProcess.enabled.title" })}
            checked={enabled}
            disabled={!available}
            onCheckedChange={(checked) => void patchVoice({ postProcessEnabled: checked })}
          />
        }
        detail={
          availability?.status === "unavailable" ? (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id: `voiceDictation.postProcess.unavailable.${
                  KNOWN_UNAVAILABLE_REASONS.has(availability.reason)
                    ? availability.reason
                    : "unknown"
                }`,
              })}
            </p>
          ) : undefined
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "voiceDictation.postProcess.provider.title" })}
        description={intl.formatMessage({ id: "voiceDictation.postProcess.provider.description" })}
        control={
          <Select
            value={voice.postProcessProvider ?? "apple-fm"}
            onValueChange={(value) => void patchVoice({ postProcessProvider: value as "apple-fm" })}
          >
            <SelectTrigger
              aria-label={intl.formatMessage({ id: "voiceDictation.postProcess.provider.title" })}
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="apple-fm">
                {intl.formatMessage({ id: "voiceDictation.postProcess.provider.appleFm" })}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "voiceDictation.postProcess.prompt.title" })}
        description={intl.formatMessage(
          { id: "voiceDictation.postProcess.prompt.description" },
          { variable: POST_PROCESS_TEXT_VARIABLE },
        )}
        controlLayout="wide"
        control={
          <div className="flex w-full flex-col items-stretch gap-2">
            <Textarea
              aria-label={intl.formatMessage({ id: "voiceDictation.postProcess.prompt.title" })}
              className="min-h-32 resize-y font-mono"
              maxLength={POST_PROCESS_PROMPT_MAX_LENGTH}
              value={promptDraft}
              onChange={(event) => setPromptDraft(event.target.value)}
              onBlur={commitPrompt}
            />
            <Button
              variant="outline"
              size="sm"
              className="self-end"
              disabled={promptDraft === DEFAULT_POST_PROCESS_PROMPT}
              onClick={() => {
                setPromptDraft(DEFAULT_POST_PROCESS_PROMPT);
                void patchVoice({ postProcessPrompt: DEFAULT_POST_PROCESS_PROMPT });
              }}
            >
              {intl.formatMessage({ id: "voiceDictation.postProcess.prompt.reset" })}
            </Button>
          </div>
        }
      />
    </SettingsGroupCard>
  );
}
