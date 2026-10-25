import { MousePointerClick } from "lucide-react";

export const CUA_FALLBACK_ICON = (
  <MousePointerClick className="size-4 shrink-0 text-foreground-subtle" />
);

// Support semantic names in CUA group summaries; the underlying visual still uses the same fallback.
export const CUA_TOOL_ICON = CUA_FALLBACK_ICON;
