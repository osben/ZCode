import { cn } from "@/components/lib/utils.js";

/**
 * Keycap component (aligned with shadcn Kbd): each key is its own chip with a fixed height, minimum square width, and
 * flex centering, so single-symbol keys such as ⌘/⇧ appear the same size as letter keys. font-sans prevents glyph widths from varying
 * when symbols fall back from the monospace font (data comes from the platform-formatted label; see shortcuts/label.ts).
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 select-none items-center justify-center gap-1 rounded-sm border border-b-2 border-border bg-muted px-1 font-sans text-ui-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** Key combination container: lays out multiple keys in one shortcut horizontally (gap-1), e.g. ⌘ + K. */
function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
