/**
 * Color row of the quick prompt editor (spec rule 24): the seven palette hues and a dashed "No color" swatch, one
 * selected at a time.
 */
import { BanIcon } from "lucide-react";
import type { QuickPromptColor } from "./contract.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  QUICK_PROMPT_COLOR_OPTIONS,
  quickPromptColorMessageId,
  quickPromptColorVar,
} from "@/quick-prompts/model.js";

export interface QuickPromptColorPickerProps {
  value: QuickPromptColor | null;
  onChange: (color: QuickPromptColor | null) => void;
  disabled?: boolean;
}

const SWATCH_CLASS =
  "flex size-6 shrink-0 items-center justify-center rounded-full outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const SELECTED_CLASS = "ring-2 ring-foreground ring-offset-2 ring-offset-popover";

export function QuickPromptColorPicker({ value, onChange, disabled }: QuickPromptColorPickerProps) {
  const { intl } = useZCodeIntl();
  return (
    <div
      role="group"
      aria-label={intl.formatMessage({ id: "quickPrompts.editor.color" })}
      data-testid="quick-prompt-editor-color"
      className="flex flex-wrap items-center gap-2.5 py-0.5"
    >
      {[null, ...QUICK_PROMPT_COLOR_OPTIONS].map((candidate) => {
        const label = intl.formatMessage({
          id: quickPromptColorMessageId(candidate),
        });
        const selected = value === candidate;
        return (
          <button
            key={candidate ?? "none"}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={selected}
            disabled={disabled}
            data-testid={`quick-prompt-editor-color-${candidate ?? "none"}`}
            className={`${SWATCH_CLASS} ${selected ? SELECTED_CLASS : ""} ${
              candidate
                ? ""
                : "border border-dashed border-foreground-subtle text-foreground-subtle"
            }`}
            style={
              candidate
                ? {
                    backgroundColor: quickPromptColorVar(candidate) ?? undefined,
                  }
                : undefined
            }
            onClick={() => onChange(candidate)}
          >
            {candidate ? null : <BanIcon aria-hidden className="size-3" />}
          </button>
        );
      })}
    </div>
  );
}
