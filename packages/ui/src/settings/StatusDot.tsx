// Shared status dot: tone maps to a color, and spinning shows a rotating loader. Reused for several settings indicators
// (McpServerList connection state, Computer Use permission / Helper status) to keep dot styling and colors consistent.
import { CircleIcon, Loader2Icon } from "lucide-react";

export type StatusDotTone = "green" | "amber" | "red" | "muted" | "subtle";

const TONE_CLASS: Record<StatusDotTone, string> = {
  green: "text-green-500",
  amber: "text-yellow-500",
  red: "text-red-500",
  muted: "text-muted-foreground",
  subtle: "text-foreground-subtle",
};

export function StatusDot({ tone, spinning }: { tone: StatusDotTone; spinning?: boolean }) {
  const color = TONE_CLASS[tone];
  if (spinning) {
    return <Loader2Icon className={`size-3 animate-spin ${color}`} />;
  }
  return <CircleIcon className={`size-2 fill-current ${color}`} />;
}
