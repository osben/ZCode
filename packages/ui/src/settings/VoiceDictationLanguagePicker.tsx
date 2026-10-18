import { useMemo, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface VoiceLanguageOption {
  code: string;
  label: string;
}

interface VoiceDictationLanguagePickerProps {
  /** Selected language codes in selection order; empty means automatic detection. */
  selected: readonly string[];
  options: readonly VoiceLanguageOption[];
  /**
   * The owner applies the toggle against its latest value rather than this component's `selected`
   * prop, so two quick clicks before the settings snapshot republishes cannot overwrite each other.
   */
  onToggle: (code: string) => void;
  onClear: () => void;
  ariaLabel: string;
}

const SUMMARY_NAMES_LIMIT = 2;

/** Multi-select dictation language control: summary trigger plus a searchable checklist popover. */
export function VoiceDictationLanguagePicker({
  selected,
  options,
  onToggle,
  onClear,
  ariaLabel,
}: VoiceDictationLanguagePickerProps) {
  const { intl } = useZCodeIntl();
  const [query, setQuery] = useState("");
  const labelOf = useMemo(() => {
    const map = new Map(options.map((option) => [option.code, option.label]));
    return (code: string) => map.get(code) ?? code;
  }, [options]);

  const summary =
    selected.length === 0
      ? intl.formatMessage({ id: "voiceDictation.language.auto" })
      : selected.length <= SUMMARY_NAMES_LIMIT
        ? selected.map(labelOf).join(", ")
        : intl.formatMessage(
            { id: "voiceDictation.language.summary.count" },
            { count: selected.length },
          );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = options.filter(
      (option) =>
        !needle || option.label.toLowerCase().includes(needle) || option.code.includes(needle),
    );
    // Selected languages float to the top so the current choice is always visible without scrolling.
    return [
      ...matches.filter((option) => selected.includes(option.code)),
      ...matches.filter((option) => !selected.includes(option.code)),
    ];
  }, [options, query, selected]);

  return (
    <Popover onOpenChange={(open) => !open && setQuery("")}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={`${ariaLabel}: ${summary}`}
          className="w-full justify-between"
        >
          <span className="truncate">{summary}</span>
          <ChevronsUpDown aria-hidden className="shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={intl.formatMessage({ id: "voiceDictation.language.search" })}
          aria-label={intl.formatMessage({ id: "voiceDictation.language.search" })}
        />
        <div className="max-h-64 overflow-y-auto" role="group" aria-label={ariaLabel}>
          {visible.length === 0 ? (
            <p className="px-2 py-3 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "voiceDictation.language.noMatch" })}
            </p>
          ) : (
            visible.map((option) => (
              <label
                key={option.code}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-ui-base hover:bg-surface-hover"
              >
                <Checkbox
                  aria-label={option.label}
                  checked={selected.includes(option.code)}
                  onCheckedChange={() => onToggle(option.code)}
                />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                <span className="text-ui-xs text-foreground-subtle">{option.code}</span>
              </label>
            ))
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={selected.length === 0}
          onClick={onClear}
        >
          {intl.formatMessage({ id: "voiceDictation.language.clear" })}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
