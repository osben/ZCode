/**
 * Color label dot (spec rule 23). Decorative: the name next to it stays the accessible name, so the dot is hidden
 * from assistive technology. Renders nothing for "none".
 */
import type { QuickPromptColor } from "./contract.js";
import { quickPromptColorVar } from "@/quick-prompts/model.js";

export function QuickPromptColorDot({ color }: { color: QuickPromptColor | null | undefined }) {
  const background = quickPromptColorVar(color);
  if (!background) return null;
  return (
    <span
      aria-hidden
      data-testid="quick-prompt-color-dot"
      data-color={color}
      className="size-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: background }}
    />
  );
}
