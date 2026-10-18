import { Search } from "lucide-react";
import type { VoiceModelFilter } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** The view filter: the service-side fields plus a toggle that applies the selected dictation languages. */
export type VoiceModelFilterState = Omit<VoiceModelFilter, "languages"> & {
  /** Only models that support every selected dictation language; ignored when no language is selected. */
  matchLanguages: boolean;
};

export const DEFAULT_VOICE_MODEL_FILTER: VoiceModelFilterState = {
  query: "",
  matchLanguages: true,
  downloadedOnly: false,
  streamingOnly: false,
};

interface VoiceModelFilterBarProps {
  value: VoiceModelFilterState;
  onChange: (next: VoiceModelFilterState) => void;
  /** Whether dictation languages are selected; the language toggle is only meaningful then. */
  hasSelectedLanguages: boolean;
}

/** View-only filters above the model list; they never change the selected model or downloads. */
export function VoiceModelFilterBar({
  value,
  onChange,
  hasSelectedLanguages,
}: VoiceModelFilterBarProps) {
  const { intl } = useZCodeIntl();
  const toggle = (key: "matchLanguages" | "downloadedOnly" | "streamingOnly", labelId: string) => (
    <Button
      type="button"
      size="sm"
      variant={value[key] ? "secondary" : "outline"}
      aria-pressed={value[key]}
      onClick={() => onChange({ ...value, [key]: !value[key] })}
    >
      {intl.formatMessage({ id: labelId })}
    </Button>
  );
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="voice-model-filter-bar">
      <div className="relative min-w-40 flex-1">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtle"
        />
        <Input
          className="h-8 pl-8"
          value={value.query}
          onChange={(event) => onChange({ ...value, query: event.target.value })}
          placeholder={intl.formatMessage({ id: "voiceDictation.models.filter.search" })}
          aria-label={intl.formatMessage({ id: "voiceDictation.models.filter.search" })}
        />
      </div>
      {hasSelectedLanguages
        ? toggle("matchLanguages", "voiceDictation.models.filter.matchLanguages")
        : null}
      {toggle("downloadedOnly", "voiceDictation.models.filter.downloaded")}
      {toggle("streamingOnly", "voiceDictation.models.streaming")}
    </div>
  );
}
