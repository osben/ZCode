import { ZCodeAppLogo } from "@zcode/ui/app-logo";

/** Header brand for pages before connecting: the same logo icon as the desktop app plus the "ZCode" text; a purely static mark that is not clickable. */
export function WebRemoteControlBrand({ className }: { className?: string }) {
  return (
    <span className={["inline-flex items-center gap-2", className].filter(Boolean).join(" ")}>
      <ZCodeAppLogo className="size-5" />
      <span className="text-ui-xs font-medium">ZCode</span>
    </span>
  );
}
