import { useState } from "react";
import { Settings, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Site settings entry at the left of the address bar (spec:
 * docs/browser-use/2026-10-08-embedded-browser-permission-governance-spec.md,
 * "Site permission settings tab"). Always a sliders icon; it does not change with permission
 * requests. Clicking opens the site info popover whose only action, "Permission settings",
 * enters the dedicated settings tab. The address bar hides this entry while the URL is being
 * edited; no pending permission requests are settled.
 */
export function BrowserSiteSettingsEntry({
  origin,
  onOpenSettings,
}: {
  origin: string;
  onOpenSettings?: (origin: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id: `browser.permission.${id}` });
  // Bug cause: the popover content renders in a body portal while the trigger lives in the browser
  // tab's TabsContent. After clicking "Permission settings", the settings tab activates and the
  // browser tab gets display:none (forceMount does not unmount it). If the popover content is still
  // present (including the 100ms exit-animation window), the floating anchor collapses to zero size
  // with the hidden trigger and the ghost popover collapses to the window's top-left corner. So open
  // is controlled here and closing unmounts the content immediately (no exit animation), guaranteeing
  // the popover disappears in the same frame as the tab switch.
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          className="rounded-full"
          aria-label={t("siteInfo")}
          title={t("siteInfo")}
          data-testid="browser-permission-trigger"
        >
          <SlidersHorizontal />
        </Button>
      </PopoverTrigger>
      {open ? (
        <PopoverContent
          align="start"
          collisionPadding={12}
          className="w-80 max-w-[calc(100vw-24px)] gap-4 p-4"
          data-testid="browser-permission-popover"
        >
          <div
            className="min-w-0 flex-1 text-ui-lg font-medium break-words"
            data-testid="browser-permission-origin"
          >
            {origin}
          </div>
          <Button
            type="button"
            variant="ghost"
            className="justify-start"
            disabled={!onOpenSettings}
            data-testid="browser-permission-open-settings"
            onClick={() => {
              setOpen(false);
              onOpenSettings?.(origin);
            }}
          >
            <Settings className="size-4" />
            {t("settings")}
          </Button>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}
