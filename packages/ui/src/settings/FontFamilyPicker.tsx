import { useCallback, useId, useState } from "react";
import { Check, ChevronDown, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  BUNDLED_FONT_FAMILIES,
  getQueryLocalFonts,
  normalizeCustomFontFamily,
  normalizeInstalledFontFamilies,
  type LocalFontData,
} from "@/lib/uiFonts.js";

/** Sentinel value of the "Default" option; selecting it clears the override (null). */
const DEFAULT_FONT_OPTION_VALUE = "__default__";

/** Installed-family cache shared by the UI and mono pickers; null = enumeration failed → input fallback. */
let installedFamiliesPromise: Promise<string[] | null> | null = null;

function loadInstalledFontFamilies(): Promise<string[] | null> {
  installedFamiliesPromise ??= (async () => {
    const queryLocalFonts = getQueryLocalFonts();
    if (!queryLocalFonts) {
      return null;
    }
    try {
      // Requires transient user activation: called from the popover-open click handler.
      const fonts: LocalFontData[] = await queryLocalFonts();
      return normalizeInstalledFontFamilies(fonts);
    } catch {
      // Permission denied or enumeration failure: fall back to the free-text input permanently.
      return null;
    }
  })();
  return installedFamiliesPromise;
}

function isFontFamilyAvailable(family: string): boolean {
  try {
    return document.fonts.check(`12px "${family.replaceAll(/['"]/gu, "")}"`);
  } catch {
    return true;
  }
}

interface FontFamilyPickerProps {
  value: string | null;
  mono: boolean;
  ariaLabel: string;
  onChange: (value: string | null) => void;
}

/**
 * Font family row control, modeled on the Copilot.app font picker.
 * With the Local Font Access API a searchable combobox lists the Default option, the bundled
 * families, and the families installed in the OS; environments without the API (or after a
 * permission denial) fall back to a free-text input. Empty value = bundled default.
 */
export function FontFamilyPicker({ value, mono, ariaLabel, onChange }: FontFamilyPickerProps) {
  const [families, setFamilies] = useState<string[] | null>(null);
  const [enumerationFailed, setEnumerationFailed] = useState(false);
  // True only while an enumeration request is in flight; families stays null until the first
  // popover open (and again after remounts), so the spinner must not key off families alone.
  const [loadingFamilies, setLoadingFamilies] = useState(false);
  const [open, setOpen] = useState(false);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen && families === null && !enumerationFailed && !loadingFamilies) {
        setLoadingFamilies(true);
        void loadInstalledFontFamilies().then((loaded) => {
          setLoadingFamilies(false);
          if (loaded === null) {
            setEnumerationFailed(true);
            return;
          }
          setFamilies(loaded);
        });
      }
    },
    [families, enumerationFailed, loadingFamilies],
  );

  if (enumerationFailed) {
    return (
      <FontFamilyInputFallback
        value={value}
        mono={mono}
        ariaLabel={ariaLabel}
        onChange={onChange}
      />
    );
  }

  return (
    <FontFamilyCombobox
      value={value}
      mono={mono}
      ariaLabel={ariaLabel}
      onChange={onChange}
      families={families}
      loading={loadingFamilies}
      open={open}
      onOpenChange={handleOpenChange}
    />
  );
}

function FontFamilyCombobox({
  value,
  mono,
  ariaLabel,
  onChange,
  families,
  loading,
  open,
  onOpenChange,
}: FontFamilyPickerProps & {
  families: string[] | null;
  loading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const triggerPreviewStyle = value
    ? { fontFamily: `"${value}"` }
    : { fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)" };
  const staleValue = Boolean(value && families !== null && !families.includes(value));

  return (
    <div className="flex w-[260px] min-w-0 flex-col gap-1">
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-label={ariaLabel}
            className="w-full justify-between px-2.5 font-normal"
          >
            <span className="min-w-0 truncate" style={triggerPreviewStyle}>
              {value ?? intl.formatMessage({ id: "settings.fontFamilyDefault" })}
            </span>
            {loading ? (
              <LoaderCircle className="size-3.5 animate-spin text-foreground-subtle" />
            ) : (
              <ChevronDown className="size-3.5 text-foreground-subtle" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 gap-0 bg-menu p-0">
          <Command className="bg-transparent p-0 text-foreground">
            <CommandInput
              placeholder={intl.formatMessage({ id: "settings.fontFamilySearchPlaceholder" })}
              className="h-8"
            />
            <CommandList className="max-h-72">
              <CommandEmpty className="px-4 py-5 text-foreground-subtle">
                {loading
                  ? intl.formatMessage({ id: "settings.fontFamilyLoading" })
                  : intl.formatMessage({ id: "settings.fontFamilyEmpty" })}
              </CommandEmpty>
              <CommandGroup className="p-1">
                <CommandItem
                  value={DEFAULT_FONT_OPTION_VALUE}
                  onSelect={() => {
                    onChange(null);
                    onOpenChange(false);
                  }}
                  className="rounded-md px-2 text-ui-base"
                >
                  <Check className={cn("size-4", value ? "opacity-0" : "text-foreground")} />
                  {intl.formatMessage({ id: "settings.fontFamilyDefault" })}
                </CommandItem>
              </CommandGroup>
              <CommandGroup
                heading={intl.formatMessage({ id: "settings.fontFamilyBundled" })}
                className="p-1 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-ui-sm **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle"
              >
                {BUNDLED_FONT_FAMILIES.map((family) => (
                  <FontFamilyOption
                    key={family}
                    family={family}
                    selected={value === family}
                    onSelect={() => {
                      onChange(family);
                      onOpenChange(false);
                    }}
                  />
                ))}
              </CommandGroup>
              {families !== null && families.length > 0 ? (
                <CommandGroup
                  heading={intl.formatMessage({ id: "settings.fontFamilyInstalled" })}
                  className="p-1 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-ui-sm **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle"
                >
                  {families.map((family) => (
                    <FontFamilyOption
                      key={family}
                      family={family}
                      selected={value === family}
                      onSelect={() => {
                        onChange(family);
                        onOpenChange(false);
                      }}
                    />
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {staleValue ? (
        <p className="text-ui-xs text-foreground-subtlest">
          {intl.formatMessage({ id: "settings.fontFamilyNotFound" })}
        </p>
      ) : null}
    </div>
  );
}

function FontFamilyOption({
  family,
  selected,
  onSelect,
}: {
  family: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem value={family} onSelect={onSelect} className="rounded-md px-2 text-ui-base">
      <Check className={cn("size-4", selected ? "text-foreground" : "opacity-0")} />
      <span className="min-w-0 truncate" style={{ fontFamily: `"${family}"` }}>
        {family}
      </span>
    </CommandItem>
  );
}

/** Free-text fallback for environments without the Local Font Access API. */
function FontFamilyInputFallback({ value, mono, ariaLabel, onChange }: FontFamilyPickerProps) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState(value ?? "");
  const listId = useId();

  const commit = () => {
    const nextValue = normalizeCustomFontFamily(draft);
    setDraft(nextValue ?? "");
    if ((nextValue ?? null) !== value) {
      onChange(nextValue);
    }
  };

  const previewStyle = draft.trim()
    ? {
        fontFamily: `"${draft.trim().replaceAll(/['"]/gu, "")}", ${mono ? "monospace" : "sans-serif"}`,
      }
    : { fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)" };
  const notFound = Boolean(draft.trim()) && !isFontFamilyAvailable(draft);

  return (
    <div className="flex w-[260px] min-w-0 items-center gap-1">
      <Input
        type="text"
        list={listId}
        value={draft}
        placeholder={intl.formatMessage({ id: "settings.fontFamilyDefault" })}
        aria-label={ariaLabel}
        spellCheck={false}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(value ?? "");
          }
        }}
        style={previewStyle}
        className="pr-2"
      />
      <datalist id={listId}>
        {BUNDLED_FONT_FAMILIES.map((family) => (
          <option key={family} value={family} />
        ))}
      </datalist>
      {value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({ id: "settings.fontFamilyReset" })}
          title={intl.formatMessage({ id: "settings.fontFamilyReset" })}
          onClick={() => {
            setDraft("");
            onChange(null);
          }}
        >
          <RotateCcw className="size-4" />
        </Button>
      ) : null}
      {notFound ? (
        <p className="w-full text-ui-xs text-foreground-subtlest">
          {intl.formatMessage({ id: "settings.fontFamilyNotFound" })}
        </p>
      ) : null}
    </div>
  );
}
